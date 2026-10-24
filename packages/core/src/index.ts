// Adapted from UniiChat View.ts at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import type { Act, Entry, Event, MemoryLine, Part, Pick, Read, State, Usage } from "@membr/protocol";

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
  info: string | null;
  approvals: ReadonlyMap<string, Extract<Event, { type: "ask" }>>;
};
export type Input =
  | { type: "send"; id: string; text: string }
  | { type: "stop"; id: string; agent?: string | null }
  | { type: "pick"; id: string; change: Partial<Pick> }
  | { type: "answer"; id: string; approval: string; choice: Extract<Act, { act: "answer" }>["choice"] }
  | { type: "dismiss-error" }
  | { type: "dismiss-info" }
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
    roots: null, page: "chat", folded: false, reads: new Map(), readSequence: 0, pending: new Map(), error: null, info: null, approvals: new Map(),
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
    case "connecting": return { ...model, connection: "connecting", live: "", approvals: new Map() };
    case "offline": return { ...model, connection: model.connection === "refused" ? "refused" : "offline", live: "" };
    case "ready": return { ...model, connection: "ready" };
    case "refused": return { ...model, connection: "refused", error: event.reason, live: "" };
    case "ask":
    case "approval": {
      const approvals = new Map(model.approvals);
      approvals.set(event.id, { ...event, type: "ask" });
      return { ...model, approvals };
    }
    case "ask-closed": {
      const approvals = new Map(model.approvals);
      approvals.delete(event.id);
      return { ...model, approvals };
    }
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
  if (input.type === "dismiss-error") return output({ ...model, error: null });
  if (input.type === "dismiss-info") return output({ ...model, info: null });
  if (input.type === "send" && input.text.trim().startsWith("/")) return command(model, input);
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
  if (input.type === "send") return input.text.trim() ? post(model, [{ type: "act", act: "say", id: input.id, text: input.text }]) : output(model);
  if (input.type === "stop") return post(model, [{ type: "act", act: "stop", id: input.id, agent: input.agent ?? null }]);
  if (input.type === "answer") {
    if (!model.approvals.has(input.approval) || answering(model, input.approval)) return output(model);
    return post(model, [{ type: "act", act: "answer", id: input.id, approval: input.approval, choice: input.choice }]);
  }
  const pick = effectivePick(model);
  return pick ? post(model, [{ type: "act", act: "pick", id: input.id, pick: { ...pick, ...input.change } }]) : output({ ...model, error: "The pick is not available yet." });
}

export const MODELS = ["opus", "sonnet", "haiku"];
export const EFFORTS: Pick["effort"][] = ["low", "medium", "high", "xhigh", "max"];
export const HELP = [
  "/goal <message>  Set a goal and send the message.",
  "/halt  Clear the goal. The current turn continues.",
  "/stop [name]  Stop all work, or one named agent.",
  "/model [name]  Show models, or select one.",
  "/effort [level]  Show effort levels, or select one.",
  "/speed [normal|fast]  Show speeds, or select one.",
  "/fold  Fold or unfold the chat.",
  "/tree  Open the memory tree.",
  "/help  Show these commands.",
].join("\n");

function post(model: Model, messages: Act[]): ReturnType<typeof act> {
  const fresh = messages.filter((message) => !model.pending.has(message.id));
  const pending = new Map(model.pending);
  for (const message of fresh) pending.set(message.id, message);
  const next = fresh.some((message) => message.act === "say") && model.folded
    ? { ...model, folded: false, open: new Set<string>(), reads: new Map<string, Read>() }
    : model;
  return { model: { ...next, pending, error: null }, acts: model.connection === "ready" ? fresh : [], reads: [] };
}

export function effectivePick(model: Model): Pick | null {
  let pick = model.state.pick;
  for (const message of model.pending.values()) if (message.act === "pick") pick = message.pick;
  return pick;
}

export function answering(model: Model, approval: string): boolean {
  return [...model.pending.values()].some((message) => message.act === "answer" && message.approval === approval);
}

export function inputTokens(usage: Usage): number { return usage.input + usage.cacheRead + usage.cacheWrite; }
export function cacheShare(usage: Usage | null): number | null {
  return usage && inputTokens(usage) > 0 ? usage.cacheRead / inputTokens(usage) : null;
}

function command(model: Model, input: Extract<Input, { type: "send" }>): ReturnType<typeof act> {
  const text = input.text.trim();
  const name = text.split(/\s+/, 1)[0];
  const argument = text.slice(name.length).trim();
  const fail = (error: string) => ({ model: { ...model, error }, acts: [], reads: [] });
  const info = (text: string) => ({ model: { ...model, info: text, error: null }, acts: [], reads: [] });
  switch (name) {
    case "/goal":
      if (input.id.length > 252) return fail("The goal request id is too long.");
      return argument ? post(model, [
        { type: "act", act: "goal", id: input.id, text: argument },
        { type: "act", act: "say", id: `${input.id}:say`, text: argument },
      ]) : fail("Use /goal <message>.");
    case "/halt": return argument ? fail("Use /halt without an argument.") : post(model, [{ type: "act", act: "goal", id: input.id, text: null }]);
    case "/stop": return /\s/.test(argument) ? fail("Use /stop [name].") : act(model, { type: "stop", id: input.id, agent: argument || null });
    case "/model":
      if (!argument) return info(`Models: ${MODELS.join(", ")}.`);
      return MODELS.includes(argument) ? act(model, { type: "pick", id: input.id, change: { model: argument } }) : fail(`Choose a model: ${MODELS.join(", ")}.`);
    case "/effort": {
      if (!argument) return info(`Effort levels: ${EFFORTS.join(", ")}.`);
      const effort = EFFORTS.find((value) => value === argument);
      return effort ? act(model, { type: "pick", id: input.id, change: { effort } }) : fail(`Choose an effort: ${EFFORTS.join(", ")}.`);
    }
    case "/speed":
      if (!argument) return info("Speeds: normal, fast.");
      return argument === "normal" || argument === "fast" ? act(model, { type: "pick", id: input.id, change: { fast: argument === "fast" } }) : fail("Choose a speed: normal, fast.");
    case "/fold": return argument ? fail("Use /fold without an argument.") : act(model, { type: "fold" });
    case "/tree": return argument ? fail("Use /tree without an argument.") : act(model, { type: "page", page: "tree" });
    case "/help": return argument ? fail("Use /help without an argument.") : info(HELP);
    default: return fail(`Unknown command ${name}. Use /help.`);
  }
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
