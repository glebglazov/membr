import { expect, test } from "bun:test";
import type { Act, Entry } from "@membr/protocol";
import { busy, canAsk, canDelegate, closed, next, refusal, turnId, wait, type Facts, type Input, type PendingInput, type Transition, type Turn } from "./src/turn.ts";

const input: PendingInput = { text: "Work", from: "user" };
const idle: Turn = { phase: "idle", attempt: 2 };
const running: Turn = { phase: "running", id: 7, attempt: 2 };
const stopping: Turn = { phase: "stopping", id: 7, attempt: 2 };
const summaries: Turn = { phase: "summaries", id: 7, pending: [input], attempt: 3 };
const checking: Turn = { phase: "checking", revision: 4, goal: "Finish", attempt: 3 };
const failed: Turn = { phase: "failed", reason: "Lost epoch", attempt: 3 };
const closing: Turn = { phase: "closing", attempt: 3 };
const shut: Turn = { phase: "closed", attempt: 3 };
const facts: Facts = { count: 12, goal: { revision: 4, value: "Finish" }, over: () => false };
const usage = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 };
const entry: Entry = { i: 12, kind: "note", text: "Continue", date: "2026-10-25T00:00:00.000Z", from: { machine: "test", seq: 12 } };

const states: Array<{ turn: Turn; busy: boolean; wait: string; id: number; allowed: boolean; closed: boolean }> = [
  { turn: idle, busy: false, wait: "", id: 12, allowed: true, closed: false },
  { turn: running, busy: true, wait: "", id: 7, allowed: true, closed: false },
  { turn: stopping, busy: true, wait: "Stopping", id: 7, allowed: false, closed: false },
  { turn: summaries, busy: true, wait: "summaries", id: 7, allowed: true, closed: false },
  { turn: checking, busy: true, wait: "goal", id: 12, allowed: true, closed: false },
  { turn: failed, busy: false, wait: "", id: 12, allowed: false, closed: false },
  { turn: closing, busy: false, wait: "", id: 12, allowed: false, closed: true },
  { turn: shut, busy: false, wait: "", id: 12, allowed: false, closed: true },
];
for (const row of states) {
  test(`turn queries describe ${row.turn.phase}`, () => {
    expect(busy(row.turn)).toBe(row.busy);
    expect(wait(row.turn)).toBe(row.wait);
    expect(turnId(row.turn, facts.count)).toBe(row.id);
    expect(canDelegate(row.turn)).toBe(row.allowed);
    expect(canAsk(row.turn)).toBe(row.allowed);
    expect(closed(row.turn)).toBe(row.closed);
  });
}

const transitions: Array<{ name: string; turn: Turn; input: Input; expected: Transition }> = [
  { name: "idle input starts now", turn: idle, input: { kind: "start", input, id: 12 }, expected: { turn: { phase: "running", id: 12, attempt: 2 }, effects: [{ kind: "state" }, { kind: "send", input, priority: "now" }] } },
  { name: "running input keeps its turn and goes next", turn: running, input: { kind: "start", input, id: 12 }, expected: { turn: running, effects: [{ kind: "state" }, { kind: "send", input, priority: "next" }] } },
  { name: "summary input waits in order", turn: summaries, input: { kind: "start", input: { text: "Correction", from: "user" }, id: 12 }, expected: { turn: { ...summaries, pending: [input, { text: "Correction", from: "user" }] }, effects: [] } },
  { name: "stop cancels approvals before interrupt", turn: running, input: { kind: "stop", id: 7 }, expected: { turn: stopping, effects: [{ kind: "cancelApprovals" }, { kind: "state" }, { kind: "interrupt", id: 7 }] } },
  { name: "summary stop aborts before finishing", turn: summaries, input: { kind: "stop", id: 7 }, expected: { turn: summaries, effects: [{ kind: "halt" }, { kind: "finish", id: 7, source: "stopped" }] } },
  { name: "old completion updates usage without finishing", turn: running, input: { kind: "ended", done: false, error: null, usage }, expected: { turn: running, effects: [{ kind: "usage", usage }, { kind: "state" }] } },
  { name: "completion during stop waits for interrupt", turn: stopping, input: { kind: "ended", done: true, error: null, usage }, expected: { turn: stopping, effects: [{ kind: "usage", usage }, { kind: "state" }] } },
  { name: "successful completion writes before changing phase", turn: running, input: { kind: "ended", done: true, error: null, usage }, expected: { turn: running, effects: [{ kind: "usage", usage }, { kind: "finish", id: 7, reason: undefined, source: "ended" }] } },
  { name: "failed completion keeps the error text", turn: running, input: { kind: "ended", done: true, error: "Outage", usage }, expected: { turn: running, effects: [{ kind: "usage", usage }, { kind: "finish", id: 7, reason: "The turn failed: Outage", source: "ended" }] } },
  { name: "finished turn begins a goal check", turn: running, input: { kind: "finished", source: "ended", entry: null, error: false }, expected: { turn: checking, effects: [{ kind: "afterHook" }, { kind: "checkGoal", goal: "Finish", attempt: 3 }, { kind: "state" }] } },
  { name: "failed completion skips the goal check", turn: running, input: { kind: "finished", source: "ended", entry, error: true }, expected: { turn: idle, effects: [{ kind: "afterHook" }, { kind: "record", entry }, { kind: "state" }] } },
  { name: "stopped completion skips the goal check", turn: stopping, input: { kind: "finished", source: "stopped", entry: null, error: false }, expected: { turn: idle, effects: [{ kind: "afterHook" }, { kind: "state" }] } },
  { name: "matching interrupt finishes the turn", turn: stopping, input: { kind: "interrupted", id: 7 }, expected: { turn: stopping, effects: [{ kind: "finish", id: 7, source: "interrupted" }] } },
  { name: "old interrupt cannot finish another turn", turn: stopping, input: { kind: "interrupted", id: 6 }, expected: { turn: stopping, effects: [] } },
  { name: "late interrupt cannot clear failure", turn: failed, input: { kind: "interrupted", id: 7 }, expected: { turn: failed, effects: [] } },
  { name: "continued goal owns its log entry before recording", turn: checking, input: { kind: "continued", entry }, expected: { turn: { phase: "running", id: 12, attempt: 3 }, effects: [{ kind: "record", entry }, { kind: "dispatch", input: { kind: "continueRecorded", id: 12 } }] } },
  { name: "stopped agent report is recorded without delivery", turn: running, input: { kind: "report", text: "Stopped", stopped: true }, expected: { turn: running, effects: [{ kind: "work", text: "Stopped", id: null }] } },
  { name: "agent report joins the active turn", turn: running, input: { kind: "report", text: "Done", stopped: false }, expected: { turn: running, effects: [{ kind: "work", text: "Done", id: 7 }] } },
  { name: "closed chat ignores agent reports", turn: shut, input: { kind: "report", text: "Done", stopped: false }, expected: { turn: shut, effects: [] } },
  { name: "first failure is preserved", turn: failed, input: { kind: "fail", error: new Error("Later") }, expected: { turn: failed, effects: [] } },
];
for (const row of transitions) {
  test(row.name, () => {
    const before = structuredClone(row.turn);
    expect(next(row.turn, row.input, facts)).toEqual(row.expected);
    expect(row.turn).toEqual(before);
  });
}

for (const turn of [idle, running, summaries]) {
  test(`only idle input checks the view limit from ${turn.phase}`, () => {
    const calls: number[] = [];
    const result = next(turn, { kind: "start", input, id: 12 }, { ...facts, over: (id) => { calls.push(id); return true; } });
    expect(calls).toEqual(turn.phase === "idle" ? [12] : []);
    if (turn.phase === "idle") {
      expect(result).toEqual({ turn: { phase: "summaries", id: 12, pending: [input], attempt: 3 }, effects: [{ kind: "state" }, { kind: "batch", id: 12, attempt: 3 }] });
    }
  });
}

test("a failed view limit check leaves the durable turn available for failure handling", () => {
  const error = new Error("View failed");
  expect(next(idle, { kind: "start", input, id: 12 }, { ...facts, over: () => { throw error; } })).toEqual({
    turn: { phase: "running", id: 12, attempt: 2 }, effects: [{ kind: "fail", error }],
  });
});

for (const turn of [idle, running, checking, summaries, failed, closing, shut]) {
  test(`old background results have no effect in ${turn.phase}`, () => {
    const inputs: Input[] = [
      { kind: "batched", attempt: 1 }, { kind: "rotated", attempt: 1 },
      { kind: "checked", attempt: 1, met: false }, { kind: "checkFailed", attempt: 1, error: new Error("Late") },
    ];
    for (const input of inputs) expect(next(turn, input, facts)).toEqual({ turn, effects: [] });
  });
}

test("a changed goal revision rejects an otherwise current goal check", () => {
  expect(next(checking, { kind: "checked", attempt: 3, met: true }, { ...facts, goal: { revision: 5, value: "Finish" } })).toEqual({ turn: checking, effects: [] });
});

test("a batch sends all pending input in order after epoch replacement", () => {
  const second: PendingInput = { text: "Report", from: "membr" };
  expect(next({ ...summaries, pending: [input, second] }, { kind: "rotated", attempt: 3 }, facts)).toEqual({
    turn: { phase: "running", id: 7, attempt: 3 },
    effects: [{ kind: "send", input, priority: "now" }, { kind: "send", input: second, priority: "next" }, { kind: "state" }],
  });
});

const say: Act = { type: "act", act: "say", id: "say", text: "Work" };
const pick: Act = { type: "act", act: "pick", id: "pick", pick: { model: "other", effort: "high", fast: false } };
for (const row of [
  { turn: idle, act: say, reason: undefined },
  { turn: stopping, act: say, reason: "The turn is stopping. Send the message again with a new act id." },
  { turn: idle, act: pick, reason: "Model other is not offered" },
  { turn: failed, act: pick, reason: "Lost epoch" },
  { turn: closing, act: pick, reason: "The chat is closed" },
  { turn: shut, act: say, reason: "The chat is closed" },
]) {
  test(`refusal for ${row.act.act} in ${row.turn.phase}`, () => expect(refusal(row.turn, row.act)).toBe(row.reason));
}
