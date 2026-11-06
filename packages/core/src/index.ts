// Adapted from UniiChat View.ts at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import { brief, type Brief } from "./briefs.ts";
import type { ImportInput, ImportEstimate, ImportStatus, Act, Entry, Event, MemoryLine, Part, Pick, Read, Skill, State, Usage } from "@membr/protocol";

export type Attachment = { id: string; name: string; type: string; data: string };
export type Upload = { id: string; text: string; images: Attachment[] };
export type AgentLog = { entries: ReadonlyMap<number, Entry>; live: string; loaded: boolean };
export type Model = {
  importPlan: { id: string; input: ImportInput; estimate: ImportEstimate | null } | null;
  imports: ImportStatus[];
  agent: string | null;
  agents: ReadonlyMap<string, AgentLog>;
  attachments: Attachment[];
  uploads: ReadonlyMap<string, Upload>;
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
  skills: Skill[];
};
export type Input =
  | { type: "import-plan"; id: string; input: ImportInput }
  | { type: "import-start"; id: string }
  | { type: "import-go"; id: string; run: string; paused: boolean }
  | { type: "send"; id: string; text: string }
  | { type: "agent"; name: string | null }
  | { type: "attach"; images: Attachment[] }
  | { type: "detach"; id: string }
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
export type { Brief, Call } from "./briefs.ts";
export { brief } from "./briefs.ts";
export type Row =
  | { kind: "message"; entry: Entry }
  | { kind: "brief"; brief: Brief }
  | { kind: "summary"; part: Part; text: string }
  | { kind: "open"; part: Part; rows: Row[]; loading: boolean };

export function partKey(part: Part): string { return `${part.l}/${part.i}`; }
function end(part: Part): number { return (part.i + 1) * 2 ** part.l; }

export function createModel(): Model {
  return {
    importPlan: null, imports: [],
    agent: null, agents: new Map(), attachments: [], uploads: new Map(),
    connection: "offline", entries: new Map(), live: "", parts: [], turn: null, nodes: new Map(), open: new Set(),
    roots: null, page: "chat", folded: false, reads: new Map(), readSequence: 0, pending: new Map(), error: null, info: null, approvals: new Map(), skills: [],
    state: { busy: false, wait: "", goal: null, pick: null, agents: [], usage: null },
  };
}

function requestAgent(model: Model, name: string): Model {
  const reads = new Map([...model.reads].filter(([, request]) => request.read !== "agent" || request.name !== name));
  const readSequence = model.readSequence + 1;
  const request: Read = { type: "read", read: "agent", id: `agent-${readSequence}`, name };
  reads.set(request.id, request);
  return { ...model, reads, readSequence };
}

function agentLog(model: Model, name: string): AgentLog {
  return model.agents.get(name) ?? { entries: new Map(), live: "", loaded: false };
}

function requestRoots(model: Model): Model {
  const reads = new Map([...model.reads].filter(([, request]) => request.read !== "roots" && request.read !== "root"));
  const readSequence = model.readSequence + 1;
  const request: Read = { type: "read", read: "roots", id: `memory-roots-${readSequence}` };
  reads.set(request.id, request);
  return { ...model, reads, readSequence };
}

export function hear(model: Model, event: Event | ConnectionEvent): Model {
  switch (event.type) {
    case "imports": return { ...model, imports: event.imports };
    case "skills": return { ...model, skills: event.skills };
    case "import-estimate": {
      if (!model.importPlan || model.importPlan.id !== event.id) return model;
      const reads = new Map(model.reads); reads.delete(event.id);
      return { ...model, reads, importPlan: { ...model.importPlan, estimate: event.estimate } };
    }
    case "connecting": {
      const next: Model = { ...model, connection: "connecting", live: "", approvals: new Map(), agents: new Map([...model.agents].map(([name, log]) => [name, { ...log, live: "" }])) };
      return model.agent === null ? next : requestAgent(next, model.agent);
    }
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
    case "agent-entry": {
      const log = agentLog(model, event.name), entries = new Map(log.entries), agents = new Map(model.agents);
      entries.set(event.entry.i, event.entry);
      agents.set(event.name, { ...log, entries, live: event.entry.kind === "unii" ? "" : log.live });
      return { ...model, agents };
    }
    case "live": {
      if (event.agent === null) return { ...model, live: model.live + event.text };
      const log = agentLog(model, event.agent), agents = new Map(model.agents);
      agents.set(event.agent, { ...log, live: log.live + event.text });
      return { ...model, agents };
    }
    case "state": {
      const agents = new Map(model.agents);
      for (const name of event.state.agentNames ?? event.state.agents) agents.set(name, agentLog(model, name));
      for (const [name, log] of agents) if (!event.state.agents.includes(name)) agents.set(name, { ...log, live: "" });
      return { ...model, agents, state: event.state, live: event.state.busy ? model.live : "" };
    }
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
      if (request.read === "agent") {
        const agents = new Map(model.agents);
        agents.set(request.name, { entries: new Map(event.entries.map((entry) => [entry.i, entry])), live: event.live ?? "", loaded: true });
        return { ...model, reads, agents };
      }
      const nodes = new Map(model.nodes), entries = new Map(model.entries);
      for (const line of event.lines) nodes.set(partKey(line), line);
      for (const entry of event.entries) entries.set(entry.i, entry);
      return { ...model, reads, nodes, entries, roots: request.read === "roots" ? event.parts : model.roots };
    }
    case "answer": {
      const pending = new Map(model.pending);
      pending.delete(event.id);
      const uploads = new Map(model.uploads);
      uploads.delete(event.id);
      return { ...model, pending, uploads, importPlan: event.ok && model.pending.get(event.id)?.act === "import" ? null : model.importPlan, error: event.ok ? model.error : event.reason };
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
  return { ...model, open, importPlan: request.read === "import" ? null : model.importPlan, error: reason };
}

export function act(model: Model, input: Input): { model: Model; acts: Act[]; reads: Read[]; uploads: Upload[] } {
  const output = (next: Model, acts: Act[] = [], reads: Read[] = [], uploads: Upload[] = []) => ({ model: next, acts: next.connection === "ready" ? acts : [], reads: next.connection === "ready" ? reads : [], uploads: next.connection === "ready" ? uploads : [] });
  if (input.type === "import-plan") {
    const reads = new Map([...model.reads].filter(([, request]) => request.read !== "import"));
    const request: Read = { type: "read", read: "import", id: input.id, ...input.input };
    reads.set(request.id, request);
    return output({ ...model, reads, importPlan: { id: input.id, input: input.input, estimate: null }, error: null }, [], [request]);
  }
  if (input.type === "import-start") return model.importPlan?.estimate
    ? post(model, [{ type: "act", act: "import", id: input.id, ...model.importPlan.input }]) : output(model);
  if (input.type === "import-go") return post(model, [{ type: "act", act: "go", id: input.id, import: input.run, paused: input.paused }]);
  if (input.type === "flush") return output(model, [...model.pending.values()].filter((request) => !model.uploads.has(request.id)), [...model.reads.values()], [...model.uploads.values()]);
  if (input.type === "agent") {
    if (input.name !== null && !model.agents.has(input.name)) return output(model);
    const next = { ...model, agent: input.name, page: "chat" as const };
    const refreshed = input.name === null ? next : requestAgent(next, input.name);
    return output(refreshed, [], [...refreshed.reads.values()]);
  }
  if (input.type === "attach") {
    const attachments = [...model.attachments, ...input.images];
    if (attachments.length > 20) return output({ ...model, error: "Attach at most 20 images." });
    if (input.images.some((image) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.type) || !image.data)) return output({ ...model, error: "Choose a PNG, JPEG, GIF, or WebP image." });
    return output({ ...model, attachments, error: null });
  }
  if (input.type === "detach") return output({ ...model, attachments: model.attachments.filter((image) => image.id !== input.id) });
  if (input.type === "reads") return output(model, [], [...model.reads.values()]);
  if (input.type === "dismiss-error") return output({ ...model, error: null });
  if (input.type === "dismiss-info") return output({ ...model, info: null });
  if (input.type === "send" && input.text.trim().startsWith("/")) return model.attachments.length
    ? output({ ...model, error: "Remove images before you use a command." }) : command(model, input);
  if (input.type === "fold" || input.type === "page") {
    const next = { ...model, open: new Set<string>(), reads: new Map<string, Read>([...model.reads].filter(([, request]) => request.read === "agent")), error: null };
    if (input.type === "fold") next.folded = !model.folded;
    else { next.page = input.page; if (input.page === "tree") next.agent = null; }
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
  if (input.type === "send") {
    if (!input.text.trim() && !model.attachments.length || model.pending.has(input.id)) return output(model);
    if (!model.attachments.length) return post(model, [{ type: "act", act: "say", id: input.id, text: input.text }]);
    const upload = { id: input.id, text: input.text, images: model.attachments.slice() };
    const uploads = new Map(model.uploads);
    uploads.set(input.id, upload);
    const sent = post({ ...model, uploads, attachments: [] }, [{ type: "act", act: "say", id: input.id, text: input.text }]);
    return output(sent.model, [], [], [upload]);
  }
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
export type Command = { name: string; hint: string; description: string };
// membr's own commands. A skill with the same name is hidden behind them.
export const COMMANDS: Command[] = [
  { name: "/goal", hint: "<message>", description: "Set a goal and send the message." },
  { name: "/halt", hint: "", description: "Clear the goal. The current turn continues." },
  { name: "/stop", hint: "[name]", description: "Stop all work, or one named agent." },
  { name: "/model", hint: "[name]", description: "Show models, or select one." },
  { name: "/effort", hint: "[level]", description: "Show effort levels, or select one." },
  { name: "/speed", hint: "[normal|fast]", description: "Show speeds, or select one." },
  { name: "/fold", hint: "", description: "Fold or unfold the chat." },
  { name: "/tree", hint: "", description: "Open the memory tree." },
  { name: "/reload", hint: "", description: "Read the server's config.json again." },
  { name: "/help", hint: "", description: "Show these commands." },
];
export const HELP = COMMANDS.map((command) => `${command.name}${command.hint ? " " + command.hint : ""}  ${command.description}`).join("\n");

function skill(model: Model, name: string): Skill | undefined {
  return COMMANDS.some((command) => command.name === name) ? undefined : model.skills.find((skill) => "/" + skill.name === name);
}

// The commands and skills that the composer can offer for its text: names
// that start with the typed word first, then names that contain it.
export function complete(model: Model, text: string): Command[] {
  if (!/^\/\S*$/.test(text)) return [];
  const all = [...COMMANDS, ...model.skills.filter((s) => skill(model, "/" + s.name)).map((s) => ({ name: "/" + s.name, hint: s.argumentHint, description: s.description }))];
  const word = text.toLowerCase();
  return [...all.filter((c) => c.name.toLowerCase().startsWith(word)), ...all.filter((c) => !c.name.toLowerCase().startsWith(word) && c.name.toLowerCase().includes(word.slice(1)))];
}

function post(model: Model, messages: Act[]): ReturnType<typeof act> {
  const fresh = messages.filter((message) => !model.pending.has(message.id));
  const pending = new Map(model.pending);
  for (const message of fresh) pending.set(message.id, message);
  const next = fresh.some((message) => message.act === "say") && model.folded
    ? { ...model, folded: false, open: new Set<string>(), reads: new Map<string, Read>() }
    : model;
  return { model: { ...next, pending, error: null }, acts: model.connection === "ready" ? fresh : [], reads: [], uploads: [] };
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
  const fail = (error: string) => ({ model: { ...model, error }, acts: [], reads: [], uploads: [] });
  const info = (text: string) => ({ model: { ...model, info: text, error: null }, acts: [], reads: [], uploads: [] });
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
    case "/reload": return argument ? fail("Use /reload without an argument.") : post(model, [{ type: "act", act: "reload", id: input.id }]);
    case "/help": return argument ? fail("Use /help without an argument.") : info(model.skills.length ? `${HELP}\n\nSkills: ${model.skills.length}. Type / and a name to find one.` : HELP);
    default: return skill(model, name) ? post(model, [{ type: "act", act: "say", id: input.id, text }]) : fail(`Unknown command ${name}. Use /help.`);
  }
}

// Folds each stretch of whole messages into briefs, inside open memory blocks too.
function briefed(rows: Row[]): Row[] {
  const out: Row[] = [];
  let messages: Entry[] = [];
  const flush = () => { out.push(...brief(messages)); messages = []; };
  for (const row of rows) {
    if (row.kind === "message") { messages.push(row.entry); continue; }
    flush();
    out.push(row.kind === "open" ? { ...row, rows: briefed(row.rows) } : row);
  }
  flush();
  return out;
}

export function rows(model: Model): Row[] {
  const overview = model.folded || model.page === "tree";
  function block(part: Part, whole = false): Row {
    const entry = part.l === 0 ? model.entries.get(part.i) : undefined;
    const text = model.nodes.get(partKey(part))?.text ?? (entry ? `${entry.kind}: ${entry.text.slice(0, 160)}` : "(not summarized yet: zoom it)");
    if (whole && entry) return { kind: "message", entry };
    if (model.open.has(partKey(part))) {
      const children: Row[] = part.l === 0
        ? entry ? [{ kind: "message", entry }] : []
        : [{ l: part.l - 1, i: part.i * 2 }, { l: part.l - 1, i: part.i * 2 + 1 }].map((child) => block(child));
      return { kind: "open", part, rows: children, loading: [...model.reads.values()].some((request) => request.read === "zoom" && partKey(request.part) === partKey(part)) };
    }
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
  return briefed(result);
}
