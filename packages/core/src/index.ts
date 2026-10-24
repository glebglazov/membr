// Adapted from UniiChat View.ts at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import type { Act, Entry, Event, MemoryLine, Part, Read, State } from "@membr/protocol";

export type Model = {
  connection: "offline" | "connecting" | "ready" | "refused";
  entries: ReadonlyMap<number, Entry>;
  live: string;
  state: State;
  parts: Part[];
  turn: number | null;
  nodes: ReadonlyMap<string, MemoryLine>;
  open: ReadonlySet<string>;
  roots: Part[] | null;
  page: "chat" | "tree";
  folded: boolean;
  reads: ReadonlyMap<string, Read>;
  readSequence: number;
  pending: ReadonlyMap<string, Act>;
  error: string | null;
};
export type Input =
  | { type: "send"; id: string; text: string }
  | { type: "stop"; id: string }
  | { type: "open"; id: string; part: Part }
  | { type: "close"; part: Part }
  | { type: "fold" }
  | { type: "page"; page: "chat" | "tree" }
  | { type: "flush" }
  | { type: "reads" };
export type ConnectionEvent = { type: "connecting" | "offline" };
export type Row =
  | { kind: "message"; entry: Entry }
  | { kind: "summary"; part: Part; text: string }
  | { kind: "open"; part: Part; rows: Row[]; loading: boolean };

export function partKey(part: Part): string { return `${part.l}/${part.i}`; }
function end(part: Part): number { return (part.i + 1) * 2 ** part.l; }

export function createModel(): Model {
  return {
    connection: "offline", entries: new Map(), live: "", parts: [], turn: null, nodes: new Map(), open: new Set(),
    roots: null, page: "chat", folded: false, reads: new Map(), readSequence: 0, pending: new Map(), error: null,
    state: { busy: false, wait: "", goal: null, pick: null, agents: [], usage: null },
  };
}

function requestRoots(model: Model): Model {
  const reads = new Map([...model.reads].filter(([, request]) => request.read === "zoom"));
  const readSequence = model.readSequence + 1;
  const request: Read = { type: "read", read: "roots", id: `memory-roots-${readSequence}` };
  reads.set(request.id, request);
  return { ...model, reads, readSequence };
}

export function hear(model: Model, event: Event | ConnectionEvent): Model {
  switch (event.type) {
    case "connecting": return { ...model, connection: "connecting", live: "" };
    case "offline": return { ...model, connection: model.connection === "refused" ? "refused" : "offline", live: "" };
    case "ready": return { ...model, connection: "ready" };
    case "refused": return { ...model, connection: "refused", error: event.reason, live: "" };
    case "entry": {
      const entries = new Map(model.entries);
      entries.set(event.entry.i, event.entry);
      return { ...model, entries, live: event.entry.kind === "unii" ? "" : model.live };
    }
    case "live": return event.agent === null ? { ...model, live: model.live + event.text } : model;
    case "state": return { ...model, state: event.state, live: event.state.busy ? model.live : "" };
    case "view": {
      const nodes = new Map(model.nodes);
      for (const line of event.lines ?? []) nodes.set(partKey(line), line);
      const next = { ...model, parts: event.parts, turn: event.turn ?? null, nodes };
      return model.folded || model.page === "tree" ? requestRoots(next) : next;
    }
    case "read": {
      const request = model.reads.get(event.id);
      if (!request) return model;
      const reads = new Map(model.reads);
      reads.delete(event.id);
      if (event.error) return readFailure({ ...model, reads }, request, event.error);
      const nodes = new Map(model.nodes), entries = new Map(model.entries);
      for (const line of event.lines) nodes.set(partKey(line), line);
      for (const entry of event.entries) entries.set(entry.i, entry);
      return { ...model, reads, nodes, entries, roots: request.read === "roots" ? event.parts : model.roots };
    }
    case "answer": {
      const pending = new Map(model.pending);
      pending.delete(event.id);
      return { ...model, pending, error: event.ok ? model.error : event.reason };
    }
    case "error": {
      const request = event.id === null ? undefined : model.reads.get(event.id);
      if (!request) return { ...model, error: event.reason };
      const reads = new Map(model.reads);
      reads.delete(request.id);
      return readFailure({ ...model, reads }, request, event.reason);
    }
    default: return model;
  }
}

function readFailure(model: Model, request: Read, reason: string): Model {
  const open = new Set(model.open);
  if (request.read === "zoom") open.delete(partKey(request.part));
  return { ...model, open, error: reason };
}

export function act(model: Model, input: Input): { model: Model; acts: Act[]; reads: Read[] } {
  const output = (next: Model, acts: Act[] = [], reads: Read[] = []) => ({ model: next, acts: next.connection === "ready" ? acts : [], reads: next.connection === "ready" ? reads : [] });
  if (input.type === "flush") return output(model, [...model.pending.values()], [...model.reads.values()]);
  if (input.type === "reads") return output(model, [], [...model.reads.values()]);
  if (input.type === "send" && input.text.trim() === "/fold") return act(model, { type: "fold" });
  if (input.type === "fold" || input.type === "page") {
    const next = { ...model, open: new Set<string>(), reads: new Map<string, Read>(), error: null };
    if (input.type === "fold") next.folded = !model.folded;
    else next.page = input.page;
    const refreshed = next.folded || next.page === "tree" ? requestRoots(next) : next;
    return output(refreshed, [], [...refreshed.reads.values()]);
  }
  if (input.type === "close") {
    const open = new Set(model.open);
    open.delete(partKey(input.part));
    const reads = new Map([...model.reads].filter(([, request]) => request.read !== "zoom" || partKey(request.part) !== partKey(input.part)));
    return output({ ...model, open, reads });
  }
  if (input.type === "open") {
    const key = partKey(input.part);
    if (model.open.has(key)) return output(model);
    const open = new Set(model.open), reads = new Map(model.reads);
    open.add(key);
    const request: Read = { type: "read", read: "zoom", id: input.id, part: input.part };
    reads.set(input.id, request);
    return output({ ...model, open, reads, error: null }, [], [request]);
  }
  if (input.type === "send" && !input.text.trim()) return output(model);
  if (model.pending.has(input.id)) return output(model);
  const message: Act = input.type === "send"
    ? { type: "act", act: "say", id: input.id, text: input.text }
    : { type: "act", act: "stop", id: input.id, agent: null };
  const pending = new Map(model.pending);
  pending.set(message.id, message);
  const next = input.type === "send" && model.folded
    ? { ...model, folded: false, open: new Set<string>(), reads: new Map<string, Read>() }
    : model;
  return output({ ...next, pending, error: null }, [message]);
}

export function rows(model: Model): Row[] {
  const overview = model.folded || model.page === "tree";
  function block(part: Part, whole = false): Row {
    const entry = part.l === 0 ? model.entries.get(part.i) : undefined;
    const text = model.nodes.get(partKey(part))?.text ?? (entry ? `${entry.kind}: ${entry.text.slice(0, 160)}` : "(not summarized yet: zoom it)");
    if (whole && entry && model.turn !== null && entry.i >= model.turn) return { kind: "message", entry };
    if (model.open.has(partKey(part))) {
      const children: Row[] = part.l === 0
        ? entry ? [{ kind: "message", entry }] : []
        : [{ l: part.l - 1, i: part.i * 2 }, { l: part.l - 1, i: part.i * 2 + 1 }].map((child) => block(child));
      return { kind: "open", part, rows: children, loading: [...model.reads.values()].some((request) => request.read === "zoom" && partKey(request.part) === partKey(part)) };
    }
    const summary = model.nodes.get(partKey(part));
    if (whole && entry && (!summary || summary.text === `${entry.kind}: ${entry.text}`)) return { kind: "message", entry };
    return { kind: "summary", part, text };
  }
  const parts = overview ? model.roots ?? [] : model.parts;
  const result = parts.map((part) => block(part, !overview));
  if (!overview) {
    const covered = parts.length ? end(parts[parts.length - 1]) : 0;
    for (const entry of [...model.entries.values()].sort((a, b) => a.i - b.i)) {
      if (entry.i >= covered) result.push({ kind: "message", entry });
    }
  }
  return result;
}
