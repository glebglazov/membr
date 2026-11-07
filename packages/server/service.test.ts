import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LABEL, plistXml, removeService, serviceLabel, serviceSpec, startService, type ServiceHost } from "./src/service.ts";

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
      if (verb === "kickstart") return state.loaded ? { status: 0, output: "" } : { status: 113, output: "Could not find service" };
      return { status: 1, output: "unknown" };
    },
  };
  return { host, calls, state };
}

test("plist for a source run names bun, main.ts and server run, with no options", () => {
  const spec = serviceSpec({
    dir: "/data",
    env: { PATH: "/opt/bin:/usr/bin", MEMBR_CLAUDE_CLI: "/opt/bin/claude", MEMBR_DIR: "/data", HOME: "/h" },
    execPath: "/opt/bun",
    entry: "/repo/packages/server/src/main.ts",
  });
  expect(plistXml(spec)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel("/data")}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/bun</string>
    <string>/repo/packages/server/src/main.ts</string>
    <string>server</string>
    <string>run</string>
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
  const spec = serviceSpec({ dir: "/data", env: { PATH: "/usr/bin" }, execPath: "/usr/local/bin/membr", entry: null });
  expect(spec.program).toEqual(["/usr/local/bin/membr", "server", "run"]);
  expect(spec.env).toEqual({ PATH: "/usr/bin" });
});

test("plist escapes XML characters in every value", () => {
  const spec = serviceSpec({ dir: "/d&<a>", env: { PATH: `/a"b'c&d` }, execPath: "/x", entry: null });
  const xml = plistXml(spec);
  expect(xml).toContain("<string>/a&quot;b&apos;c&amp;d</string>");
  expect(xml).toContain("<string>/d&amp;&lt;a&gt;/serve.log</string>");
  expect(xml).not.toContain("/d&<a>");
});

test("the default data directory keeps the label dev.membr.serve, and another one gets its own", () => {
  expect(serviceLabel(path.join(os.homedir(), ".local", "share", "membr"))).toBe(LABEL);
  expect(serviceLabel("/data")).toMatch(/^dev\.membr\.serve\.[0-9a-f]{8}$/);
  expect(serviceLabel("/data")).not.toBe(serviceLabel("/other"));
});

function spec(dir: string, env: Record<string, string> = { PATH: "/usr/bin" }) {
  return serviceSpec({ dir, env, execPath: "/usr/local/bin/membr", entry: null });
}

test("a first start writes the plist and bootstraps it into the user's domain", () => {
  const dir = temp();
  const { host, calls, state } = fakeHost(path.join(dir, "LaunchAgents"));
  const target = `gui/501/${serviceLabel(dir)}`, file = path.join(dir, "LaunchAgents", serviceLabel(dir) + ".plist");
  startService(spec(dir), host);
  expect(calls).toEqual([`print ${target}`, `print ${target}`, `bootstrap gui/501 ${file}`]);
  expect(state.loaded).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(plistXml(spec(dir)));
});

test("an unchanged loaded plist is kickstarted, not replaced", () => {
  const dir = temp();
  const { host, calls } = fakeHost(path.join(dir, "LaunchAgents"));
  startService(spec(dir), host);
  calls.length = 0;
  startService(spec(dir), host);
  expect(calls).toEqual([`print gui/501/${serviceLabel(dir)}`, `kickstart gui/501/${serviceLabel(dir)}`]);
});

test("a changed plist, such as a new PATH, replaces the loaded agent", () => {
  const dir = temp();
  const { host, calls, state } = fakeHost(path.join(dir, "LaunchAgents"));
  const target = `gui/501/${serviceLabel(dir)}`, file = path.join(dir, "LaunchAgents", serviceLabel(dir) + ".plist");
  startService(spec(dir), host);
  calls.length = 0;
  startService(spec(dir, { PATH: "/opt/bin:/usr/bin" }), host);
  expect(calls).toEqual([`print ${target}`, `bootout ${target}`, `print ${target}`, `print ${target}`, `bootstrap gui/501 ${file}`]);
  expect(state.loaded).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toContain("<string>/opt/bin:/usr/bin</string>");
});

test("remove boots the agent out and deletes the plist, and does nothing when there is none", () => {
  const dir = temp();
  const { host, calls, state } = fakeHost(path.join(dir, "LaunchAgents"));
  expect(removeService(host, serviceLabel(dir))).toBe(false);
  startService(spec(dir), host);
  expect(removeService(host, serviceLabel(dir))).toBe(true);
  expect(state.loaded).toBe(false);
  expect(fs.existsSync(path.join(dir, "LaunchAgents", serviceLabel(dir) + ".plist"))).toBe(false);
  expect(calls).toContain(`bootout gui/501/${serviceLabel(dir)}`);
});

test("a replaced agent waits for the old server to stop before it loads the new one", () => {
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
  startService(spec(dir), host);
  expect(calls.filter((call) => call.startsWith("print")).length).toBe(5);
  expect(calls.at(-1)).toStartWith("bootstrap");
});
