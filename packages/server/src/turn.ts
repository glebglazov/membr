import { epochLimit, type Act, type ChatStatus, type Entry, type State, type Usage } from "@membr/protocol";
import type { Context, From, Priority } from "./engine.ts";
import type { Image } from "./images.ts";
import type { FireRecord, Log } from "./log.ts";

// fire marks an input a schedule sent while nobody was at the screen.
export type FireTag = { schedule: string };
export type PendingInput = { text: string; from: From; images?: Image[]; fire?: FireTag };
// reopen marks a new home or new rules that the open epoch does not have yet, or an epoch too full for more turns.
export type Turn = { attempt: number; reopen?: true } & (
  | { phase: "idle" }
  | { phase: "running" | "stopping"; id: number; scheduled?: string }
  | { phase: "summaries"; id: number; pending: PendingInput[] }
  | { phase: "checking"; revision: number; goal: string; scheduled?: string }
  | { phase: "failed"; reason: string }
  | { phase: "closing" | "closed" }
);
export type Facts = { count: number; goal: Log["goal"]; over(id: number): boolean };
export type Input =
  | { kind: "prepare"; act: Act["act"] }
  | { kind: "actFailed"; say: boolean; id: number; error: unknown }
  | { kind: "start"; input: PendingInput; id: number }
  | { kind: "stop"; id: number }
  | { kind: "interrupted"; id: number }
  | { kind: "ended"; done: boolean; error: string | null; usage: Usage; context: Context }
  | { kind: "finished"; source: "ended" | "stopped" | "interrupted" | "failed"; entry: Entry | null; error: boolean }
  | { kind: "batched" | "rotated"; attempt: number }
  | { kind: "checked"; attempt: number; met: boolean }
  | { kind: "checkFailed"; attempt: number; error: unknown }
  | { kind: "continued"; entry: Entry }
  | { kind: "continueRecorded"; id: number }
  | { kind: "report"; text: string; stopped: boolean; schedule?: string; record?: FireRecord }
  | { kind: "fail"; error: unknown }
  | { kind: "failed"; previous: Turn; reason: string }
  | { kind: "reload" | "reopen" }
  | { kind: "idle" | "state" | "close" | "closing" | "closed" };
export type Effect =
  | { kind: "halt" | "cancelApprovals" | "closeSubagents" | "closeEpoch" | "state" }
  | { kind: "dispatch" | "defer"; input: Input }
  | { kind: "finish"; id: number; reason?: string; source: "ended" | "stopped" | "interrupted" | "failed" }
  | { kind: "send"; input: PendingInput; priority: Priority }
  | { kind: "batch"; id: number; attempt: number }
  | { kind: "openEpoch"; id: number }
  | { kind: "checkGoal"; goal: string; attempt: number }
  | { kind: "interrupt"; id: number }
  | { kind: "error"; reason: string }
  | { kind: "fail"; error: unknown }
  | { kind: "usage"; usage: Usage; context: Context }
  | { kind: "record"; entry: Entry }
  | { kind: "note"; text: string }
  | { kind: "completeGoal"; revision: number }
  | { kind: "continueGoal"; text: string }
  | { kind: "work"; text: string; id: number | null; fire?: FireTag; record?: FireRecord };
export type Transition = { turn: Turn; effects: Effect[] };
const MODELS: readonly string[] = ["opus", "sonnet", "haiku"];
const GOAL_NO = "The goal isn't satisfied yet: keep working.";
const FULL = "The epoch was full, so membr opened a new one. Send your message again.";

// The summary batch counts the view, not the raw tool output inside the epoch, so an epoch can fill before a batch.
// From the epoch limit it gets a new epoch while the next turn still fits; a turn that overflows gets one too.
function full(context: Context): boolean { return context === "overflow" || (context !== null && context.used >= epochLimit(context.window)); }

export function closed(turn: Turn): boolean { return turn.phase === "closing" || turn.phase === "closed"; }
export function turnId(turn: Turn, count: number): number { return turn.phase === "running" || turn.phase === "stopping" || turn.phase === "summaries" ? turn.id : count; }
// What the chat asks of the person: an approval to answer first, then work in flight, then how the last turn ended.
export function status(turn: Turn, ending: "done" | "failed" | null, asking: boolean): ChatStatus | null {
  if (asking) return "blocked";
  if (busy(turn)) return "working";
  return turn.phase === "failed" ? "failed" : ending;
}
export function busy(turn: Turn): boolean { return turn.phase === "running" || turn.phase === "stopping" || turn.phase === "summaries" || turn.phase === "checking"; }
export function wait(turn: Turn): State["wait"] { return turn.phase === "summaries" ? "summaries" : turn.phase === "checking" ? "goal" : turn.phase === "stopping" ? "Stopping" : ""; }
export function canDelegate(turn: Turn): boolean { return !closed(turn) && turn.phase !== "stopping" && turn.phase !== "failed"; }
export function canAsk(turn: Turn): boolean { return canDelegate(turn); }
// A turn is scheduled while every input in it carried a fire tag. Its asks then have a time limit.
export function unattended(turn: Turn): boolean { return turn.phase === "running" && turn.scheduled !== undefined; }
const tagged = (schedule: string | undefined): { scheduled?: string } => schedule === undefined ? {} : { scheduled: schedule };
export function refusal(turn: Turn, act: Act): string | undefined {
  return closed(turn) ? "The chat is closed" : turn.phase === "failed" ? turn.reason : turn.phase === "stopping" && act.act === "say" ? "The turn is stopping. Send the message again with a new act id." : act.act === "pick" && !MODELS.includes(act.pick.model) ? `Model ${act.pick.model} is not offered` : undefined;
}

const reopen = (id: number): Effect[] => [{ kind: "closeEpoch" }, { kind: "openEpoch", id }];

// The reopen mark stays through every phase until an epoch opens, which takes the new harness, or the chat ends.
// An idle chat reopens one step later: some idle phases, such as the one before a message sent during a goal
// check, lead at once to a start, and that start reopens before it sends, so its message is not in the view twice.
export function next(turn: Turn, input: Input, facts: Facts): Transition {
  const result = step(turn, input, facts);
  const marked = (turn.reopen || result.turn.reopen) && !closed(result.turn) && result.turn.phase !== "failed" && !result.effects.some((effect) => effect.kind === "openEpoch");
  if (!marked) return result.turn.reopen ? { turn: { ...result.turn, reopen: undefined }, effects: result.effects } : result;
  return { turn: { ...result.turn, reopen: true }, effects: result.turn.phase === "idle" ? [...result.effects, { kind: "defer", input: { kind: "reopen" } }] : result.effects };
}

function step(turn: Turn, input: Input, facts: Facts): Transition {
  const idle: Turn = { phase: "idle", attempt: turn.attempt };
  switch (input.kind) {
    case "prepare":
      return { turn, effects: turn.phase === "checking" && (input.act === "say" || input.act === "goal" || input.act === "stop") ? [{ kind: "halt" }, { kind: "dispatch", input: { kind: "idle" } }] : [] };
    case "idle": return { turn: idle, effects: [] };
    case "state": return { turn, effects: [{ kind: "state" }] };
    case "actFailed":
      return { turn: input.say && turn.phase === "idle" ? { phase: "running", id: input.id, attempt: turn.attempt } : turn, effects: [{ kind: "dispatch", input: { kind: "fail", error: input.error } }] };
    case "start": {
      if (turn.phase === "summaries") return { turn: { ...turn, pending: [...turn.pending, input.input] }, effects: [] };
      let batch = false;
      if (turn.phase === "idle") {
        try { batch = facts.over(input.id); }
        catch (error) { return { turn: { phase: "running", id: input.id, attempt: turn.attempt }, effects: [{ kind: "fail", error }] }; }
      }
      if (batch) {
        const attempt = turn.attempt + 1;
        return { turn: { phase: "summaries", id: input.id, pending: [input.input], attempt }, effects: [{ kind: "state" }, { kind: "batch", id: input.id, attempt }] };
      }
      const scheduled = turn.phase === "running" ? input.input.fire && turn.scheduled : input.input.fire?.schedule;
      return { turn: { phase: "running", id: turn.phase === "running" ? turn.id : input.id, ...tagged(scheduled), attempt: turn.attempt }, effects: [{ kind: "state" }, ...(turn.phase === "idle" && turn.reopen ? reopen(input.id) : []), { kind: "send", input: input.input, priority: turn.phase === "running" ? "next" : "now" }] };
    }
    case "stop":
      if (turn.phase === "summaries") return { turn, effects: [{ kind: "halt" }, { kind: "finish", id: input.id, source: "stopped" }] };
      if (turn.phase === "running") return { turn: { ...turn, phase: "stopping", id: input.id }, effects: [{ kind: "cancelApprovals" }, { kind: "state" }, { kind: "interrupt", id: input.id }] };
      return { turn, effects: [{ kind: "state" }] };
    case "interrupted":
      return { turn, effects: turn.phase === "stopping" && turn.id === input.id ? [{ kind: "finish", id: input.id, source: "interrupted" }] : [] };
    case "ended":
      return {
        turn: full(input.context) ? { ...turn, reopen: true } : turn,
        effects: [
          { kind: "usage", usage: input.usage, context: input.context },
          ...(turn.phase === "running" && input.done ? [{ kind: "finish", id: turn.id, reason: input.error === null ? undefined : `The turn failed: ${input.error}`, source: "ended" } satisfies Effect] : [{ kind: "state" } satisfies Effect]),
          ...(input.context === "overflow" ? [{ kind: "note", text: FULL } satisfies Effect] : []),
        ],
      };
    case "finished": {
      if (input.source === "stopped" || input.source === "interrupted") return { turn: idle, effects: [{ kind: "state" }] };
      const effects: Effect[] = [];
      if (input.entry) effects.push({ kind: "record", entry: input.entry });
      if (input.source === "failed") return { turn, effects };
      const goal = input.error ? null : facts.goal.value;
      const result: Turn = goal === null ? idle : { phase: "checking", revision: facts.goal.revision, goal, ...tagged(turn.phase === "running" ? turn.scheduled : undefined), attempt: turn.attempt + 1 };
      if (goal !== null) effects.push({ kind: "checkGoal", goal, attempt: result.attempt });
      effects.push({ kind: "state" });
      return { turn: result, effects };
    }
    case "batched":
      return { turn, effects: turn.phase === "summaries" && turn.attempt === input.attempt ? [{ kind: "closeEpoch" }, { kind: "openEpoch", id: turn.id }, { kind: "dispatch", input: { kind: "rotated", attempt: input.attempt } }] : [] };
    case "rotated": {
      if (turn.phase !== "summaries" || turn.attempt !== input.attempt) return { turn, effects: [] };
      const scheduled = turn.pending.every((input) => input.fire) ? turn.pending[0]?.fire?.schedule : undefined;
      return { turn: { phase: "running", id: turn.id, ...tagged(scheduled), attempt: turn.attempt }, effects: [...turn.pending.map((input, i): Effect => ({ kind: "send", input, priority: i === 0 ? "now" : "next" })), { kind: "state" }] };
    }
    case "checked":
      if (turn.phase !== "checking" || turn.attempt !== input.attempt || facts.goal.revision !== turn.revision) return { turn, effects: [] };
      return { turn, effects: input.met ? [{ kind: "completeGoal", revision: turn.revision }, { kind: "dispatch", input: { kind: "idle" } }, { kind: "state" }] : [{ kind: "continueGoal", text: GOAL_NO }] };
    case "checkFailed": {
      if (turn.phase !== "checking" || turn.attempt !== input.attempt) return { turn, effects: [] };
      const reason = input.error instanceof Error ? input.error.message : "The goal check failed";
      return { turn, effects: [{ kind: "note", text: `No goal check: ${reason.replace(/\.$/, "")}. The goal stays; /halt drops it.` }, { kind: "dispatch", input: { kind: "idle" } }, { kind: "state" }] };
    }
    case "continued":
      return { turn: { phase: "running", id: input.entry.i, ...tagged(turn.phase === "checking" ? turn.scheduled : undefined), attempt: turn.attempt }, effects: [{ kind: "record", entry: input.entry }, { kind: "dispatch", input: { kind: "continueRecorded", id: input.entry.i } }] };
    case "continueRecorded":
      return { turn: idle, effects: [{ kind: "dispatch", input: { kind: "start", id: input.id, input: { text: GOAL_NO, from: "membr", ...turn.phase === "running" && turn.scheduled !== undefined ? { fire: { schedule: turn.scheduled } } : {} } } }] };
    case "report": {
      if (closed(turn)) return { turn, effects: [] };
      if (!input.stopped && turn.phase === "checking") return { turn, effects: [{ kind: "halt" }, { kind: "dispatch", input: { kind: "idle" } }, { kind: "dispatch", input }] };
      const deliver = !input.stopped && (turn.phase === "idle" || turn.phase === "running" || turn.phase === "summaries");
      return { turn, effects: [{ kind: "work", text: input.text, id: deliver ? turnId(turn, facts.count) : null, ...input.schedule === undefined ? {} : { fire: { schedule: input.schedule } }, ...input.record ? { record: input.record } : {} }] };
    }
    case "fail": {
      if (closed(turn) || turn.phase === "failed") return { turn, effects: [] };
      const reason = input.error instanceof Error ? input.error.message : "The Engine failed";
      const effects: Effect[] = turn.phase === "summaries" || turn.phase === "checking" ? [{ kind: "halt" }] : [];
      effects.push({ kind: "dispatch", input: { kind: "failed", previous: turn, reason } });
      return { turn, effects };
    }
    case "failed": {
      const effects: Effect[] = [{ kind: "closeSubagents" }, { kind: "cancelApprovals" }, { kind: "closeEpoch" }];
      const previous = input.previous;
      if (previous.phase === "running" || previous.phase === "stopping" || previous.phase === "summaries") effects.push({ kind: "finish", id: previous.id, reason: `The turn failed: ${input.reason}`, source: "failed" });
      effects.push({ kind: "error", reason: input.reason }, { kind: "state" });
      return { turn: { phase: "failed", reason: input.reason, attempt: turn.attempt }, effects };
    }
    case "close": {
      if (closed(turn)) return { turn, effects: [] };
      const effects: Effect[] = turn.phase === "summaries" || turn.phase === "checking" ? [{ kind: "halt" }] : [];
      effects.push({ kind: "dispatch", input: { kind: "closing" } });
      return { turn, effects };
    }
    case "closing":
      return { turn: { phase: "closing", attempt: turn.attempt }, effects: [{ kind: "closeSubagents" }, { kind: "cancelApprovals" }, { kind: "closeEpoch" }, { kind: "dispatch", input: { kind: "closed" } }] };
    case "closed": return { turn: { phase: "closed", attempt: turn.attempt }, effects: [] };
    case "reload": return { turn: closed(turn) || turn.phase === "failed" ? turn : { ...turn, reopen: true }, effects: [] };
    case "reopen": return { turn, effects: turn.phase === "idle" && turn.reopen ? [...reopen(facts.count), { kind: "state" }] : [] };
  }
}
