import fs from "node:fs";
import path from "node:path";
import { readConfig } from "./config.ts";
import { serveArgs, type ServeOptions } from "./serve-options.ts";

declare const MEMBR_STANDALONE: boolean | undefined;

export const LABEL = "dev.membr.serve";

export const SERVICE_USAGE = `usage: membr service install [--port N] [--host ADDRESS | --tailscale] [--home PATH]
       membr service uninstall
       membr service status
       membr service reload`;

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
  options: ServeOptions;
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
    label: LABEL,
    program: [input.execPath, ...(input.entry === null ? [] : [input.entry]), "serve", ...serveArgs(input.options)],
    env,
    logPath: path.join(input.dir, "serve.log"),
    workingDirectory: input.dir,
  };
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
const target = (host: ServiceHost) => `${domain(host)}/${LABEL}`;
const plistPath = (host: ServiceHost) => path.join(host.agentsDir, `${LABEL}.plist`);

export type ServiceStatus = Readonly<{ installed: boolean; loaded: boolean; pid: number | null; plistPath: string }>;

export function serviceStatus(host: ServiceHost): ServiceStatus {
  const printed = host.launchctl(["print", target(host)]);
  const pid = printed.status === 0 ? printed.output.match(/^\s*pid = (\d+)$/m)?.[1] : undefined;
  return { installed: fs.existsSync(plistPath(host)), loaded: printed.status === 0, pid: pid === undefined ? null : Number(pid), plistPath: plistPath(host) };
}

function unload(host: ServiceHost): void {
  if (!serviceStatus(host).loaded) return;
  const out = host.launchctl(["bootout", target(host)]);
  if (out.status !== 0) throw new Error(`launchctl bootout failed: ${out.output}`);
  // bootout returns before the old server exits, and a bootstrap of the same label fails until it has.
  for (let waited = 0; serviceStatus(host).loaded; waited += 200) {
    if (waited >= 10_000) throw new Error("The old membr service did not stop within 10 seconds.");
    Bun.sleepSync(200);
  }
}

// Converges on "this plist is loaded": a second install replaces the loaded agent.
export function installService(spec: ServiceSpec, host: ServiceHost): string {
  fs.mkdirSync(host.agentsDir, { recursive: true });
  const file = plistPath(host);
  fs.writeFileSync(file, plistXml(spec));
  unload(host);
  const out = host.launchctl(["bootstrap", domain(host), file]);
  if (out.status !== 0) throw new Error(`launchctl bootstrap failed: ${out.output}`);
  return file;
}

export function uninstallService(host: ServiceHost): void {
  unload(host);
  fs.rmSync(plistPath(host), { force: true });
}

export function reloadService(host: ServiceHost): void {
  const out = host.launchctl(["kill", "HUP", target(host)]);
  if (out.status !== 0) throw new Error(`launchctl kill failed (is the service installed?): ${out.output}`);
}

// Returns the exit status. Errors from launchctl or config throw to the caller.
export function runService(action: string | undefined, options: ServeOptions, ctx: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  dir: string;
  host: ServiceHost;
  log: (line: string) => void;
}>): number {
  const { host, log } = ctx;
  if (action === "install") {
    const config = readConfig(ctx.dir, ctx.env, options.home);
    // A relative --home would resolve against the installer's directory now and the data directory at login.
    const home = options.home === undefined ? undefined : config.home ?? undefined;
    fs.mkdirSync(ctx.dir, { recursive: true });
    const spec = serviceSpec({
      dir: ctx.dir,
      options: { ...options, home },
      env: ctx.env,
      execPath: process.execPath,
      entry: typeof MEMBR_STANDALONE === "undefined" ? path.join(import.meta.dir, "main.ts") : null,
    });
    log(`membr: installed ${installService(spec, host)}`);
    log(`membr: the server starts at login and after a crash. Its log is ${spec.logPath}`);
    log(`membr: sign in with the "sign in at" line in that log`);
    return 0;
  }
  if (action === "uninstall") {
    uninstallService(host);
    log("membr: service removed");
    return 0;
  }
  if (action === "status") {
    const status = serviceStatus(host);
    log(`membr: service ${status.loaded ? "loaded" : "not loaded"}${status.pid === null ? "" : ` (pid ${status.pid})`}`);
    log(`membr: plist ${status.plistPath}${status.installed ? "" : " (not installed)"}`);
    log(`membr: log ${path.join(ctx.dir, "serve.log")}`);
    return 0;
  }
  if (action === "reload") {
    reloadService(host);
    log("membr: sent SIGHUP to the service");
    return 0;
  }
  console.error(SERVICE_USAGE);
  return 2;
}
