import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { readConfig } from "./src/config.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";

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

test("home comes from --home, then MEMBR_HOME, then the file, then the server's directory", () => {
  const dir = directory(), flag = directory(), env = directory();
  fs.mkdirSync(path.join(dir, "vault"));
  expect(readConfig(dir, {}).home).toBe(null);
  writeConfig(dir, { home: "vault" });
  expect(readConfig(dir, {}).home).toBe(path.join(dir, "vault"));
  expect(readConfig(dir, { MEMBR_HOME: env }).home).toBe(env);
  expect(readConfig(dir, { MEMBR_HOME: env }, flag).home).toBe(flag);
  writeConfig(dir, { home: "~/" });
  expect(readConfig(dir, {}).home).toBe(os.homedir());
});

test("approvalTimeout reads seconds, minutes and hours from the file, and defaults to ten minutes", () => {
  const dir = directory();
  expect(readConfig(dir, {}).approvalTimeout).toBe(600_000);
  for (const [text, ms] of [["90s", 90_000], ["10m", 600_000], ["2h", 7_200_000], ["24h", 86_400_000]] as const) {
    writeConfig(dir, { approvalTimeout: text });
    expect(readConfig(dir, {}).approvalTimeout).toBe(ms);
  }
  writeConfig(dir, { approvalTimeout: "1m" });
  expect(readConfig(dir, { MEMBR_APPROVALTIMEOUT: "2h", MEMBR_APPROVAL_TIMEOUT: "2h" }).approvalTimeout).toBe(60_000);
});

test("approvalTimeout refuses a bad format, zero and more than 24h, naming the key", () => {
  const dir = directory();
  for (const [value, reason] of [["10 min", "must be a number and a unit"], ["10", "must be a number and a unit"], [600, "must be a number and a unit"], ["1.5h", "must be a number and a unit"], ["0m", "must be more than 0"], ["25h", "must be 24h or less"], ["1441m", "must be 24h or less"]] as const) {
    writeConfig(dir, { approvalTimeout: value });
    expect(() => readConfig(dir, {})).toThrow(`config.json: approvalTimeout ${reason}`);
  }
});

test("a home that is not a directory is refused with the place it came from", () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, "file"), "");
  writeConfig(dir, { home: "missing" });
  expect(() => readConfig(dir, {})).toThrow(`config.json: home: ${path.join(dir, "missing")} is not a directory`);
  expect(() => readConfig(dir, { MEMBR_HOME: path.join(dir, "file") })).toThrow(`MEMBR_HOME: ${path.join(dir, "file")} is not a directory`);
  expect(() => readConfig(dir, {}, path.join(dir, "file"))).toThrow(`--home: ${path.join(dir, "file")} is not a directory`);
  writeConfig(dir, { home: 3 });
  expect(() => readConfig(dir, {})).toThrow("config.json: home must be a string");
});

test("new rules during a turn open one new epoch after the turn ends, with the new rules and one note", async () => {
  const dir = directory(), rules = path.join(dir, "rules.md");
  fs.writeFileSync(rules, "Old rule.");
  writeConfig(dir, { rules });
  const { client, engine } = await serve(dir);
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", 0, (event) => event.state.busy);

  fs.writeFileSync(rules, "New rule.");
  expect(await reload(client)).toMatchObject({ ok: true });
  expect(await reload(client)).toMatchObject({ ok: true });
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(1);
  expect(notes(client).map((entry) => entry.text)).toEqual(["Config reloaded: the rules changed."]);

  const mark = client.events.length;
  engine.epochs[0].emit(END);
  await client.wait("state", mark, (event) => !event.state.busy);
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(2);
  expect(engine.epochs[0].closed).toBe(true);
  expect(engine.epochs[1].options.append.endsWith("\n\nNew rule.")).toBe(true);
  expect(engine.epochs[1].view).toContain("Config reloaded: the rules changed.");

  client.act({ type: "act", act: "say", id: "next", text: "Next" });
  await client.wait("answer", mark, (event) => event.id === "next");
  expect(engine.epochs[1].messages.map((message) => message.text)).toEqual(["Next"]);
  expect(engine.epochs).toHaveLength(2);
});

test("a new home opens an idle chat's new epoch there, and epochs.json keeps each epoch's directory", async () => {
  const dir = directory(), vault = directory();
  const { client, engine } = await serve(dir, new FakeEngine((epoch) => epoch.emit(END)));
  writeConfig(dir, { home: vault });
  expect(await reload(client)).toMatchObject({ ok: true });
  await client.wait("entry", 0, (event) => event.entry.text === `Config reloaded: home is now ${vault}.`);
  await Bun.sleep(20);
  expect(engine.epochs.map((epoch) => epoch.options.cwd)).toEqual([process.cwd(), vault]);
  expect(Object.values(JSON.parse(fs.readFileSync(path.join(dir, "epochs.json"), "utf8")))).toMatchObject([{ session: "fake-session-1", cwd: process.cwd() }, { session: "fake-session-2", cwd: vault }]);
});

test("a reload with no change to home or rules keeps the epoch and writes no note, and a new after runs at once", async () => {
  const dir = directory(), output = path.join(dir, "after.txt");
  const { client, engine } = await serve(dir, new FakeEngine((epoch) => epoch.emit(END)));
  writeConfig(dir, { after: `printf x >> '${output}'` });
  expect(await reload(client)).toMatchObject({ ok: true, entry: null });
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", mark, (event) => !event.state.busy);
  for (let i = 0; i < 100 && !fs.existsSync(output); i++) await Bun.sleep(10);
  expect(fs.readFileSync(output, "utf8")).toBe("x");
  expect(engine.epochs).toHaveLength(1);
  expect(notes(client)).toEqual([]);
});

test("a config that does not load keeps the old config and answers the reason, also for a retry", async () => {
  const dir = directory(), rules = path.join(dir, "rules.md");
  fs.writeFileSync(rules, "Rule.");
  writeConfig(dir, { rules });
  const { client, engine } = await serve(dir);
  writeConfig(dir, "{ not json");
  const answer = await reload(client, "bad");
  expect(answer).toMatchObject({ ok: false });
  expect(answer.ok ? "" : answer.reason).toStartWith("The config was not reloaded: ");
  writeConfig(dir, { home: path.join(dir, "missing") });
  expect(await reload(client, "bad")).toEqual(answer);
  expect(await reload(client)).toMatchObject({ ok: false, reason: `The config was not reloaded: config.json: home: ${path.join(dir, "missing")} is not a directory` });
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

  writeConfig(dir, { home: vault });
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
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "test/serve.ts"), "serve", "--port", "0"], { env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  const url = await listening(proc);
  const client = await TestClient.connect(url.replace("http:", "ws:") + "ws", { token: fs.readFileSync(path.join(dir, "token"), "utf8").trim() }); clients.push(client);
  await client.wait("ready");

  writeConfig(dir, { home: vault });
  proc.kill("SIGHUP");
  await client.wait("entry", 0, (event) => event.entry.text === `Config reloaded: home is now ${vault}.`);
  writeConfig(dir, "{ not json");
  proc.kill("SIGHUP");
  expect((await client.wait("error")).reason).toStartWith("The config was not reloaded: ");
});

test("membr serve refuses a --home that is not a directory", async () => {
  const dir = directory();
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "test/serve.ts"), "serve", "--port", "0", "--home", path.join(dir, "missing")], { env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain(`--home: ${path.join(dir, "missing")} is not a directory`);
});

test("a message sent during a goal check after a reload goes to the new epoch once, not also in its view", async () => {
  const dir = directory(), vault = directory();
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.onCheck = () => new Promise(() => {});
  const { client } = await serve(dir, engine);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("state", 0, (event) => event.state.wait === "goal");
  writeConfig(dir, { home: vault });
  await reload(client);

  client.act({ type: "act", act: "say", id: "during", text: "A correction" });
  await client.wait("answer", 0, (event) => event.id === "during");
  await Bun.sleep(20);
  expect(engine.epochs).toHaveLength(2);
  expect(engine.epochs[1].options.cwd).toBe(vault);
  expect(engine.epochs[1].messages.map((message) => message.text)).toEqual(["A correction"]);
  expect(engine.epochs[1].view).not.toContain("A correction");
});

test("a relative rules path in config.json starts at the data directory, so a service that starts in / finds it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-rules-"));
  fs.writeFileSync(path.join(dir, "rules.md"), "Use British spelling.");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ rules: "rules.md" }));
  expect(readConfig(dir, {}).rulesText).toBe("Use British spelling.");
});
