import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
async function start(engine = new FakeEngine(), existing?: string) {
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), "membr-agents-"));
  if (!existing) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine, config: () => ({ home: null, rulesText: "Keep the project rules.", afterCommand: "", approvalTimeout: 600_000, listen: { port: 0, host: "127.0.0.1", tailscale: false } }) });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  const main = engine.epochs[0];
  const agents = main.options.agents;
  if (!agents || !main.options.memory) throw new Error("Missing tools");
  return { dir, hub, client, engine, main, agents, memory: main.options.memory };
}
async function say(client: TestClient, text = "Work") {
  const id = crypto.randomUUID();
  client.act({ type: "act", act: "say", id, text });
  await client.wait("answer", 0, (event) => event.id === id);
}
async function stop(client: TestClient, agent: string | null) {
  const id = crypto.randomUUID();
  client.act({ type: "act", act: "stop", id, agent });
  expect((await client.wait("answer", 0, (event) => event.id === id)).ok).toBe(true);
}

test("an agent report starts a main turn after the main turn ends", async () => {
  const { client, main, agents, engine, dir } = await start();
  await say(client);
  expect(agents.spawn([{ name: "helper", task: "Find the answer" }], "low")).toStartWith("Started helper.");
  const child = engine.epochs[1];
  expect(child.options.agents).toBeUndefined();
  expect(child.options.append).toContain("Keep the project rules.");
  expect(child.options.append).toContain("Your final reply is your report to membr.");
  expect(child.options.pick.effort).toBe("low");
  expect(child.messages[0]).toEqual({ text: "Find the answer", priority: "now", from: "membr" });
  expect(fs.readFileSync(path.join(dir, "docs/agent/helper.jsonl"), "utf8")).toContain("Find the answer");
  main.emit(END);
  await client.wait("state", 0, (event) => !event.state.busy && event.state.agents.includes("helper"));
  const mark = client.events.length;
  child.emit({ kind: "text", text: "The answer is 42." }, { ...END, reply: "The answer is 42." });
  const report = await client.wait("entry", mark, (event) => event.entry.kind === "work");
  expect(report.entry.text).toContain('[helper] report\nThe answer is 42.\nFull chat: zoom("helper")');
  await client.wait("state", mark, (event) => event.state.busy && !event.state.agents.length);
  expect(main.messages[1]).toEqual({ text: report.entry.text, priority: "now", from: "membr" });
  expect(new Log(dir).interrupted).toEqual([report.entry.i]);
  const finished = client.events.length;
  main.emit(END);
  await client.wait("state", finished, (event) => !event.state.busy && !event.state.agents.length);
  expect(new Log(dir).interrupted).toEqual([]);
});

test("tell joins running input and stale completion does not report early", async () => {
  const { client, agents, engine, main, dir } = await start();
  await say(client);
  agents.spawn([{ name: "helper", task: "First task" }]);
  const child = engine.epochs[1];
  child.emit({ kind: "tool", id: "one", name: "Read", input: { file: "first" } });
  await client.wait("agent-entry", 0, (event) => event.entry.kind === "tool");
  expect(agents.tell("helper", "Second task")).toContain("between its tool calls");
  expect(child.messages[1]).toEqual({ text: "Second task", priority: "next", from: "membr" });
  child.emit({ ...END, through: 1, reply: "First result" }, { kind: "tool", id: "two", name: "Read", input: {} });
  await client.wait("agent-entry", 0, (event) => event.entry.text.includes('"two"'));
  expect(client.events.filter((event) => event.type === "entry" && event.entry.kind === "work")).toHaveLength(0);
  child.emit({ ...END, through: 2, reply: "Second result" });
  const report = await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(report.entry.text).toContain("First result\n\nSecond result");
  expect(main.messages[1].priority).toBe("next");
  main.emit(END);
  await client.wait("state", 0, (event) => !event.state.busy && !event.state.agents.length && event.state.usage !== null);
  expect(new Log(dir).interrupted).toEqual([]);
});

test("named zoom and client reads use the saved agent log and live snapshot", async () => {
  const { client, agents, engine, memory } = await start();
  agents.spawn([{ name: "helper", task: "Read this" }]);
  const child = engine.epochs[1];
  child.emit({ kind: "text", text: "Saved reply" }, { kind: "delta", text: "Live reply" });
  expect((await client.wait("live", 0, (event) => event.agent === "helper")).text).toBe("Live reply");
  client.read({ type: "read", read: "agent", id: "agent", name: "helper" });
  const log = await client.wait("read", 0, (event) => event.id === "agent");
  expect(log.live).toBe("Live reply");
  expect(memory.zoom("helper").text).toBe(log.entries.map((entry) => `${entry.i}|${entry.kind}: ${entry.text}`).join("\n\n"));
  expect(client.events.some((event) => event.type === "entry" && event.entry.text === "Saved reply")).toBe(false);
  expect(memory.zoom("../secret").error).toBe(true);
  expect(agents.tell("../secret", "read")).toBe("No agent ../secret to tell.");
  child.emit({ kind: "text", text: "x".repeat(40000) });
  await client.wait("agent-entry", 0, (event) => event.entry.text.length === 40000);
  const first = memory.zoom("helper").text;
  const more = /go on with at (\d+)\]/.exec(first);
  expect(more).not.toBeNull();
  const at = Number(more?.[1]);
  expect(memory.zoom("helper", 1, at).text.length).toBeGreaterThan(0);
});

test("named stop cancels only its agent and its approvals, all stop cancels every session", async () => {
  const { client, main, agents, engine } = await start();
  await say(client);
  agents.spawn([{ name: "One", task: "One" }, { name: "Two", task: "Two" }]);
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
  await client.wait("state", end, (event) => !event.state.busy && !event.state.agents.length);
  expect(main.interrupts).toBe(1);
  expect(two.interrupts).toBe(1);
  expect(main.messages).toHaveLength(1);
});

test("a stale stop failure does not report the agent twice", async () => {
  const { client, agents, engine } = await start();
  agents.spawn([{ name: "helper", task: "First task" }]);
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

test("a finished agent closes its session and takes no more work", async () => {
  const { client, agents, engine } = await start();
  expect(agents.spawn([{ name: "Store Reader!", task: "Initial task" }], "medium")).toStartWith("Started store-reader.");
  const child = engine.epochs[1];
  expect(child.view).toEndWith("You are subagent store-reader.");
  child.emit({ kind: "text", text: "Saved result" }, { ...END, reply: "Saved result" });
  await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(child.closed).toBe(true);
  expect(agents.tell("store-reader", "Resume")).toBe("store-reader has finished. Spawn a new agent with the context it needs.");
  expect(engine.epochs).toHaveLength(2);
  expect(agents.spawn([{ name: "store-reader", task: "Next task" }, { name: "42", task: "Odd name" }])).toStartWith("Started store-reader-2, agent.");
});

test("a restart records once each agent it stopped mid-run", async () => {
  const { client, agents, engine, hub, dir } = await start();
  agents.spawn([{ name: "done", task: "Short task" }, { name: "reader", task: "Long task" }]);
  engine.epochs[1].emit({ ...END, reply: "Done" });
  engine.epochs[2].emit({ kind: "tool", id: "one", name: "Read", input: {} });
  await client.wait("agent-entry", 0, (event) => event.name === "reader" && event.entry.kind === "tool");
  await hub.close();
  fs.appendFileSync(path.join(dir, "docs/agent/reader.jsonl"), '{"partial":');

  const reports = () => new Log(dir).entries.filter((entry) => entry.kind === "work").map((entry) => entry.text);
  const next = await start(new FakeEngine(), dir);
  expect(reports()).toEqual(["[done] report\nDone\nFull chat: zoom(\"done\")", '[reader] report\nStopped: the server restarted.\nFull chat: zoom("reader")']);
  expect(next.main.messages).toEqual([]);
  expect(next.agents.tell("reader", "Go on")).toBe("reader has finished. Spawn a new agent with the context it needs.");
  await next.hub.close();

  await start(new FakeEngine(), dir);
  expect(reports()).toHaveLength(2);
});

test("a report cancels a goal check before starting its turn", async () => {
  const engine = new FakeEngine();
  engine.onCheck = () => new Promise(() => {});
  const { client, agents, main } = await start(engine);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  await client.wait("answer", 0, (event) => event.id === "goal");
  await say(client);
  agents.spawn([{ name: "helper", task: "Help" }]);
  main.emit(END);
  await client.wait("state", 0, (event) => event.state.wait === "goal");
  engine.epochs[1].emit({ ...END, reply: "Done" });
  await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(engine.checks[0].signal.aborted).toBe(true);
  expect(main.messages[1].from).toBe("membr");
});

test("new main input names active agents and stop-all blocks late delegation", async () => {
  const { client, agents, main, engine } = await start();
  agents.spawn([{ name: "helper", task: "Background" }]);
  await say(client, "Continue");
  expect(main.messages[0].text).toBe("Continue\n\nAgents at work now: helper.");
  const stopped = Promise.withResolvers<void>();
  main.onInterrupt = () => stopped.promise;
  await stop(client, null);
  expect(() => agents.spawn([{ name: "helper", task: "Too late" }])).toThrow("The chat cannot start agent work now");
  expect(() => agents.tell("helper", "Too late")).toThrow("The chat cannot start agent work now");
  expect(engine.epochs).toHaveLength(2);
  stopped.resolve();
});

test("an agent report joins a summary wait and reaches the replacement epoch", async () => {
  const held = Promise.withResolvers<string>();
  const engine = new FakeEngine((epoch) => { if (epoch.options.agents) epoch.emit(END); });
  engine.compact = () => held.promise;
  const { client, agents, dir } = await start(engine);
  let waiting = false;
  for (let i = 0; i < 300; i++) {
    const mark = client.events.length;
    await say(client, String(i).padEnd(500, "x"));
    if (client.events.slice(mark).some((event) => event.type === "state" && event.state.wait === "summaries")) { waiting = true; break; }
    await client.wait("state", mark, (event) => !event.state.busy);
  }
  expect(waiting).toBe(true);
  agents.spawn([{ name: "helper", task: "Work during batch" }]);
  engine.epochs[1].emit({ ...END, reply: "Batch result" });
  const report = await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(engine.epochs[0].messages.some((message) => message.text.includes("Batch result"))).toBe(false);
  const mark = client.events.length;
  held.resolve("small summary");
  await client.wait("state", mark, (event) => !event.state.busy, 10000);
  expect(engine.epochs[2].messages.at(-1)).toEqual({ text: report.entry.text, from: "membr", priority: "next" });
  expect(new Log(dir).interrupted).toEqual([]);
}, 15000);
