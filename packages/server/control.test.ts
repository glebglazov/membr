import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentList, agentNew, ensureServer, reloadServer, serverStatus, stopServer } from "./src/control.ts";
import { holder } from "./src/lock.ts";
import { serviceLabel, serviceSpec, type ServiceHost } from "./src/service.ts";

const dirs: string[] = [];
const servers: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const proc of servers.splice(0)) { proc.kill("SIGKILL"); await proc.exited; }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function directory(config: Record<string, unknown> | string = { port: 0 }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "membr-control-")));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

// The plist runs the test server, which has a fake Engine.
const specFor = (dir: string) => serviceSpec({ dir, env: { MEMBR_DIR: dir, PATH: process.env.PATH ?? "" }, execPath: process.execPath, entry: path.join(import.meta.dir, "test/serve.ts") });

function spawnServer(dir: string) {
  const log = fs.openSync(path.join(dir, "serve.log"), "a");
  const proc = Bun.spawn([...specFor(dir).program], { env: { ...process.env, MEMBR_DIR: dir }, stdout: log, stderr: log });
  servers.push(proc);
  return proc;
}

// A launchd that runs the agent's server as a child: bootstrap and kickstart start it, bootout stops it.
function fakeLaunchd(dir: string, starts = true) {
  const calls: string[] = [];
  let loaded = false, server: Bun.Subprocess | null = null;
  const host: ServiceHost = { uid: 501, agentsDir: path.join(dir, "LaunchAgents"), launchctl: (args) => {
    calls.push(args[0]);
    if (args[0] === "print") return loaded ? { status: 0, output: "" } : { status: 113, output: "Could not find service" };
    if (args[0] === "bootstrap" || args[0] === "kickstart") {
      loaded = true;
      if (starts && (server === null || server.exitCode !== null)) server = spawnServer(dir);
      return { status: 0, output: "" };
    }
    if (args[0] === "bootout") {
      loaded = false;
      server?.kill("SIGTERM");
      return { status: 0, output: "" };
    }
    return { status: 1, output: "unknown" };
  } };
  return { host, calls, loaded: () => loaded };
}

test("membr with no server starts one through launchd, and a second membr uses the running one", async () => {
  const dir = directory();
  const launchd = fakeLaunchd(dir);
  const first = await ensureServer({ dir, host: launchd.host, spec: specFor(dir) });
  expect((await fetch(first.url)).ok).toBe(true);
  expect(fs.existsSync(path.join(dir, "LaunchAgents", serviceLabel(dir) + ".plist"))).toBe(true);
  const calls = launchd.calls.length;
  expect(await ensureServer({ dir, host: launchd.host, spec: specFor(dir) })).toEqual(first);
  expect(launchd.calls.length).toBe(calls);
});

test("membr uses a server that it did not start, such as make run, and leaves launchd alone", async () => {
  const dir = directory();
  spawnServer(dir);
  const launchd = fakeLaunchd(dir);
  for (let i = 0; i < 100 && !holder(dir)?.url; i++) await Bun.sleep(50);
  expect((await ensureServer({ dir, host: launchd.host, spec: specFor(dir) })).url).toBe(holder(dir)!.url);
  expect(launchd.calls).toEqual([]);
});

test("a config error stops membr before it writes or loads an agent", async () => {
  const dir = directory({ port: "8788" });
  const launchd = fakeLaunchd(dir);
  await expect(ensureServer({ dir, host: launchd.host, spec: specFor(dir) })).rejects.toThrow("config.json: port must be a whole number");
  expect(launchd.calls).toEqual([]);
  expect(fs.existsSync(path.join(dir, "LaunchAgents"))).toBe(false);
});

test("a server that does not start in time gives the end of serve.log", async () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, "serve.log"), "membr: tailscale serve failed: Serve is not enabled on your tailnet.\n");
  const launchd = fakeLaunchd(dir, false);
  await expect(ensureServer({ dir, host: launchd.host, spec: specFor(dir), timeout: 300 })).rejects.toThrow(/did not start within 0.3 seconds[\s\S]*Serve is not enabled on your tailnet\./);
});

test("membr reload reloads the config, reports a move to a new port, and fails with the reason on a bad file", async () => {
  const dir = directory();
  expect(await reloadServer(dir)).toEqual(["membr: no server runs. The next start reads config.json."]);
  const launchd = fakeLaunchd(dir);
  const before = await ensureServer({ dir, host: launchd.host, spec: specFor(dir) });
  expect(await reloadServer(dir)).toEqual(["membr: config reloaded"]);

  const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = free.port!;
  free.stop(true);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port }));
  expect(await reloadServer(dir)).toEqual(["membr: config reloaded", `membr: the server now listens at http://127.0.0.1:${port}/`]);
  expect(holder(dir)!.url).toBe(`http://127.0.0.1:${port}/`);
  expect(holder(dir)!.pid).toBe(before.pid);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port, tailscale: "yes" }));
  await expect(reloadServer(dir)).rejects.toThrow("The config was not reloaded: config.json: tailscale must be true or false");
});

test("membr status shows the server, its sign-in link, the agent and the log", async () => {
  const dir = directory();
  const launchd = fakeLaunchd(dir);
  expect(serverStatus(dir, launchd.host)[0]).toBe(`membr: no server runs for ${dir}`);
  const running = await ensureServer({ dir, host: launchd.host, spec: specFor(dir) });
  const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
  expect(serverStatus(dir, launchd.host)).toEqual([
    `membr: the server runs (pid ${running.pid}) at ${running.url}`,
    `membr: sign in at ${running.url}membr/?token=${encodeURIComponent(token)}`,
    `membr: agent default at ${running.url}membr/default/`,
    `membr: launchd agent ${serviceLabel(dir)} loaded, plist ${path.join(dir, "LaunchAgents", serviceLabel(dir) + ".plist")}`,
    `membr: log ${path.join(dir, "serve.log")}`,
  ]);
});

test("membr stop stops the server and removes the agent, so nothing starts it until the next membr", async () => {
  const dir = directory();
  const launchd = fakeLaunchd(dir);
  await ensureServer({ dir, host: launchd.host, spec: specFor(dir) });
  expect(await stopServer(dir, launchd.host)).toEqual(["membr: the server stopped"]);
  expect(holder(dir)).toBe(null);
  expect(launchd.loaded()).toBe(false);
  expect(fs.existsSync(path.join(dir, "LaunchAgents", serviceLabel(dir) + ".plist"))).toBe(false);
  expect(await stopServer(dir, launchd.host)).toEqual(["membr: no server runs"]);
});

test("membr stop also stops a server that launchd did not start", async () => {
  const dir = directory();
  const proc = spawnServer(dir);
  for (let i = 0; i < 100 && !holder(dir)?.url; i++) await Bun.sleep(50);
  expect(await stopServer(dir, null)).toEqual(["membr: the server stopped"]);
  expect(await proc.exited).toBe(0);
});

test("membr agent new adds an entry to config.json, and membr agent list shows each agent and its state", async () => {
  const dir = directory();
  const launchd = fakeLaunchd(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 0 }));
  const added = await agentNew(dir, "research");
  expect(added[0]).toBe(`membr: added the agent research to ${path.join(dir, "config.json")}`);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))).toEqual({ port: 0, agents: { research: { prompt: "" } } });
  await expect(agentNew(dir, "research")).rejects.toThrow("the agent research is in config.json already");
  await expect(agentNew(dir, "server")).rejects.toThrow("server is a membr command");
  expect((await agentList(dir)).map((line) => line.split("  ").slice(0, 2).join(" "))).toEqual(["default stopped", "research stopped"]);
  await ensureServer({ dir, host: launchd.host, spec: specFor(dir) });
  expect((await agentList(dir)).map((line) => line.split("  ").slice(0, 2).join(" "))).toEqual(["default idle", "research idle"]);
});
