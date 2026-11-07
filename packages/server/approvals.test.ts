import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Event } from "@membr/protocol";
import { Approvals } from "./src/approvals.ts";
import type { Clock } from "./src/clock.ts";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { TestClient } from "./test/client.ts";
import { FakeEngine } from "./test/engine.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function serve(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-approvals-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const engine = new FakeEngine();
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  const ask = engine.epochs[0].options.ask;
  if (!ask) throw new Error("The approval callback is missing");
  return { ...hub, engine, dir, ask };
}

async function connect(hub: ReturnType<typeof serve>) {
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return client;
}

for (const choice of ["once", "deny"] as const) {
  test(`${choice} decides once and closes the ask on every client`, async () => {
    const hub = serve();
    const a = await connect(hub);
    const b = await connect(hub);
    const decision = hub.ask("Bash", { command: "echo hello" });
    const ask = await a.wait("ask");
    expect(await b.wait("ask")).toEqual(ask);
    for (const client of [a, b]) expect(client.events.filter((event) => event.type === "ask")).toHaveLength(1);
    const answer = { type: "act", act: "answer", id: "winner", approval: ask.id, choice } as const;
    a.act(answer);
    b.act({ ...answer, id: "loser", choice: "always" });
    expect(await a.wait("answer")).toEqual({ type: "answer", id: "winner", ok: true, entry: null });
    expect((await b.wait("answer")).ok).toBe(false);
    expect(await decision).toBe(choice === "once");
    for (const client of [a, b]) expect(await client.wait("ask-closed")).toEqual({ type: "ask-closed", id: ask.id });
    const mark = b.events.length;
    b.act(answer);
    expect(await b.wait("answer", mark)).toEqual({ type: "answer", id: "winner", ok: true, entry: null });
    const next = hub.ask("Bash", { command: "echo hello" });
    const again = await b.wait("ask", mark);
    b.act({ ...answer, id: "next", approval: again.id, choice: "deny" });
    await b.wait("answer", mark, (event) => event.id === "next");
    expect(await next).toBe(false);
    expect(b.events.slice(mark).filter((event) => event.type === "ask-closed")).toHaveLength(1);
  });
}

test("Always saves an exact allow rule with its answer and restores both after restart", async () => {
  const hub = serve();
  const a = await connect(hub);
  const decision = hub.ask("Bash", { command: "echo hello", nested: { b: 2, a: [1, 2] } });
  const ask = await a.wait("ask");
  const act = { type: "act", act: "answer", id: "always", approval: ask.id, choice: "always" } as const;
  a.act(act);
  const answer = await a.wait("answer");
  expect(answer.ok).toBe(true);
  expect(await decision).toBe(true);
  const mark = a.events.length;
  expect(await hub.ask("Bash", { nested: { a: [1, 2], b: 2 }, command: "echo hello" })).toBe(true);
  hub.close();
  const after = serve(hub.dir);
  const b = await connect(after);
  b.act({ ...act, choice: "deny" });
  expect(await b.wait("answer")).toEqual(answer);
  expect(await after.ask("Bash", { nested: { a: [1, 2], b: 2 }, command: "echo hello" })).toBe(true);
  expect(a.events.slice(mark).filter((event) => event.type === "ask")).toHaveLength(0);
  expect(b.events.filter((event) => event.type === "ask")).toHaveLength(0);
  for (const [tool, input] of [["Read", { command: "echo hello", nested: { b: 2, a: [1, 2] } }], ["Bash", { command: "echo different", nested: { b: 2, a: [1, 2] } }], ["Bash", { command: "echo hello", nested: { b: 2, a: [2, 1] } }]] as const) {
    const from = b.events.length;
    const pending = after.ask(tool, input);
    const request = await b.wait("ask", from);
    b.act({ ...act, id: crypto.randomUUID(), approval: request.id, choice: "deny" });
    await b.wait("answer", from);
    expect(await pending).toBe(false);
  }
});

test("a new client receives only the pending asks", async () => {
  const hub = serve();
  const a = await connect(hub);
  const decision = hub.ask("Write", { file_path: "/example" });
  const ask = await a.wait("ask");
  const late = await connect(hub);
  expect(await late.wait("ask")).toEqual(ask);
  late.act({ type: "act", act: "answer", id: "late", approval: ask.id, choice: "once" });
  await late.wait("answer");
  expect(await decision).toBe(true);
  const later = await connect(hub);
  expect(later.events.filter((event) => event.type === "ask")).toHaveLength(0);
});

for (const ending of ["abort", "stop", "close", "failure"] as const) {
  test(`${ending} denies pending asks and prevents late answers`, async () => {
    const hub = serve();
    const a = await connect(hub);
    const epoch = hub.engine.epochs[0];
    a.act({ type: "act", act: "say", id: "start", text: "Work" });
    await a.wait("answer");
    const controller = new AbortController();
    const pending = hub.ask("Write", { file_path: "/example" }, controller.signal);
    const ask = await a.wait("ask");
    const interrupt = Promise.withResolvers<void>();
    if (ending === "abort") controller.abort();
    if (ending === "close") hub.close();
    if (ending === "failure") epoch.fail(new Error("Scripted failure"));
    if (ending === "stop") {
      epoch.onInterrupt = () => interrupt.promise;
      a.act({ type: "act", act: "stop", id: "stop", subagent: null });
      await a.wait("answer", 0, (event) => event.id === "stop");
    }
    expect(await pending).toBe(false);
    if (ending !== "close") {
      expect(await a.wait("ask-closed")).toEqual({ type: "ask-closed", id: ask.id });
      a.act({ type: "act", act: "answer", id: "too-late", approval: ask.id, choice: "always" });
      expect((await a.wait("answer", 0, (event) => event.id === "too-late")).ok).toBe(false);
    }
    if (ending !== "abort") {
      expect(await hub.ask("Read", { file_path: "/late" })).toBe(false);
      if (ending === "stop") interrupt.resolve();
    }
  });
}

test("an already aborted request sends no ask", async () => {
  const hub = serve();
  const client = await connect(hub);
  expect(await hub.ask("Bash", { command: "echo hello" }, AbortSignal.abort())).toBe(false);
  const late = await connect(hub);
  expect(client.events.filter((event) => event.type === "ask")).toHaveLength(0);
  expect(late.events.filter((event) => event.type === "ask")).toHaveLength(0);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeClock implements Clock {
  time = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  private next = 0;
  now() { return this.time; }
  wake(ms: number, run: () => void) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return () => { this.timers.delete(id); };
  }
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].run();
    }
    this.time = end;
  }
}

function limited(limit = 600_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-approvals-"));
  dirs.push(dir);
  const clock = new FakeClock(), notes: string[] = [], events: Event[] = [];
  const state = { limit };
  const approvals = new Approvals(new Log(dir), (event) => events.push(event), () => state.limit, (text) => notes.push(text), clock);
  const settled = (promise: Promise<boolean>) => { const box: { value?: boolean } = {}; void promise.then((v) => { box.value = v; }); return box; };
  return { approvals, clock, notes, events, state, settled };
}

test("an unattended ask is denied at the limit with a note, and an interactive ask keeps waiting", async () => {
  const { approvals, clock, notes, events, settled } = limited();
  const unattended = settled(approvals.ask("Bash", { command: "rm x" }, undefined, true));
  const interactive = settled(approvals.ask("Bash", { command: "ls" }));
  clock.advance(599_999);
  await flush();
  expect(unattended.value).toBeUndefined();
  expect(notes).toEqual([]);
  clock.advance(1);
  await flush();
  expect(unattended.value).toBe(false);
  expect(notes).toEqual(["Nobody answered the approval for Bash within 10m, so membr denied it."]);
  expect(events.filter((event) => event.type === "ask-closed")).toHaveLength(1);
  clock.advance(10 * 3_600_000);
  await flush();
  expect(interactive.value).toBeUndefined();
  expect(approvals.requests).toHaveLength(1);
});

test("an unattended ask answered in time is not denied later", async () => {
  const { approvals, clock, notes, events, settled } = limited();
  const decision = settled(approvals.ask("Read", { file_path: "/a" }, undefined, true));
  const ask = events.find((event) => event.type === "ask")!;
  approvals.answer({ type: "act", id: "x", act: "answer", approval: (ask as { id: string }).id, choice: "once" }, 0);
  clock.advance(3_600_000);
  await flush();
  expect(decision.value).toBe(true);
  expect(notes).toEqual([]);
});

test("a reload to a shorter limit denies an older unattended ask at once, and a longer one extends it", async () => {
  const { approvals, clock, notes, state, settled } = limited();
  const old = settled(approvals.ask("Bash", { command: "a" }, undefined, true));
  clock.advance(300_000);
  const fresh = settled(approvals.ask("Bash", { command: "b" }, undefined, true));
  state.limit = 60_000;
  approvals.rearm();
  await flush();
  expect(old.value).toBe(false);
  expect(fresh.value).toBeUndefined();
  expect(notes).toEqual(["Nobody answered the approval for Bash within 1m, so membr denied it."]);
  clock.advance(60_000);
  await flush();
  expect(fresh.value).toBe(false);
  expect(notes).toHaveLength(2);

  state.limit = 600_000;
  const extended = settled(approvals.ask("Bash", { command: "c" }, undefined, true));
  clock.advance(500_000);
  state.limit = 3_600_000;
  approvals.rearm();
  clock.advance(600_000);
  await flush();
  expect(extended.value).toBeUndefined();
  clock.advance(3_000_000);
  await flush();
  expect(extended.value).toBe(false);
  expect(notes.at(-1)).toBe("Nobody answered the approval for Bash within 1h, so membr denied it.");
});
