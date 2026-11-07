import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { NO_USAGE } from "./src/engine.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";
import { defaultStore, testConfig } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
async function start(engine = new FakeEngine(), existing?: string) {
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), "membr-subagents-"));
  if (!existing) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine, config: () => testConfig(dir, [{ name: "default", prompt: "Keep the project rules." }]) });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  const main = engine.epochs[0];
  const subagents = main.options.subagents;
  if (!subagents || !main.options.memory) throw new Error("Missing tools");
  return { dir, hub, client, engine, main, subagents, memory: main.options.memory };
}
async function say(client: TestClient, text = "Work") {
  const id = crypto.randomUUID();
  client.act({ type: "act", act: "say", id, text });
  await client.wait("answer", 0, (event) => event.id === id);
}
async function stop(client: TestClient, subagent: string | null) {
  const id = crypto.randomUUID();
  client.act({ type: "act", act: "stop", id, subagent });
  expect((await client.wait("answer", 0, (event) => event.id === id)).ok).toBe(true);
}

test("a subagent report starts a main turn after the main turn ends", async () => {
  const { client, main, subagents, engine, dir } = await start();
  await say(client);
  expect(subagents.spawn([{ name: "helper", task: "Find the answer" }], "low")).toStartWith("Started helper.");
  const child = engine.epochs[1];
  expect(child.options.subagents).toBeUndefined();
  expect(child.options.append).toContain("Keep the project rules.");
  expect(child.options.append).toContain("Your final reply is your report to membr.");
  expect(child.options.pick.effort).toBe("low");
  expect(child.messages[0]).toEqual({ text: "Find the answer", priority: "now", from: "membr" });
  expect(fs.readFileSync(path.join(defaultStore(dir), "docs/subagent/helper.jsonl"), "utf8")).toContain("Find the answer");
  main.emit(END);
  await client.wait("state", 0, (event) => !event.state.busy && event.state.subagents.includes("helper"));
  const mark = client.events.length;
  child.emit({ kind: "text", text: "The answer is 42." }, { ...END, reply: "The answer is 42." });
  const report = await client.wait("entry", mark, (event) => event.entry.kind === "work");
  expect(report.entry.text).toContain('[helper] report\nThe answer is 42.\nFull chat: zoom("helper")');
  await client.wait("state", mark, (event) => event.state.busy && !event.state.subagents.length);
  expect(main.messages[1]).toEqual({ text: report.entry.text, priority: "now", from: "membr" });
  expect(new Log(defaultStore(dir)).interrupted).toEqual([report.entry.i]);
  const finished = client.events.length;
  main.emit(END);
  await client.wait("state", finished, (event) => !event.state.busy && !event.state.subagents.length);
  expect(new Log(defaultStore(dir)).interrupted).toEqual([]);
});

test("tell joins running input and stale completion does not report early", async () => {
  const { client, subagents, engine, main, dir } = await start();
  await say(client);
  subagents.spawn([{ name: "helper", task: "First task" }]);
  const child = engine.epochs[1];
  child.emit({ kind: "tool", id: "one", name: "Read", input: { file: "first" } });
  await client.wait("subagent-entry", 0, (event) => event.entry.kind === "tool");
  expect(subagents.tell("helper", "Second task")).toContain("between its tool calls");
  expect(child.messages[1]).toEqual({ text: "Second task", priority: "next", from: "membr" });
  child.emit({ ...END, through: 1, reply: "First result" }, { kind: "tool", id: "two", name: "Read", input: {} });
  await client.wait("subagent-entry", 0, (event) => event.entry.text.includes('"two"'));
  expect(client.events.filter((event) => event.type === "entry" && event.entry.kind === "work")).toHaveLength(0);
  child.emit({ ...END, through: 2, reply: "Second result" });
  const report = await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(report.entry.text).toContain("First result\n\nSecond result");
  expect(main.messages[1].priority).toBe("next");
  main.emit(END);
  await client.wait("state", 0, (event) => !event.state.busy && !event.state.subagents.length && event.state.usage !== null);
  expect(new Log(defaultStore(dir)).interrupted).toEqual([]);
});

test("named zoom and client reads use the saved subagent log and live snapshot", async () => {
  const { client, subagents, engine, memory } = await start();
  subagents.spawn([{ name: "helper", task: "Read this" }]);
  const child = engine.epochs[1];
  child.emit({ kind: "text", text: "Saved reply" }, { kind: "delta", text: "Live reply" });
  expect((await client.wait("live", 0, (event) => event.subagent === "helper")).text).toBe("Live reply");
  client.read({ type: "read", read: "subagent", id: "subagent", name: "helper" });
  const log = await client.wait("read", 0, (event) => event.id === "subagent");
  expect(log.live).toBe("Live reply");
  expect(memory.zoom("helper").text).toBe(log.entries.map((entry) => `${entry.i}|${entry.kind}: ${entry.text}`).join("\n\n"));
  expect(client.events.some((event) => event.type === "entry" && event.entry.text === "Saved reply")).toBe(false);
  expect(memory.zoom("../secret").error).toBe(true);
  expect(subagents.tell("../secret", "read")).toBe("No subagent ../secret to tell.");
  child.emit({ kind: "text", text: "x".repeat(40000) });
  await client.wait("subagent-entry", 0, (event) => event.entry.text.length === 40000);
  const first = memory.zoom("helper").text;
  const more = /go on with at (\d+)\]/.exec(first);
  expect(more).not.toBeNull();
  const at = Number(more?.[1]);
  expect(memory.zoom("helper", 1, at).text.length).toBeGreaterThan(0);
});

test("named stop cancels only its subagent and its approvals, all stop cancels every session", async () => {
  const { client, main, subagents, engine } = await start();
  await say(client);
  subagents.spawn([{ name: "One", task: "One" }, { name: "Two", task: "Two" }]);
  const one = engine.epochs[1], two = engine.epochs[2];
  const decisions = [main.options.ask!("Bash", { command: "main" }), one.options.ask!("Bash", { command: "one" }), two.options.ask!("Bash", { command: "two" })];
  await client.wait("ask", 0, (event) => event.input.command === "two");
  const mark = client.events.length;
  await stop(client, "one");
  expect(await decisions[1]).toBe(false);
  expect(one.interrupts).toBe(1);
  expect(two.interrupts).toBe(0);
  expect(main.interrupts).toBe(0);
  await client.wait("entry", mark, (event) => event.entry.kind === "work" && event.entry.text.includes("Stopped."));
  expect(main.messages).toHaveLength(1);
  expect(client.events.filter((event) => event.type === "ask-closed")).toHaveLength(1);
  const end = client.events.length;
  await stop(client, null);
  expect(await decisions[0]).toBe(false);
  expect(await decisions[2]).toBe(false);
  await client.wait("state", end, (event) => !event.state.busy && !event.state.subagents.length);
  expect(main.interrupts).toBe(1);
  expect(two.interrupts).toBe(1);
  expect(main.messages).toHaveLength(1);
});

test("a stale stop failure does not report the subagent twice", async () => {
  const { client, subagents, engine } = await start();
  subagents.spawn([{ name: "helper", task: "First task" }]);
  const old = engine.epochs[1];
  const interrupt = Promise.withResolvers<void>();
  old.onInterrupt = () => interrupt.promise;

  await stop(client, "helper");
  old.fail(new Error("Old session failed"));
  await client.wait("entry", 0, (event) => event.entry.kind === "work" && event.entry.text.includes("Old session failed"));
  interrupt.reject(new Error("Old interrupt failed"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(old.closed).toBe(true);
  expect(client.events.filter((event) => event.type === "entry" && event.entry.kind === "work")).toHaveLength(1);
});

test("a finished subagent closes its session and takes no more work", async () => {
  const { client, subagents, engine } = await start();
  expect(subagents.spawn([{ name: "Store Reader!", task: "Initial task" }], "medium")).toStartWith("Started store-reader.");
  const child = engine.epochs[1];
  expect(child.view).toEndWith("You are subagent store-reader.");
  child.emit({ kind: "text", text: "Saved result" }, { ...END, reply: "Saved result" });
  await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(child.closed).toBe(true);
  expect(subagents.tell("store-reader", "Resume")).toBe("store-reader has finished. Spawn a new subagent with the context it needs.");
  expect(engine.epochs).toHaveLength(2);
  expect(subagents.spawn([{ name: "store-reader", task: "Next task" }, { name: "42", task: "Odd name" }])).toStartWith("Started store-reader-2, subagent.");
});

test("a restart records once each subagent it stopped mid-run", async () => {
  const { client, subagents, engine, hub, dir } = await start();
  subagents.spawn([{ name: "done", task: "Short task" }, { name: "reader", task: "Long task" }]);
  engine.epochs[1].emit({ ...END, reply: "Done" });
  engine.epochs[2].emit({ kind: "tool", id: "one", name: "Read", input: {} });
  await client.wait("subagent-entry", 0, (event) => event.name === "reader" && event.entry.kind === "tool");
  await hub.close();
  fs.appendFileSync(path.join(defaultStore(dir), "docs/subagent/reader.jsonl"), '{"partial":');

  const reports = () => new Log(defaultStore(dir)).entries.filter((entry) => entry.kind === "work").map((entry) => entry.text);
  const next = await start(new FakeEngine(), dir);
  expect(reports()).toEqual(["[done] report\nDone\nFull chat: zoom(\"done\")", '[reader] report\nStopped: the server restarted.\nFull chat: zoom("reader")']);
  expect(next.main.messages).toEqual([]);
  expect(next.subagents.tell("reader", "Go on")).toBe("reader has finished. Spawn a new subagent with the context it needs.");
  await next.hub.close();

  await start(new FakeEngine(), dir);
  expect(reports()).toHaveLength(2);
});

test("a report cancels a goal check before starting its turn", async () => {
  const engine = new FakeEngine();
  engine.onCheck = () => new Promise(() => {});
  const { client, subagents, main } = await start(engine);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  await client.wait("answer", 0, (event) => event.id === "goal");
  await say(client);
  subagents.spawn([{ name: "helper", task: "Help" }]);
  main.emit(END);
  await client.wait("state", 0, (event) => event.state.wait === "goal");
  engine.epochs[1].emit({ ...END, reply: "Done" });
  await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(engine.checks[0].signal.aborted).toBe(true);
  expect(main.messages[1].from).toBe("membr");
});

test("new main input names active subagents and stop-all blocks late delegation", async () => {
  const { client, subagents, main, engine } = await start();
  subagents.spawn([{ name: "helper", task: "Background" }]);
  await say(client, "Continue");
  expect(main.messages[0].text).toBe("Continue\n\nSubagents at work now: helper.");
  const stopped = Promise.withResolvers<void>();
  main.onInterrupt = () => stopped.promise;
  await stop(client, null);
  expect(() => subagents.spawn([{ name: "helper", task: "Too late" }])).toThrow("The chat cannot start subagent work now");
  expect(() => subagents.tell("helper", "Too late")).toThrow("The chat cannot start subagent work now");
  expect(engine.epochs).toHaveLength(2);
  stopped.resolve();
});

test("a subagent report joins a summary wait and reaches the replacement epoch", async () => {
  const held = Promise.withResolvers<string>();
  const engine = new FakeEngine((epoch) => { if (epoch.options.subagents) epoch.emit(END); });
  engine.compact = () => held.promise.then((line) => ({ line, usage: NO_USAGE }));
  const { client, subagents, dir } = await start(engine);
  let waiting = false;
  for (let i = 0; i < 300; i++) {
    const mark = client.events.length;
    await say(client, String(i).padEnd(500, "x"));
    if (client.events.slice(mark).some((event) => event.type === "state" && event.state.wait === "summaries")) { waiting = true; break; }
    await client.wait("state", mark, (event) => !event.state.busy);
  }
  expect(waiting).toBe(true);
  subagents.spawn([{ name: "helper", task: "Work during batch" }]);
  engine.epochs[1].emit({ ...END, reply: "Batch result" });
  const report = await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(engine.epochs[0].messages.some((message) => message.text.includes("Batch result"))).toBe(false);
  const mark = client.events.length;
  held.resolve("small summary");
  await client.wait("state", mark, (event) => !event.state.busy, 10000);
  expect(engine.epochs[2].messages.at(-1)).toEqual({ text: report.entry.text, from: "membr", priority: "next" });
  expect(new Log(defaultStore(dir)).interrupted).toEqual([]);
}, 15000);

test("subagent logs saved in docs/agent move to docs/subagent once, and stay there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-subagents-"));
  dirs.push(dir);
  const old = path.join(defaultStore(dir), "docs", "agent");
  fs.mkdirSync(old, { recursive: true });
  const line = JSON.stringify({ i: 0, kind: "note", text: "subagent", date: "2026-11-06T09:00:00.000Z", from: { machine: "m", seq: 0 } }) + "\n";
  fs.writeFileSync(path.join(old, "old-helper.jsonl"), line);

  const first = await start(new FakeEngine(), dir);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(path.join(defaultStore(dir), "docs/subagent/old-helper.jsonl"))).toBe(true);
  first.client.read({ type: "read", read: "subagent", id: "old", name: "old-helper" });
  expect((await first.client.wait("read", 0, (event) => event.id === "old")).entries).toHaveLength(1);
  await first.hub.close();

  const second = await start(new FakeEngine(), dir);
  second.client.read({ type: "read", read: "subagent", id: "again", name: "old-helper" });
  expect((await second.client.wait("read", 0, (event) => event.id === "again")).entries).toHaveLength(1);
  expect(fs.existsSync(old)).toBe(false);
});
