import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.ts";

declare const MEMBR_STANDALONE: boolean | undefined;

export const LABEL = "dev.membr.serve";

// One launchd agent per data directory, so a second MEMBR_DIR gets its own server instead of replacing the first one's.
export function serviceLabel(dir: string): string {
  if (path.resolve(dir) === path.resolve(dataDir({}))) return LABEL;
  return `${LABEL}.${createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8)}`;
}

// What launchd needs to start the server, as data. plistXml renders it and nothing else decides its shape.
export type ServiceSpec = Readonly<{
  label: string;
  program: readonly string[];
  env: Readonly<Record<string, string>>;
  logPath: string;
  workingDirectory: string;
}>;

type Plist = string | boolean | readonly Plist[] | { readonly [key: string]: Plist };

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function render(value: Plist, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>\n`;
  if (typeof value === "boolean") return `${indent}<${value}/>\n`;
  if (Array.isArray(value)) return `${indent}<array>\n${value.map((item) => render(item, indent + "  ")).join("")}${indent}</array>\n`;
  const entries = Object.entries(value as { readonly [key: string]: Plist });
  return `${indent}<dict>\n${entries.map(([key, item]) => `${indent}  <key>${escapeXml(key)}</key>\n${render(item, indent + "  ")}`).join("")}${indent}</dict>\n`;
}

// KeepAlive restarts the server only after an exit that is not a clean exit 0. A crash, a kill and a held
// lock (exit 1) restart it, so it waits for `make run` to let go of the data directory and for Tailscale to
// come up after login. A SIGTERM from `launchctl bootout` exits 0, so uninstall and install stay stopped.
export function plistXml(spec: ServiceSpec): string {
  const plist: Plist = {
    Label: spec.label,
    ProgramArguments: spec.program,
    EnvironmentVariables: spec.env,
    WorkingDirectory: spec.workingDirectory,
    StandardOutPath: spec.logPath,
    StandardErrorPath: spec.logPath,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${render(plist, "")}</plist>\n`;
}

// entry is the path of main.ts when running from source, and null when running as the compiled binary.
export function serviceSpec(input: Readonly<{
  dir: string;
  env: Readonly<Record<string, string | undefined>>;
  execPath: string;
  entry: string | null;
}>): ServiceSpec {
  const env: Record<string, string> = {};
  // launchd starts with a minimal PATH, and the server runs claude and tailscale from it.
  for (const key of ["PATH", "MEMBR_CLAUDE_CLI", "MEMBR_DIR"]) {
    const value = input.env[key];
    if (value) env[key] = value;
  }
  return {
    label: serviceLabel(input.dir),
    program: [input.execPath, ...(input.entry === null ? [] : [input.entry]), "serve"],
    env,
    logPath: path.join(input.dir, "serve.log"),
    workingDirectory: input.dir,
  };
}

// The spec of the membr that runs now, so the agent follows a rebuilt binary or a moved checkout.
export function currentSpec(dir: string, env: Readonly<Record<string, string | undefined>>): ServiceSpec {
  return serviceSpec({ dir, env, execPath: process.execPath, entry: typeof MEMBR_STANDALONE === "undefined" ? path.join(import.meta.dir, "main.ts") : null });
}

export type Launchctl = (args: string[]) => { status: number; output: string };
export type ServiceHost = Readonly<{ launchctl: Launchctl; agentsDir: string; uid: number }>;

export function realHost(): ServiceHost {
  return {
    uid: process.getuid!(),
    agentsDir: path.join(process.env.HOME ?? "", "Library/LaunchAgents"),
    launchctl: (args) => {
      const proc = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
      return { status: proc.exitCode ?? 1, output: (proc.stdout.toString() + proc.stderr.toString()).trim() };
    },
  };
}

const domain = (host: ServiceHost) => `gui/${host.uid}`;
const target = (host: ServiceHost, label: string) => `${domain(host)}/${label}`;
export const plistPath = (host: ServiceHost, label: string) => path.join(host.agentsDir, `${label}.plist`);

export type ServiceStatus = Readonly<{ installed: boolean; loaded: boolean; plistPath: string }>;

export function serviceStatus(host: ServiceHost, label: string): ServiceStatus {
  return { installed: fs.existsSync(plistPath(host, label)), loaded: host.launchctl(["print", target(host, label)]).status === 0, plistPath: plistPath(host, label) };
}

function launchctl(host: ServiceHost, args: string[]): void {
  const out = host.launchctl(args);
  if (out.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${out.output}`);
}

function unload(host: ServiceHost, label: string): void {
  if (!serviceStatus(host, label).loaded) return;
  launchctl(host, ["bootout", target(host, label)]);
  // bootout returns before the old server exits, and a bootstrap of the same label fails until it has.
  for (let waited = 0; serviceStatus(host, label).loaded; waited += 200) {
    if (waited >= 10_000) throw new Error("The old membr server did not stop within 10 seconds.");
    Bun.sleepSync(200);
  }
}

// Converges on "this plist is loaded and its server runs". A changed plist replaces the loaded agent; an unchanged
// one that launchd holds back (after a crash it waits 10 seconds) starts at once.
export function startService(spec: ServiceSpec, host: ServiceHost): void {
  const file = plistPath(host, spec.label);
  const xml = plistXml(spec);
  const changed = !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== xml;
  if (changed) {
    fs.mkdirSync(host.agentsDir, { recursive: true });
    fs.writeFileSync(file, xml);
    unload(host, spec.label);
  }
  if (serviceStatus(host, spec.label).loaded) launchctl(host, ["kickstart", target(host, spec.label)]);
  else launchctl(host, ["bootstrap", domain(host), file]);
}

// Without the plist, launchd does not start the server at the next login either, so it stays stopped until membr runs.
export function removeService(host: ServiceHost, label: string): boolean {
  const installed = serviceStatus(host, label).installed;
  unload(host, label);
  fs.rmSync(plistPath(host, label), { force: true });
  return installed;
}
