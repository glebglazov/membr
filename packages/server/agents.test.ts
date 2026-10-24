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
  const hub = serveHub({ dir, port: 0, engine, config: { rulesText: "Keep the project rules.", afterCommand: "" } });
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
  expect(agents.spawn(["Find the answer"], "low")).toStartWith("Started Agent1.");
  const child = engine.epochs[1];
  expect(child.options.agents).toBeUndefined();
  expect(child.options.append).toContain("Keep the project rules.");
  expect(child.options.append).toContain("Your final reply is your report to membr.");
  expect(child.options.pick.effort).toBe("low");
  expect(child.messages[0]).toEqual({ text: "Find the answer", priority: "now", from: "membr" });
  expect(fs.readFileSync(path.join(dir, "docs/agent/Agent1.jsonl"), "utf8")).toContain("Find the answer");
  main.emit(END);
  await client.wait("state", 0, (event) => !event.state.busy && event.state.agents.includes("Agent1"));
  const mark = client.events.length;
  child.emit({ kind: "text", text: "The answer is 42." }, { ...END, reply: "The answer is 42." });
  const report = await client.wait("entry", mark, (event) => event.entry.kind === "work");
  expect(report.entry.text).toContain('[Agent1] report\nThe answer is 42.\nFull chat: zoom("Agent1")');
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
  agents.spawn(["First task"]);
  const child = engine.epochs[1];
  child.emit({ kind: "tool", id: "one", name: "Read", input: { file: "first" } });
  await client.wait("agent-entry", 0, (event) => event.entry.kind === "tool");
  expect(agents.tell("Agent1", "Second task")).toContain("between its tool calls");
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
  agents.spawn(["Read this"]);
  const child = engine.epochs[1];
  child.emit({ kind: "text", text: "Saved reply" }, { kind: "delta", text: "Live reply" });
  expect((await client.wait("live", 0, (event) => event.agent === "Agent1")).text).toBe("Live reply");
  client.read({ type: "read", read: "agent", id: "agent", name: "Agent1" });
  const log = await client.wait("read", 0, (event) => event.id === "agent");
  expect(log.live).toBe("Live reply");
  expect(memory.zoom("Agent1").text).toBe(log.entries.map((entry) => `${entry.i}|${entry.kind}: ${entry.text}`).join("\n\n"));
  expect(client.events.some((event) => event.type === "entry" && event.entry.text === "Saved reply")).toBe(false);
  expect(memory.zoom("../secret").error).toBe(true);
  expect(agents.tell("../secret", "read")).toBe("No agent ../secret to tell.");
  child.emit({ kind: "text", text: "x".repeat(40000) });
  await client.wait("agent-entry", 0, (event) => event.entry.text.length === 40000);
  const first = memory.zoom("Agent1").text;
  const more = /go on with at (\d+)\]/.exec(first);
  expect(more).not.toBeNull();
  const at = Number(more?.[1]);
  expect(memory.zoom("Agent1", 1, at).text.length).toBeGreaterThan(0);
});

test("named stop cancels only its agent and its approvals, all stop cancels every session", async () => {
  const { client, main, agents, engine } = await start();
  await say(client);
  agents.spawn(["One", "Two"]);
  const one = engine.epochs[1], two = engine.epochs[2];
  const decisions = [main.options.ask!("Bash", { command: "main" }), one.options.ask!("Bash", { command: "one" }), two.options.ask!("Bash", { command: "two" })];
  await client.wait("ask", 0, (event) => event.input.command === "two");
  const mark = client.events.length;
  await stop(client, "Agent1");
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

test("a stale stop failure does not close a new agent session", async () => {
  const { client, agents, engine } = await start();
  agents.spawn(["First task"]);
  const old = engine.epochs[1];
  const interrupt = Promise.withResolvers<void>();
  old.onInterrupt = () => interrupt.promise;

  await stop(client, "Agent1");
  old.fail(new Error("Old session failed"));
  await client.wait("entry", 0, (event) => event.entry.kind === "work" && event.entry.text.includes("Old session failed"));

  expect(agents.tell("Agent1", "Second task")).toContain("reply will reach you");
  const fresh = engine.epochs[2];
  const mark = client.events.length;
  interrupt.reject(new Error("Old interrupt failed"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(fresh.closed).toBe(false);
  expect(client.events.slice(mark).some((event) => event.type === "entry" && event.entry.kind === "work" && event.entry.text.includes("Old interrupt failed"))).toBe(false);
  fresh.emit({ ...END, reply: "Second result" });
  const report = await client.wait("entry", mark, (event) => event.entry.kind === "work" && event.entry.text.includes("Second result"));
  expect(report.entry.text).not.toContain("Old interrupt failed");
});

test("tell retains an idle session and opens saved history after restart", async () => {
  const { client, agents, engine, hub, dir } = await start();
  agents.spawn(["Initial task"], "medium");
  const child = engine.epochs[1];
  child.emit({ kind: "text", text: "Saved result" }, { ...END, reply: "Saved result" });
  await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(agents.tell("Agent1", "Resume")).toContain("reply will reach you");
  expect(engine.epochs).toHaveLength(2);
  expect(child.messages[1].priority).toBe("now");
  await hub.close();
  fs.appendFileSync(path.join(dir, "docs/agent/Agent1.jsonl"), '{"partial":');
  const next = await start(new FakeEngine(), dir);
  expect(next.agents.tell("Agent1", "After restart")).toContain("reply will reach you");
  expect(next.engine.epochs[1].view).toContain("Saved result");
  expect(next.engine.epochs[1].view).toContain("Resume");
  expect(next.engine.epochs[1].options.pick.effort).toBe("medium");
  expect(next.engine.epochs[1].messages[0].from).toBe("membr");
  expect(next.agents.spawn(["Another task"])).toStartWith("Started Agent2.");
});

test("a report cancels a goal check before starting its turn", async () => {
  const engine = new FakeEngine();
  engine.onCheck = () => new Promise(() => {});
  const { client, agents, main } = await start(engine);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  await client.wait("answer", 0, (event) => event.id === "goal");
  await say(client);
  agents.spawn(["Help"]);
  main.emit(END);
  await client.wait("state", 0, (event) => event.state.wait === "goal");
  engine.epochs[1].emit({ ...END, reply: "Done" });
  await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(engine.checks[0].signal.aborted).toBe(true);
  expect(main.messages[1].from).toBe("membr");
});

test("new main input names active agents and stop-all blocks late delegation", async () => {
  const { client, agents, main, engine } = await start();
  agents.spawn(["Background"]);
  await say(client, "Continue");
  expect(main.messages[0].text).toBe("Continue\n\nAgents at work now: Agent1.");
  const stopped = Promise.withResolvers<void>();
  main.onInterrupt = () => stopped.promise;
  await stop(client, null);
  expect(() => agents.spawn(["Too late"])).toThrow("The chat cannot start agent work now");
  expect(() => agents.tell("Agent1", "Too late")).toThrow("The chat cannot start agent work now");
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
  agents.spawn(["Work during batch"]);
  engine.epochs[1].emit({ ...END, reply: "Batch result" });
  const report = await client.wait("entry", 0, (event) => event.entry.kind === "work");
  expect(engine.epochs[0].messages.some((message) => message.text.includes("Batch result"))).toBe(false);
  const mark = client.events.length;
  held.resolve("small summary");
  await client.wait("state", mark, (event) => !event.state.busy, 10000);
  expect(engine.epochs[2].messages.at(-1)).toEqual({ text: report.entry.text, from: "membr", priority: "next" });
  expect(new Log(dir).interrupted).toEqual([]);
}, 15000);
