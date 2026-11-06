import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LABEL, plistXml, runService, serviceSpec, type ServiceHost } from "./src/service.ts";
import { parseServeOptions } from "./src/serve-options.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-service-"));
  dirs.push(dir);
  return dir;
}

// A launchctl that keeps the one fact the commands act on: whether the agent is loaded.
function fakeHost(agentsDir: string, loaded = false) {
  const calls: string[] = [];
  const state = { loaded };
  const host: ServiceHost = {
    uid: 501,
    agentsDir,
    launchctl: (args) => {
      calls.push(args.join(" "));
      const [verb] = args;
      if (verb === "print") return state.loaded ? { status: 0, output: "service = {\n\tpid = 4242\n}" } : { status: 113, output: "Could not find service" };
      if (verb === "bootout" || verb === "kill") {
        if (!state.loaded) return { status: 3, output: "No such process" };
        if (verb === "bootout") state.loaded = false;
        return { status: 0, output: "" };
      }
      if (verb === "bootstrap") { state.loaded = true; return { status: 0, output: "" }; }
      return { status: 1, output: "unknown" };
    },
  };
  return { host, calls, state };
}

function run(action: string, host: ServiceHost, dir: string, options = parseServeOptions({}), env: Record<string, string> = { MEMBR_DIR: dir }) {
  const lines: string[] = [];
  const status = runService(action, options, { env, dir, host, log: (line) => lines.push(line) });
  return { status, lines };
}

const TARGET = `gui/501/${LABEL}`;

test("plist for a source run names bun, main.ts and the serve options", () => {
  const spec = serviceSpec({
    dir: "/data",
    options: parseServeOptions({ tailscale: true, port: "9000", home: "/vault" }),
    env: { PATH: "/opt/bin:/usr/bin", MEMBR_CLAUDE_CLI: "/opt/bin/claude", MEMBR_DIR: "/data", HOME: "/h" },
    execPath: "/opt/bun",
    entry: "/repo/packages/server/src/main.ts",
  });
  expect(plistXml(spec)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.membr.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/bun</string>
    <string>/repo/packages/server/src/main.ts</string>
    <string>serve</string>
    <string>--port</string>
    <string>9000</string>
    <string>--tailscale</string>
    <string>--home</string>
    <string>/vault</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/bin:/usr/bin</string>
    <key>MEMBR_CLAUDE_CLI</key>
    <string>/opt/bin/claude</string>
    <key>MEMBR_DIR</key>
    <string>/data</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/data</string>
  <key>StandardOutPath</key>
  <string>/data/serve.log</string>
  <key>StandardErrorPath</key>
  <string>/data/serve.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`);
});

test("plist for the compiled binary runs the binary itself", () => {
  const spec = serviceSpec({ dir: "/data", options: parseServeOptions({ host: "0.0.0.0" }), env: { PATH: "/usr/bin" }, execPath: "/usr/local/bin/membr", entry: null });
  expect(spec.program).toEqual(["/usr/local/bin/membr", "serve", "--host", "0.0.0.0"]);
  expect(spec.env).toEqual({ PATH: "/usr/bin" });
});

test("plist escapes XML characters in every value", () => {
  const spec = serviceSpec({ dir: "/d&<a>", options: parseServeOptions({}), env: { PATH: `/a"b'c&d` }, execPath: "/x", entry: null });
  const xml = plistXml(spec);
  expect(xml).toContain("<string>/a&quot;b&apos;c&amp;d</string>");
  expect(xml).toContain("<string>/d&amp;&lt;a&gt;/serve.log</string>");
  expect(xml).not.toContain("/d&<a>");
});

test("serve options are checked by the rules of serve", () => {
  expect(() => parseServeOptions({ port: "abc" })).toThrow('--port must be a port number, not "abc"');
  expect(() => parseServeOptions({ port: "70000" })).toThrow("--port must be a port number");
  expect(() => parseServeOptions({ tailscale: true, host: "0.0.0.0" })).toThrow("takes no --host");
  expect(parseServeOptions({ port: "0" }).port).toBe(0);
});

test("install writes the plist, then bootstraps it into the user's domain", () => {
  const dir = temp();
  const { host, calls, state } = fakeHost(path.join(dir, "LaunchAgents"));
  const { status, lines } = run("install", host, dir, parseServeOptions({ tailscale: true }));
  expect(status).toBe(0);
  expect(calls).toEqual([`print ${TARGET}`, `bootstrap gui/501 ${path.join(dir, "LaunchAgents", LABEL + ".plist")}`]);
  expect(state.loaded).toBe(true);
  const xml = fs.readFileSync(path.join(dir, "LaunchAgents", LABEL + ".plist"), "utf8");
  expect(xml).toContain("<string>--tailscale</string>");
  expect(xml).toContain(`<string>${dir}/serve.log</string>`);
  expect(lines.join("\n")).toContain(path.join(dir, "serve.log"));
});

test("a second install replaces the loaded agent", () => {
  const dir = temp();
  const { host, calls, state } = fakeHost(path.join(dir, "LaunchAgents"));
  run("install", host, dir);
  calls.length = 0;
  run("install", host, dir, parseServeOptions({ port: "9001" }));
  const file = path.join(dir, "LaunchAgents", LABEL + ".plist");
  expect(calls).toEqual([`print ${TARGET}`, `bootout ${TARGET}`, `print ${TARGET}`, `bootstrap gui/501 ${file}`]);
  expect(state.loaded).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toContain("<string>9001</string>");
});

test("install resolves a relative --home against the installer's directory", () => {
  const dir = temp();
  const { host } = fakeHost(path.join(dir, "LaunchAgents"));
  fs.mkdirSync(path.join(process.cwd(), "node_modules/.service-test-home"), { recursive: true });
  try {
    run("install", host, dir, parseServeOptions({ home: "node_modules/.service-test-home" }));
    expect(fs.readFileSync(path.join(dir, "LaunchAgents", LABEL + ".plist"), "utf8")).toContain(`<string>${path.join(process.cwd(), "node_modules/.service-test-home")}</string>`);
  } finally {
    fs.rmSync(path.join(process.cwd(), "node_modules/.service-test-home"), { recursive: true });
  }
});

test("install refuses a home that is not a directory and leaves launchd alone", () => {
  const dir = temp();
  const { host, calls } = fakeHost(path.join(dir, "LaunchAgents"));
  expect(() => run("install", host, dir, parseServeOptions({ home: path.join(dir, "missing") }))).toThrow("is not a directory");
  expect(calls).toEqual([]);
  expect(fs.existsSync(path.join(dir, "LaunchAgents"))).toBe(false);
});

test("uninstall boots the agent out and deletes the plist", () => {
  const dir = temp();
  const { host, calls, state } = fakeHost(path.join(dir, "LaunchAgents"));
  run("install", host, dir);
  calls.length = 0;
  expect(run("uninstall", host, dir).status).toBe(0);
  expect(calls).toEqual([`print ${TARGET}`, `bootout ${TARGET}`, `print ${TARGET}`]);
  expect(state.loaded).toBe(false);
  expect(fs.existsSync(path.join(dir, "LaunchAgents", LABEL + ".plist"))).toBe(false);
});

test("uninstall with nothing installed succeeds and does not call bootout", () => {
  const dir = temp();
  const { host, calls } = fakeHost(path.join(dir, "LaunchAgents"));
  expect(run("uninstall", host, dir).status).toBe(0);
  expect(calls).toEqual([`print ${TARGET}`]);
});

test("status reports loaded, pid and paths, and not loaded when absent", () => {
  const dir = temp();
  const { host } = fakeHost(path.join(dir, "LaunchAgents"));
  const absent = run("status", host, dir).lines.join("\n");
  expect(absent).toContain("not loaded");
  expect(absent).toContain("(not installed)");
  run("install", host, dir);
  const present = run("status", host, dir).lines.join("\n");
  expect(present).toContain("service loaded (pid 4242)");
  expect(present).toContain(path.join(dir, "LaunchAgents", LABEL + ".plist"));
  expect(present).toContain(path.join(dir, "serve.log"));
});

test("reload sends SIGHUP to the agent, and fails when it is not loaded", () => {
  const dir = temp();
  const { host, calls } = fakeHost(path.join(dir, "LaunchAgents"));
  expect(() => run("reload", host, dir)).toThrow("is the service installed");
  run("install", host, dir);
  calls.length = 0;
  expect(run("reload", host, dir).status).toBe(0);
  expect(calls).toEqual([`kill HUP ${TARGET}`]);
});

test("an unknown action prints usage and exits 2", () => {
  const dir = temp();
  const { host, calls } = fakeHost(path.join(dir, "LaunchAgents"));
  expect(run("frobnicate", host, dir).status).toBe(2);
  expect(calls).toEqual([]);
});

test("a second install waits for the old server to stop before it loads the new agent", () => {
  const dir = temp();
  let stopping = 0, loaded = true;
  const calls: string[] = [];
  const host: ServiceHost = { uid: 501, agentsDir: path.join(dir, "LaunchAgents"), launchctl: (args) => {
    calls.push(args.join(" "));
    if (args[0] === "print") return loaded || stopping-- > 0 ? { status: 0, output: "pid = 1" } : { status: 113, output: "" };
    if (args[0] === "bootout") { loaded = false; stopping = 2; return { status: 0, output: "" }; }
    if (args[0] === "bootstrap") return stopping > 0 ? { status: 5, output: "Input/output error" } : { status: 0, output: "" };
    return { status: 0, output: "" };
  } };
  expect(run("install", host, dir).status).toBe(0);
  expect(calls.filter((call) => call.startsWith("print")).length).toBe(4);
  expect(calls.at(-1)).toStartWith("bootstrap");
});
