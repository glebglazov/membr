import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { readConfig, type ChatConfig } from "./src/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function serve(engine = new FakeEngine(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-turns-")), config?: ChatConfig) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine, config });
  hubs.push(hub);
  return { ...hub, dir, engine };
}

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("The after command did not finish");
    await Bun.sleep(5);
  }
}
async function connect(hub: ReturnType<typeof serve>) {
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return client;
}

test("two clients get live text and each Engine block in order, with one send per act", async () => {
  const hub = serve(new FakeEngine((epoch) => epoch.emit(
    { kind: "delta", text: "Hello" },
    { kind: "text", text: "Hello" },
    { kind: "tool", id: "call-1", name: "Read", input: { file_path: "/tmp/example" } },
    { kind: "echo", id: "call-1", text: "contents", error: false }, END,
  )));
  const a = await connect(hub);
  const b = await connect(hub);
  const act = { type: "act", act: "say", id: "say-1", text: "Read this" } as const;
  const mark = a.events.length;
  a.act(act);
  b.act(act);
  const answer = await a.wait("answer");
  expect(await b.wait("answer")).toEqual(answer);
  await a.wait("state", mark, (event) => !event.state.busy);
  await b.wait("entry", 0, (event) => event.entry.kind === "echo");
  for (const client of [a, b]) {
    expect(client.events.filter((event) => event.type === "entry").map((event) => event.entry.kind)).toEqual(["user", "unii", "tool", "echo"]);
    expect((await client.wait("live")).text).toBe("Hello");
    expect(client.events.findIndex((event) => event.type === "live")).toBeLessThan(client.events.findIndex((event) => event.type === "entry" && event.entry.kind === "unii"));
  }
  expect(hub.engine.epochs[0].messages).toEqual([{ text: "Read this", priority: "now", from: "user" }]);
  const entries = a.events.filter((event) => event.type === "entry").map((event) => event.entry);
  expect(JSON.parse(entries[2].text)).toEqual({ id: "call-1", name: "Read", input: { file_path: "/tmp/example" } });
  expect(JSON.parse(entries[3].text)).toEqual({ id: "call-1", text: "contents", error: false });
  expect(Object.values(JSON.parse(fs.readFileSync(path.join(hub.dir, "epochs.json"), "utf8")))).toEqual(["fake-session-1"]);
  expect(hub.engine.epochs[0].options.append).toContain("the server machine");
  expect(hub.engine.epochs[0].options.append).not.toContain("# Compactions");
});

test("config rules reach the Engine and after runs once per completed turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-turns-"));
  const rules = path.join(dir, "rules.txt");
  const output = path.join(dir, "after.txt");
  fs.writeFileSync(rules, "Keep this standing rule.");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    rules,
    after: `printf x >> '${output}'`,
  }));
  const hub = serve(new FakeEngine((epoch) => epoch.emit(END)), dir);
  expect(hub.engine.epochs[0].options.append).toContain("the server machine");
  expect(hub.engine.epochs[0].options.append.endsWith("\n\nKeep this standing rule.")).toBe(true);
  const client = await connect(hub);
  for (let i = 0; i < 2; i++) {
    const mark = client.events.length;
    client.act({ type: "act", act: "say", id: `turn-${i}`, text: "Work" });
    await client.wait("answer", mark, (event) => event.id === `turn-${i}`);
    await client.wait("state", mark, (event) => !event.state.busy);
  }
  await until(() => fs.existsSync(output) && fs.readFileSync(output, "utf8") === "xx");
  expect(fs.readFileSync(output, "utf8")).toBe("xx");
});

test("closing the server waits for a running after command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-turns-"));
  const output = path.join(dir, "after.txt");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ after: `sleep 0.1; printf done > '${output}'` }));
  const hub = serve(new FakeEngine((epoch) => epoch.emit(END)), dir);
  const client = await connect(hub);
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "closing-turn", text: "Work" });
  await client.wait("answer", mark);
  await client.wait("state", mark, (event) => !event.state.busy);
  await hub.close();
  expect(fs.readFileSync(output, "utf8")).toBe("done");
});

test("MEMBR_AFTER and MEMBR_RULES replace the config file values", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-turns-"));
  const fileRules = path.join(dir, "file-rules.txt");
  const envRules = path.join(dir, "env-rules.txt");
  const fileOutput = path.join(dir, "file-after.txt");
  const envOutput = path.join(dir, "env-after.txt");
  fs.writeFileSync(fileRules, "File rule.");
  fs.writeFileSync(envRules, "Environment rule.");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    rules: fileRules,
    after: `printf file >> '${fileOutput}'`,
  }));
  const config = readConfig(dir, {
    MEMBR_RULES: envRules,
    MEMBR_AFTER: `printf env >> '${envOutput}'`,
  });
  const hub = serve(new FakeEngine((epoch) => epoch.emit(END)), dir, config);
  expect(hub.engine.epochs[0].options.append.endsWith("\n\nEnvironment rule.")).toBe(true);
  expect(hub.engine.epochs[0].options.append).not.toContain("File rule.");
  const client = await connect(hub);
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "env-turn", text: "Work" });
  await client.wait("answer", mark);
  await client.wait("state", mark, (event) => !event.state.busy);
  await until(() => fs.existsSync(envOutput));
  expect(fs.readFileSync(envOutput, "utf8")).toBe("env");
  expect(fs.existsSync(fileOutput)).toBe(false);
});

test("input during a turn uses next and an older result cannot finish it", async () => {
  const hub = serve();
  const client = await connect(hub);
  client.act({ type: "act", act: "say", id: "one", text: "Start" });
  await client.wait("answer");
  hub.engine.epochs[0].emit({ kind: "tool", id: "wait", name: "Bash", input: { command: "sleep 1" } });
  await client.wait("entry", 0, (event) => event.entry.kind === "tool");
  client.act({ type: "act", act: "say", id: "two", text: "Use this correction" });
  await client.wait("answer", 0, (event) => event.id === "two");
  expect(hub.engine.epochs).toHaveLength(1);
  expect(hub.engine.epochs[0].messages.map((message) => message.priority)).toEqual(["now", "next"]);
  const mark = client.events.length;
  hub.engine.epochs[0].emit({ ...END, through: 1 });
  expect((await client.wait("state", mark)).state.busy).toBe(true);
  hub.engine.epochs[0].emit({ kind: "text", text: "Correction used" }, END);
  await client.wait("state", mark, (event) => !event.state.busy);
  expect(hub.engine.epochs).toHaveLength(1);
});

test("a result already in flight cannot finish later input or hide it on restart", async () => {
  const before = serve(new FakeEngine((epoch) => {
    if (epoch.messages.length === 2) epoch.emit({ ...END, through: 1 });
  }));
  const a = await connect(before);
  a.act({ type: "act", act: "say", id: "first", text: "First task" });
  await a.wait("answer");
  const mark = a.events.length;
  a.act({ type: "act", act: "say", id: "second", text: "Second task" });
  await a.wait("answer", mark);
  await a.wait("state", mark);
  expect(a.events.slice(mark).filter((event) => event.type === "state").every((event) => event.state.busy)).toBe(true);
  a.act({ type: "act", act: "say", id: "third", text: "Third task" });
  await a.wait("answer", mark, (event) => event.id === "third");
  expect(before.engine.epochs[0].messages.map((message) => message.priority)).toEqual(["now", "next", "next"]);
  before.close();
  const after = serve(new FakeEngine(), before.dir);
  const b = await connect(after);
  expect(b.events.filter((event) => event.type === "entry").map((event) => event.entry.kind)).toEqual(["user", "user", "user", "note"]);
  expect(after.engine.epochs[0].view).toContain("Second task");
  expect(after.engine.epochs[0].view).toContain("Third task");
});

test("stop logs one note and fences new input until interrupt completes", async () => {
  const hub = serve();
  const a = await connect(hub);
  const b = await connect(hub);
  const epoch = hub.engine.epochs[0];
  const interrupted = Promise.withResolvers<void>();
  epoch.onInterrupt = () => interrupted.promise;
  a.act({ type: "act", act: "say", id: "run", text: "Work" });
  await a.wait("answer");
  const stop = { type: "act", act: "stop", id: "stop", agent: null } as const;
  a.act(stop);
  const answer = await a.wait("answer", 0, (event) => event.id === "stop");
  b.act(stop);
  expect(await b.wait("answer", 0, (event) => event.id === "stop")).toEqual(answer);
  a.act({ type: "act", act: "say", id: "too-soon", text: "New work" });
  expect((await a.wait("answer", 0, (event) => event.id === "too-soon")).ok).toBe(false);
  expect(epoch.interrupts).toBe(1);
  const mark = a.events.length;
  interrupted.resolve();
  await a.wait("state", mark, (event) => !event.state.busy);
  expect(epoch.closed).toBe(false);
  expect(hub.engine.epochs).toHaveLength(1);
  expect(a.events.filter((event) => event.type === "entry" && event.entry.kind === "note")).toHaveLength(1);
  a.act({ type: "act", act: "say", id: "new", text: "New work" });
  await a.wait("answer", 0, (event) => event.id === "new");
  b.act(stop);
  await b.wait("answer", 0, (event) => event.id === "stop");
  expect(epoch.interrupts).toBe(1);
  expect(epoch.messages[1].text).toBe("New work");
});

test("restart opens a new epoch with the saved view and one cut note", async () => {
  const before = serve();
  const a = await connect(before);
  a.act({ type: "act", act: "say", id: "cut", text: "Keep every word\nincluding this line" });
  const answer = await a.wait("answer");
  before.engine.epochs[0].emit({ kind: "text", text: "Work so far" });
  await a.wait("entry", 0, (event) => event.entry.kind === "unii");
  before.close();
  const after = serve(new FakeEngine(), before.dir);
  const b = await connect(after);
  const entries = b.events.filter((event) => event.type === "entry").map((event) => event.entry);
  expect(entries.map((entry) => entry.kind)).toEqual(["user", "unii", "note"]);
  for (const entry of entries) expect(after.engine.epochs[0].view).toContain(`${entry.i}+1|${entry.kind}: ${entry.text.replace(/\s*\n\s*/g, " ")}`);
  b.act({ type: "act", act: "say", id: "cut", text: "Do not send again" });
  expect(await b.wait("answer")).toEqual(answer);
  expect(after.engine.epochs[0].messages).toHaveLength(0);
  after.close();
  const again = serve(new FakeEngine(), before.dir);
  const c = await connect(again);
  expect(c.events.filter((event) => event.type === "entry" && event.entry.kind === "note")).toHaveLength(1);
});

test("an Engine failure ends busy state and leaves a durable note", async () => {
  const hub = serve();
  const client = await connect(hub);
  client.act({ type: "act", act: "say", id: "fail", text: "Work" });
  await client.wait("answer");
  const mark = client.events.length;
  hub.engine.epochs[0].fail(new Error("Scripted outage"));
  expect((await client.wait("error", mark)).reason).toBe("Scripted outage");
  expect((await client.wait("state", mark)).state.busy).toBe(false);
  expect((await client.wait("entry", mark)).entry.text).toContain("Scripted outage");
});

test("a failed epoch cannot reopen when an earlier interrupt finishes", async () => {
  const hub = serve();
  const client = await connect(hub);
  const epoch = hub.engine.epochs[0];
  const interrupt = Promise.withResolvers<void>();
  epoch.onInterrupt = () => interrupt.promise;
  client.act({ type: "act", act: "say", id: "work", text: "Work" });
  await client.wait("answer");
  client.act({ type: "act", act: "stop", id: "stop-failed", agent: null });
  await client.wait("answer", 0, (event) => event.id === "stop-failed");
  epoch.fail(new Error("Lost connection during stop"));
  await client.wait("error");
  interrupt.resolve();
  client.act({ type: "act", act: "say", id: "after-failure", text: "New work" });
  expect((await client.wait("answer", 0, (event) => event.id === "after-failure")).ok).toBe(false);
  expect(hub.engine.epochs).toHaveLength(1);
});

test("epoch usage adds completed main turns and starts at zero after restart", async () => {
  const usage = { input: 100, cacheRead: 700, cacheWrite: 200, output: 50 };
  const hub = serve(new FakeEngine((epoch) => epoch.emit({ ...END, usage })));
  const client = await connect(hub);
  expect((await client.wait("state")).state.epoch).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  for (let index = 1; index <= 2; index++) {
    const mark = client.events.length;
    client.act({ type: "act", act: "say", id: `usage-${index}`, text: "Work" });
    const completed = await client.wait("state", mark, (event) => !event.state.busy);
    expect(completed.state.usage).toEqual(usage);
    expect(completed.state.epoch).toEqual({ input: 100 * index, cacheRead: 700 * index, cacheWrite: 200 * index, output: 50 * index });
  }
  client.close();
  await hub.close();
  const restarted = await connect(serve(new FakeEngine(), hub.dir));
  expect((await restarted.wait("state")).state.epoch).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
});
