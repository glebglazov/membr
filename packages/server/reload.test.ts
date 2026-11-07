import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { readConfig, storeDir } from "./src/config.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { defaultStore } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [], dirs: string[] = [], running: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const proc of running.splice(0)) { proc.kill("SIGKILL"); await proc.exited; }
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function directory() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "membr-reload-")));
  dirs.push(dir);
  return dir;
}
const agentOf = (dir: string, name = "default") => readConfig(dir).agents.get(name)!;
// A config with only the default agent set: its keys go under agents.default, the rest stay at the top.
function writeDefault(dir: string, agent: Record<string, unknown>, top: Record<string, unknown> = {}) { writeConfig(dir, { ...top, agents: { default: agent } }); }
function writeConfig(dir: string, config: Record<string, unknown> | string) {
  fs.writeFileSync(path.join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}
async function serve(dir: string, engine = new FakeEngine()) {
  const hub = serveHub({ dir, port: 0, engine }); hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token }); clients.push(client);
  await client.wait("ready");
  return { hub, client, engine };
}
async function reload(client: TestClient, id: string = crypto.randomUUID()) {
  const mark = client.events.length;
  client.act({ type: "act", act: "reload", id });
  return client.wait("answer", mark, (event) => event.id === id);
}
const notes = (client: TestClient): Entry[] => client.events.flatMap((event) => event.type === "entry" && event.entry.text.startsWith("Config reloaded") ? [event.entry] : []);

test("home comes from the file, relative to the data directory, or is the agent's own directory", () => {
  const dir = directory();
  fs.mkdirSync(path.join(dir, "vault"));
  expect(agentOf(dir).home).toBe(path.join(dir, "agents", "default", "home"));
  writeDefault(dir, { home: "vault" });
  expect(agentOf(dir).home).toBe(path.join(dir, "vault"));
  writeDefault(dir, { home: "~/" });
  expect(agentOf(dir).home).toBe(os.homedir());
});

test("an agent is read with its name, a prompt string or list of lines, and its own home under agents/<name>", () => {
  const dir = directory();
  expect([...readConfig(dir).agents.keys()]).toEqual(["default"]);
  writeConfig(dir, { agents: { research: { prompt: ["You research.", "", "Cite sources."] }, notes: { prompt: "Take notes." } } });
  const config = readConfig(dir);
  expect([...config.agents.keys()]).toEqual(["default", "research", "notes"]);
  expect(config.agents.get("research")).toEqual({ name: "research", home: path.join(dir, "agents", "research", "home"), prompt: "You research.\n\nCite sources.", approvalTimeout: 600_000 });
  expect(config.agents.get("notes")!.prompt).toBe("Take notes.");
  expect(config.agents.get("default")!.prompt).toBe("");
});

test("a reserved or malformed agent name is refused", () => {
  const dir = directory();
  for (const name of ["server", "agent", "help"]) {
    writeConfig(dir, { agents: { [name]: {} } });
    expect(() => readConfig(dir)).toThrow(`config.json: agents: ${name} is a membr command, so it cannot be an agent name`);
  }
  for (const name of ["1st", "a b", "a/b", ""]) {
    writeConfig(dir, { agents: { [name]: {} } });
    expect(() => readConfig(dir)).toThrow("must start with a letter");
  }
});

test("an unknown key of an agent and a bad prompt are refused, naming the key", () => {
  const dir = directory();
  writeConfig(dir, { agents: { research: { rules: "x" } } });
  expect(() => readConfig(dir)).toThrow("config.json: agents.research.rules is not a key of an agent");
  for (const prompt of [3, [1], null]) {
    writeConfig(dir, { agents: { research: { prompt } } });
    expect(() => readConfig(dir)).toThrow("config.json: agents.research.prompt must be a string or a list of strings");
  }
  writeConfig(dir, { agents: [] });
  expect(() => readConfig(dir)).toThrow("config.json: agents must be an object");
});

test("a top-level home, rules or after is refused, and says where it went", () => {
  const dir = directory();
  writeConfig(dir, { home: "vault" });
  expect(() => readConfig(dir)).toThrow("config.json: home is now a key of each agent: move it to agents.default.home");
  writeConfig(dir, { rules: "rules.md" });
  expect(() => readConfig(dir)).toThrow("config.json: rules was removed: put the text of the rules file in agents.default.prompt");
  writeConfig(dir, { after: "git commit" });
  expect(() => readConfig(dir)).toThrow("config.json: after was removed");
});

test("port, host and tailscale default to 8788 on loopback, off the tailnet", () => {
  const dir = directory();
  expect(readConfig(dir).listen).toEqual({ port: 8788, host: "127.0.0.1", tailscale: false });
  writeConfig(dir, { port: 9000, tailscale: true });
  expect(readConfig(dir).listen).toEqual({ port: 9000, host: "127.0.0.1", tailscale: true });
  writeConfig(dir, { host: "0.0.0.0" });
  expect(readConfig(dir).listen).toEqual({ port: 8788, host: "0.0.0.0", tailscale: false });
});

test("a bad port, host or tailscale is refused, naming the key", () => {
  const dir = directory();
  for (const [config, reason] of [
    [{ port: "8788" }, "port must be a whole number from 0 to 65535"],
    [{ port: 70000 }, "port must be a whole number from 0 to 65535"],
    [{ port: 1.5 }, "port must be a whole number from 0 to 65535"],
    [{ host: "" }, "host must be an address"],
    [{ tailscale: "yes" }, "tailscale must be true or false"],
    [{ tailscale: true, host: "0.0.0.0" }, "tailscale serves on 127.0.0.1"],
  ] as const) {
    writeConfig(dir, config);
    expect(() => readConfig(dir)).toThrow(`config.json: ${reason}`);
  }
});

test("approvalTimeout reads seconds, minutes and hours from the file, and defaults to ten minutes", () => {
  const dir = directory();
  expect(agentOf(dir).approvalTimeout).toBe(600_000);
  for (const [text, ms] of [["90s", 90_000], ["10m", 600_000], ["2h", 7_200_000], ["24h", 86_400_000]] as const) {
    writeDefault(dir, { approvalTimeout: text });
    expect(agentOf(dir).approvalTimeout).toBe(ms);
  }
});

test("approvalTimeout refuses a bad format, zero and more than 24h, naming the key", () => {
  const dir = directory();
  for (const [value, reason] of [["10 min", "must be a number and a unit"], ["10", "must be a number and a unit"], [600, "must be a number and a unit"], ["1.5h", "must be a number and a unit"], ["0m", "must be more than 0"], ["25h", "must be 24h or less"], ["1441m", "must be 24h or less"]] as const) {
    writeDefault(dir, { approvalTimeout: value });
    expect(() => readConfig(dir)).toThrow(`config.json: agents.default.approvalTimeout ${reason}`);
  }
});

test("a home that is not a directory is refused", () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, "file"), "");
  writeDefault(dir, { home: "missing" });
  expect(() => readConfig(dir)).toThrow(`config.json: agents.default.home: ${path.join(dir, "missing")} is not a directory`);
  writeDefault(dir, { home: "file" });
  expect(() => readConfig(dir)).toThrow(`config.json: agents.default.home: ${path.join(dir, "file")} is not a directory`);
  writeDefault(dir, { home: 3 });
  expect(() => readConfig(dir)).toThrow("config.json: agents.default.home must be a path");
});

test("a new prompt during a turn opens one new epoch after the turn ends, with the new prompt and one note", async () => {
  const dir = directory();
  writeDefault(dir, { prompt: "Old rule." });
  const { client, engine } = await serve(dir);
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", 0, (event) => event.state.busy);

  writeDefault(dir, { prompt: ["New rule."] });
  expect(await reload(client)).toMatchObject({ ok: true });
  expect(await reload(client)).toMatchObject({ ok: true });
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(1);
  expect(notes(client).map((entry) => entry.text)).toEqual(["Config reloaded: the prompt changed."]);

  const mark = client.events.length;
  engine.epochs[0].emit(END);
  await client.wait("state", mark, (event) => !event.state.busy);
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(2);
  expect(engine.epochs[0].closed).toBe(true);
  expect(engine.epochs[1].options.append.endsWith("\n\nNew rule.")).toBe(true);
  expect(engine.epochs[1].view).toContain("Config reloaded: the prompt changed.");

  client.act({ type: "act", act: "say", id: "next", text: "Next" });
  await client.wait("answer", mark, (event) => event.id === "next");
  expect(engine.epochs[1].messages.map((message) => message.text)).toEqual(["Next"]);
  expect(engine.epochs).toHaveLength(2);
});

test("a new home opens an idle chat's new epoch there, and epochs.json keeps each epoch's directory", async () => {
  const dir = directory(), vault = directory();
  const { client, engine } = await serve(dir, new FakeEngine((epoch) => epoch.emit(END)));
  const first = path.join(storeDir(dir, "default"), "home");
  writeDefault(dir, { home: vault });
  expect(await reload(client)).toMatchObject({ ok: true });
  await client.wait("entry", 0, (event) => event.entry.text === `Config reloaded: home is now ${vault}.`);
  await Bun.sleep(20);
  expect(engine.epochs.map((epoch) => epoch.options.cwd)).toEqual([first, vault]);
  expect(Object.values(JSON.parse(fs.readFileSync(path.join(defaultStore(dir), "epochs.json"), "utf8")))).toMatchObject([{ session: "fake-session-1", cwd: first }, { session: "fake-session-2", cwd: vault }]);
});

test("a reload with no change to home or prompt keeps the epoch and writes no note", async () => {
  const dir = directory();
  const { client, engine } = await serve(dir, new FakeEngine((epoch) => epoch.emit(END)));
  writeDefault(dir, { approvalTimeout: "5m" });
  expect(await reload(client)).toMatchObject({ ok: true, entry: null });
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", mark, (event) => !event.state.busy);
  expect(engine.epochs).toHaveLength(1);
  expect(notes(client)).toEqual([]);
});

test("a config that does not load keeps the old config and answers the reason, also for a retry", async () => {
  const dir = directory();
  writeDefault(dir, { prompt: "Rule." });
  const { client, engine } = await serve(dir);
  writeConfig(dir, "{ not json");
  const answer = await reload(client, "bad");
  expect(answer).toMatchObject({ ok: false });
  expect(answer.ok ? "" : answer.reason).toStartWith("The config was not reloaded: ");
  writeDefault(dir, { home: path.join(dir, "missing") });
  expect(await reload(client, "bad")).toEqual(answer);
  expect(await reload(client)).toMatchObject({ ok: false, reason: `The config was not reloaded: config.json: agents.default.home: ${path.join(dir, "missing")} is not a directory` });
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(1);
  expect(engine.epochs[0].options.append.endsWith("\n\nRule.")).toBe(true);
  expect(notes(client)).toEqual([]);
});

test("a reload during a goal check applies once, before the goal's next turn is sent", async () => {
  const dir = directory(), vault = directory();
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  let check = (_met: boolean) => {};
  engine.onCheck = () => new Promise((resolve) => { check = resolve; });
  const { client } = await serve(dir, engine);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", 0, (event) => event.state.wait === "goal");

  writeDefault(dir, { home: vault });
  await reload(client);
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(1);
  const mark = client.events.length;
  check(false);
  await client.wait("state", mark, (event) => event.state.wait === "goal");
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(2);
  expect(engine.epochs[0].messages.map((message) => message.text)).toEqual(["Work"]);
  expect(engine.epochs[1].options.cwd).toBe(vault);
  expect(engine.epochs[1].messages.map((message) => message.text)).toEqual(["The goal isn't satisfied yet: keep working."]);
  expect(engine.epochs[1].view).not.toContain("The goal isn't satisfied yet");
  check(true);
  await client.wait("state", mark, (event) => !event.state.busy && event.state.goal === null);
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(2);
});

async function listening(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  let out = "";
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    out += chunk;
    const url = out.match(/serving .* at (\S+) \(pid \d+\)/)?.[1];
    if (url !== undefined) return url;
  }
  throw new Error(`membr serve exited before it listened: ${await new Response(proc.stderr).text()}`);
}

test("SIGHUP to membr serve reloads the config, and a bad file reaches every client as an error", async () => {
  const dir = directory(), vault = directory();
  writeConfig(dir, { port: 0 });
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "test/serve.ts"), "serve"], { env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  const url = await listening(proc);
  const client = await TestClient.connect(url.replace("http:", "ws:") + "ws", { token: fs.readFileSync(path.join(dir, "token"), "utf8").trim() }); clients.push(client);
  await client.wait("ready");

  writeDefault(dir, { home: vault }, { port: 0 });
  proc.kill("SIGHUP");
  await client.wait("entry", 0, (event) => event.entry.text === `Config reloaded: home is now ${vault}.`);
  writeConfig(dir, "{ not json");
  proc.kill("SIGHUP");
  expect((await client.wait("error")).reason).toStartWith("The config was not reloaded: ");
});

test("membr serve refuses a config.json home that is not a directory", async () => {
  const dir = directory();
  writeDefault(dir, { home: "missing" }, { port: 0 });
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "test/serve.ts"), "serve"], { env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain(`config.json: agents.default.home: ${path.join(dir, "missing")} is not a directory`);
});

test("a reload with a new port moves the hub there, and the client that asked gets its answer first", async () => {
  const dir = directory();
  writeConfig(dir, { port: 0 });
  const moves: string[] = [];
  const hub = serveHub({ dir, port: 0, engine: new FakeEngine(), onListen: (url) => moves.push(url) }); hubs.push(hub);
  const before = hub.server.url.href;
  const client = await TestClient.connect(before.replace("http:", "ws:") + "ws", { token: hub.token }); clients.push(client);
  await client.wait("ready");

  const free = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = free.port!;
  free.stop(true);
  writeConfig(dir, { port });
  expect((await reload(client)).ok).toBe(true);
  expect(hub.server.port).toBe(port);
  expect(moves).toEqual([`http://127.0.0.1:${port}/`]);
  expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
  expect(await fetch(before).then(() => "open", () => "closed")).toBe("closed");
  expect((await client.closed).code).toBe(1012);
});

test("a reload whose port is taken changes nothing and says why", async () => {
  const dir = directory();
  writeConfig(dir, { port: 0 });
  const { hub, client } = await serve(dir);
  const before = hub.server.url.href;
  const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("other") });
  try {
    writeConfig(dir, { port: taken.port });
    const answer = await reload(client);
    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.reason).toStartWith("The config was not reloaded: ");
    expect(hub.server.url.href).toBe(before);
    expect((await fetch(before)).ok).toBe(true);
  } finally { taken.stop(true); }
});

test("a message sent during a goal check after a reload goes to the new epoch once, not also in its view", async () => {
  const dir = directory(), vault = directory();
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.onCheck = () => new Promise(() => {});
  const { client } = await serve(dir, engine);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", 0, (event) => event.state.wait === "goal");
  writeDefault(dir, { home: vault });
  await reload(client);

  client.act({ type: "act", act: "say", id: "during", text: "A correction" });
  await client.wait("answer", 0, (event) => event.id === "during");
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(2);
  expect(engine.epochs[1].options.cwd).toBe(vault);
  expect(engine.epochs[1].messages.map((message) => message.text)).toEqual(["A correction"]);
  expect(engine.epochs[1].view).not.toContain("A correction");
});
