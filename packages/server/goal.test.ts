import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(engine = new FakeEngine(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-goal-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return { ...hub, client, engine, dir };
}

async function act(client: TestClient, id: string, kind: "goal" | "say" | "stop", text?: string | null) {
  const mark = client.events.length;
  if (kind === "stop") client.act({ type: "act", act: "stop", id, agent: null });
  else if (kind === "goal") client.act({ type: "act", act: "goal", id, text: text ?? null });
  else client.act({ type: "act", act: "say", id, text: text ?? "" });
  expect((await client.wait("answer", mark, (event) => event.id === id)).ok).toBe(true);
}

function entries(client: TestClient) {
  return client.events.filter((event) => event.type === "entry").map((event) => event.entry);
}

test("two unmet checks produce three turns, then a met check clears the goal", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Work done in this turn" }, END));
  engine.onCheck = async () => engine.checks.length === 3;
  const hub = await serve(engine);
  await act(hub.client, "goal", "goal", "Complete the task");
  const mark = hub.client.events.length;
  await act(hub.client, "start", "say", "Start the task");
  await hub.client.wait("entry", mark, (event) => event.entry.text === "Goal met.", 10000);
  await hub.client.wait("state", mark, (event) => !event.state.busy && event.state.goal === null, 10000);
  expect(engine.checks).toHaveLength(3);
  expect(engine.epochs[0].messages).toEqual([
    { text: "Start the task", priority: "now", from: "user" },
    { text: "The goal isn't satisfied yet: keep working.", priority: "now", from: "membr" },
    { text: "The goal isn't satisfied yet: keep working.", priority: "now", from: "membr" },
  ]);
  expect(entries(hub.client).filter((entry) => entry.kind === "note").map((entry) => entry.text)).toEqual([
    "The goal isn't satisfied yet: keep working.",
    "The goal isn't satisfied yet: keep working.",
    "Goal met.",
  ]);
  expect(engine.checks[0].chat).toContain("0+1|user: Start the task");
  expect(engine.checks[0].chat).toContain("unii: Work done in this turn");
  expect(JSON.parse(fs.readFileSync(path.join(hub.dir, "view.json"), "utf8")).goal).toBe(null);
  hub.close();
  fs.unlinkSync(path.join(hub.dir, "view.json"));
  const after = await serve(new FakeEngine(), hub.dir);
  expect((await after.client.wait("state")).state.goal).toBe(null);
  expect(after.engine.epochs[0].messages).toHaveLength(0);
});

test("halt during a turn logs one note and prevents a further turn", async () => {
  const hub = await serve();
  await act(hub.client, "goal", "goal", "Keep working");
  await act(hub.client, "start", "say", "Begin");
  await act(hub.client, "halt", "goal", null);
  await act(hub.client, "halt-again", "goal", null);
  const mark = hub.client.events.length;
  hub.engine.epochs[0].emit(END);
  await hub.client.wait("state", mark, (event) => !event.state.busy && event.state.goal === null);
  expect(hub.engine.checks).toHaveLength(0);
  expect(hub.engine.epochs[0].messages).toHaveLength(1);
  expect(entries(hub.client).filter((entry) => entry.kind === "note").map((entry) => entry.text)).toEqual(["Goal halted by the user."]);
});

test("halt without a goal adds no note, including after restart", async () => {
  const before = await serve();
  await act(before.client, "halt", "goal", null);
  await act(before.client, "halt-again", "goal", null);
  expect(entries(before.client)).toEqual([]);
  await before.close();
  const after = await serve(new FakeEngine(), before.dir);
  await act(after.client, "halt-after-restart", "goal", null);
  expect(entries(after.client)).toEqual([]);
  expect(after.engine.epochs[0].messages).toEqual([]);
  expect((await after.client.wait("state")).state.goal).toBe(null);
});

test("stop during a goal turn does not start a goal check", async () => {
  const hub = await serve();
  await act(hub.client, "goal", "goal", "Keep working");
  await act(hub.client, "start", "say", "Begin");
  const mark = hub.client.events.length;
  await act(hub.client, "stop", "stop");
  await hub.client.wait("state", mark, (event) => !event.state.busy);
  expect(hub.engine.checks).toHaveLength(0);
  expect(hub.engine.epochs[0].messages).toHaveLength(1);
  expect((await hub.client.wait("state", mark, (event) => !event.state.busy)).state.goal).toBe("Keep working");
});

test("restart restores a goal but does not start work", async () => {
  const before = await serve();
  await act(before.client, "goal", "goal", "Keep working");
  before.close();
  const after = await serve(new FakeEngine(), before.dir);
  expect((await after.client.wait("state")).state.goal).toBe("Keep working");
  expect(after.engine.epochs[0].messages).toHaveLength(0);
  expect(after.engine.checks).toHaveLength(0);
  await act(after.client, "halt", "goal", null);
  after.close();
  const again = await serve(new FakeEngine(), before.dir);
  expect((await again.client.wait("state")).state.goal).toBe(null);
  expect(JSON.parse(fs.readFileSync(path.join(before.dir, "view.json"), "utf8")).goal).toBe(null);
});

for (const ending of ["halt", "replace", "same text", "input", "stop", "close"] as const) {
  test(`a late goal check cannot continue after ${ending}`, async () => {
    const pending = Promise.withResolvers<boolean>();
    const engine = new FakeEngine((epoch, message) => { if (message.text === "Begin") epoch.emit(END); });
    engine.onCheck = () => pending.promise;
    const hub = await serve(engine);
    await act(hub.client, "goal", "goal", "Keep working");
    await act(hub.client, "start", "say", "Begin");
    await hub.client.wait("state", 0, (event) => event.state.wait === "goal");
    const changed = hub.client.events.length;
    if (ending === "halt") await act(hub.client, "halt", "goal", null);
    if (ending === "replace") await act(hub.client, "replace", "goal", "New goal");
    if (ending === "same text") await act(hub.client, "same", "goal", "Keep working");
    if (ending === "input") await act(hub.client, "input", "say", "New human input");
    if (ending === "stop") await act(hub.client, "stop", "stop");
    if (ending === "close") hub.close();
    const kept = ending === "replace" ? "New goal" : "Keep working";
    if (ending === "replace" || ending === "same text") await hub.client.wait("state", changed, (event) => !event.state.busy && event.state.goal === kept);
    pending.resolve(ending === "replace" || ending === "same text");
    await Bun.sleep(10);
    expect(engine.epochs[0].messages.map((message) => message.text)).toEqual(ending === "input" ? ["Begin", "New human input"] : ["Begin"]);
    expect(entries(hub.client).some((entry) => entry.text === "The goal isn't satisfied yet: keep working.")).toBe(false);
    expect(engine.checks[0].signal.aborted).toBe(true);
    if (ending === "replace" || ending === "same text") {
      expect(entries(hub.client).some((entry) => entry.text === "Goal met.")).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(hub.dir, "view.json"), "utf8")).goal).toBe(kept);
      hub.close();
      const after = await serve(new FakeEngine(), hub.dir);
      expect((await after.client.wait("state")).state.goal).toBe(kept);
    }
  });
}

test("a failed view save during a goal check ends the new durable turn", async () => {
  const pending = Promise.withResolvers<boolean>();
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.onCheck = () => pending.promise;
  const hub = await serve(engine);
  await act(hub.client, "goal", "goal", "Keep working");
  await act(hub.client, "start", "say", "Begin");
  await hub.client.wait("state", 0, (event) => event.state.wait === "goal");
  fs.mkdirSync(path.join(hub.dir, "view.json.tmp"));
  const mark = hub.client.events.length;
  await act(hub.client, "fresh", "say", "Keep this durable input");
  await hub.client.wait("error", mark);
  expect(engine.checks[0].signal.aborted).toBe(true);
  hub.close();
  fs.rmdirSync(path.join(hub.dir, "view.json.tmp"));
  const after = await serve(new FakeEngine(), hub.dir);
  expect(after.engine.epochs[0].view).toContain("Keep this durable input");
  expect(entries(after.client).filter((entry) => entry.text.includes("The turn failed:"))).toHaveLength(1);
  expect(entries(after.client).some((entry) => entry.text === "The server restarted before the turn ended.")).toBe(false);
});

test("a failed check keeps the goal and logs a note without another turn", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.onCheck = async () => { throw new Error("Check unavailable"); };
  const hub = await serve(engine);
  await act(hub.client, "goal", "goal", "Keep working");
  const mark = hub.client.events.length;
  await act(hub.client, "start", "say", "Begin");
  await hub.client.wait("entry", mark, (event) => event.entry.text.includes("No goal check:"));
  expect((await hub.client.wait("state", mark, (event) => !event.state.busy)).state.goal).toBe("Keep working");
  expect(engine.epochs[0].messages).toHaveLength(1);
});

test("a goal check reads the full recent message before its summary is ready", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  const hub = await serve(engine);
  const text = "RAW DETAIL " + "x".repeat(2000);
  await act(hub.client, "goal", "goal", "Read the detail");
  const mark = hub.client.events.length;
  await act(hub.client, "start", "say", text);
  await hub.client.wait("entry", mark, (event) => event.entry.text === "Goal met.");
  expect(engine.checks[0].chat).toContain(text);
  expect(engine.epochs[0].view).not.toContain(text);
});

test("a synthetic continuation keeps its source after a batch rotation", async () => {
  const engine = new FakeEngine((epoch, message) => {
    if (message.from === "user") {
      for (let i = 0; i < 270; i++) epoch.emit({ kind: "text", text: `${i}:` + "x".repeat(490) });
    }
    epoch.emit(END);
  });
  engine.onCheck = async () => engine.checks.length === 2;
  const hub = await serve(engine);
  await act(hub.client, "goal", "goal", "Finish after two turns");
  const mark = hub.client.events.length;
  await act(hub.client, "start", "say", "Begin");
  await hub.client.wait("entry", mark, (event) => event.entry.text === "Goal met.", 10000);
  expect(engine.epochs).toHaveLength(2);
  expect(engine.epochs[1].messages).toEqual([{ text: "The goal isn't satisfied yet: keep working.", priority: "now", from: "membr" }]);
});

test("a failed synthetic send ends its durable turn and fails the chat", async () => {
  const engine = new FakeEngine((epoch, message) => { if (message.from === "user") epoch.emit(END); });
  engine.onCheck = async () => false;
  const hub = await serve(engine);
  const epoch = engine.epochs[0];
  const send = epoch.send.bind(epoch);
  epoch.send = (text, priority, from) => {
    if (from === "membr") throw new Error("Synthetic send failed");
    return send(text, priority, from);
  };
  await act(hub.client, "goal", "goal", "Keep working");
  const mark = hub.client.events.length;
  await act(hub.client, "start", "say", "Begin");
  expect((await hub.client.wait("error", mark)).reason).toBe("Synthetic send failed");
  expect(entries(hub.client).some((entry) => entry.text === "The turn failed: Synthetic send failed")).toBe(true);
  expect(epoch.closed).toBe(true);
  hub.close();
  const after = await serve(new FakeEngine(), hub.dir);
  expect(after.engine.epochs[0].view).toContain("The goal isn't satisfied yet: keep working.");
  expect((await after.client.wait("state")).state.goal).toBe("Keep working");
  expect(entries(after.client).filter((entry) => entry.text === "The turn failed: Synthetic send failed")).toHaveLength(1);
});
