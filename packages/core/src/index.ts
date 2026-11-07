// Adapted from UniiChat View.ts at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import { brief, type Brief } from "./briefs.ts";
import { NEW_EPOCH_SHARE, type ImportInput, type ImportEstimate, type ImportStatus, type Act, type Entry, type Event, type MemoryLine, type Part, type Pick, type Read, type ScheduleSpec, type ScheduleView, type Skill, type State, type Usage, type When, type Context } from "@membr/protocol";

export type Attachment = { id: string; name: string; type: string; data: string };
export type Upload = { id: string; text: string; images: Attachment[] };
export type AgentLog = { entries: ReadonlyMap<number, Entry>; live: string; loaded: boolean };
export type Proposal = { when: When; text: string; next: string[] };
export type Page = "chat" | "tree" | "schedules";
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
  page: Page;
  folded: boolean;
  reads: ReadonlyMap<string, Read>;
  readSequence: number;
  pending: ReadonlyMap<string, Act>;
  error: string | null;
  info: string | null;
  approvals: ReadonlyMap<string, Extract<Event, { type: "ask" }>>;
  skills: Skill[];
  schedules: ScheduleView[];
  // One /schedule request: the read in flight, then what the server understood.
  preview: { id: string; text: string; proposal: Proposal | null } | null;
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
  | { type: "page"; page: Page }
  | { type: "schedule-preview"; id: string; text: string; zone: string }
  | { type: "schedule-accept"; id: string; run?: ScheduleSpec["run"]; missed?: ScheduleSpec["missed"] }
  | { type: "schedule-discard" }
  | { type: "schedule-act"; id: string; schedule: string; change: "accept" | "pause" | "resume" | "unschedule" }
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
    roots: null, page: "chat", folded: false, reads: new Map(), readSequence: 0, pending: new Map(), error: null, info: null, approvals: new Map(), skills: [], schedules: [], preview: null,
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
    case "schedules": return { ...model, schedules: event.schedules };
    case "when": {
      if (model.preview?.id !== event.id) return model;
      const reads = new Map(model.reads); reads.delete(event.id);
      return { ...model, reads, preview: { ...model.preview, proposal: { when: event.when, text: event.text, next: event.next } } };
    }
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
      return { ...model, pending, uploads, importPlan: event.ok && model.pending.get(event.id)?.act === "import" ? null : model.importPlan, preview: event.ok && model.pending.get(event.id)?.act === "schedule" ? null : model.preview, error: event.ok ? model.error : event.reason };
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
  return { ...model, open, importPlan: request.read === "import" ? null : model.importPlan, preview: request.read === "when" ? null : model.preview, error: reason };
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
  if (input.type === "schedule-preview") {
    const reads = new Map([...model.reads].filter(([, request]) => request.read !== "when"));
    const request: Read = { type: "read", read: "when", id: input.id, text: input.text, zone: input.zone };
    reads.set(request.id, request);
    return output({ ...model, reads, preview: { id: input.id, text: input.text, proposal: null }, error: null }, [], [request]);
  }
  if (input.type === "schedule-discard") return output({ ...model, preview: null, reads: new Map([...model.reads].filter(([, request]) => request.read !== "when")) });
  if (input.type === "schedule-accept") {
    const proposal = model.preview?.proposal;
    if (!proposal) return output(model);
    const schedule = { text: proposal.text, when: proposal.when, run: input.run ?? "agent", missed: input.missed ?? "once" };
    return post(model, [{ type: "act", act: "schedule", id: input.id, schedule }]);
  }
  if (input.type === "schedule-act") {
    const { id, schedule } = input;
    return post(model, [input.change === "accept" ? { type: "act", act: "accept", id, schedule }
      : input.change === "unschedule" ? { type: "act", act: "unschedule", id, schedule }
      : { type: "act", act: "pause", id, schedule, paused: input.change === "pause" }]);
  }
  if (input.type === "dismiss-info") return output({ ...model, info: null });
  if (input.type === "send" && input.text.trim().startsWith("/")) return model.attachments.length
    ? output({ ...model, error: "Remove images before you use a command." }) : command(model, input);
  if (input.type === "fold" || input.type === "page") {
    const next = { ...model, open: new Set<string>(), reads: new Map<string, Read>([...model.reads].filter(([, request]) => request.read === "agent" || request.read === "when")), error: null };
    if (input.type === "fold") next.folded = !model.folded;
    else { next.page = input.page; if (input.page !== "chat") next.agent = null; }
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
  { name: "/schedule", hint: "<when and task>", description: "Preview a schedule, then accept it." },
  { name: "/schedules", hint: "", description: "List the schedules." },
  { name: "/unschedule", hint: "<id>", description: "Delete a schedule." },
  { name: "/pause", hint: "<id>", description: "Pause a schedule." },
  { name: "/resume", hint: "<id>", description: "Resume a paused schedule." },
  { name: "/accept", hint: "<id>", description: "Accept a proposed schedule." },
  { name: "/reload", hint: "", description: "Read the server's config.json again." },
  { name: "/help", hint: "", description: "Show these commands." },
];
export const HELP = COMMANDS.map((command) => `${command.name}${command.hint ? " " + command.hint : ""}  ${command.description}`).join("\n");

export function clientZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone; }

// "Mon 08:30" in the zone, with the date when the time is more than a week away.
export function fireTime(iso: string, zone: string = clientZone(), now: number = Date.now()): string {
  const at = new Date(iso);
  const far = Math.abs(at.getTime() - now) > 6 * 864e5;
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...options }).format(at);
  return `${far ? part({ day: "numeric", month: "short" }) : part({ weekday: "short" })} ${part({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

export function describeWhen(when: When): string {
  return when.kind === "cron" ? `cron "${when.expr}" ${when.zone}` : `once ${fireTime(when.at)}`;
}

export function runLabel(run: ScheduleSpec["run"]): string { return run === "turn" ? "turn" : "subagent"; }

function skill(model: Model, name: string): Skill | undefined {
  return COMMANDS.some((command) => command.name === name) ? undefined : model.skills.find((skill) => "/" + skill.name === name);
}

// The `/word` that ends at the cursor, and the names the composer can offer for it.
export type Completion = { start: number; commands: Command[] };

// A skill runs wherever the message names it, but membr's own commands only work as the first word. So the names that start with the typed word come first, then the names that contain it; after other text, only skills.
export function complete(model: Model, text: string, cursor: number = text.length): Completion {
  const start = text.slice(0, cursor).search(/(?:^|\s)\/\S*$/);
  const none = { start: cursor, commands: [] };
  if (start === -1 || (cursor < text.length && !/\s/.test(text[cursor]))) return none;
  const from = text[start] === "/" ? start : start + 1;
  const skills = model.skills.filter((s) => skill(model, "/" + s.name)).map((s) => ({ name: "/" + s.name, hint: s.argumentHint, description: s.description }));
  const all = text.slice(0, from).trim() === "" ? [...COMMANDS, ...skills] : skills;
  const word = text.slice(from, cursor).toLowerCase();
  return { start: from, commands: [...all.filter((c) => c.name.toLowerCase().startsWith(word)), ...all.filter((c) => !c.name.toLowerCase().startsWith(word) && c.name.toLowerCase().includes(word.slice(1)))] };
}

// Puts the chosen name in place of the typed word, with one space after it unless the text already has whitespace there.
export function accept(text: string, cursor: number, completion: Completion, command: Command): { text: string; cursor: number } {
  const space = /^\s/.test(text.slice(cursor)) ? "" : " ";
  const name = command.name + space;
  return { text: text.slice(0, completion.start) + name + text.slice(cursor), cursor: completion.start + command.name.length + 1 };
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
// The token count at which the epoch's next turn end starts a new epoch.
export function epochLimit(context: { window: number }): number { return Math.round(context.window * NEW_EPOCH_SHARE); }
// the status words for how far the epoch is from a new one; null until a turn of the epoch ends
export function epochWords(context: Context | undefined): string | null {
  if (context === undefined || context === null) return null;
  if (context === "overflow") return "epoch full";
  const limit = epochLimit(context);
  return `epoch ${tokens(context.used)} / ${tokens(limit)} (${Math.round(context.used / limit * 100)}%)`;
}
export function tokens(count: number): string {
  return count < 1000 ? String(count) : count < 1e6 ? `${Math.round(count / 1000)}k` : `${(count / 1e6).toFixed(1)}M`;
}
export function cacheShare(usage: Usage | null): number | null {
  return usage && inputTokens(usage) > 0 ? usage.cacheRead / inputTokens(usage) : null;
}

// A schedule named by its id, or by its number in /schedules.
function scheduleFor(model: Model, name: string): ScheduleView | undefined {
  const listed = liveSchedules(model);
  return listed.find((schedule) => schedule.id === name) ?? listed[Number(name) - 1];
}

function liveSchedules(model: Model): ScheduleView[] { return model.schedules.filter((schedule) => schedule.phase !== "cancelled"); }

export function scheduleLine(schedule: ScheduleView): string {
  const zone = schedule.when.kind === "cron" ? schedule.when.zone : undefined;
  const next = schedule.next[0] ? `, next ${fireTime(schedule.next[0], zone)}` : "";
  const by = schedule.author === "membr" ? ", by membr" : "";
  return `${describeWhen(schedule.when)}  ${schedule.phase}, ${runLabel(schedule.run)}${by}${next}  ${schedule.text}`;
}

function listSchedules(model: Model): string {
  const listed = liveSchedules(model);
  return listed.length ? listed.map((schedule, index) => `${index + 1}. ${schedule.id}  ${scheduleLine(schedule)}`).join("\n") : "No schedules.";
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
    case "/schedule": return argument ? act(model, { type: "schedule-preview", id: input.id, text: argument, zone: clientZone() }) : fail("Use /schedule <when and task>.");
    case "/schedules": return argument ? fail("Use /schedules without an argument.") : info(listSchedules(model));
    case "/unschedule":
    case "/pause":
    case "/resume":
    case "/accept": {
      const target = scheduleFor(model, argument);
      if (!target) return fail(`Use ${name} <id>. Use /schedules to see the ids.`);
      return act(model, { type: "schedule-act", id: input.id, schedule: target.id, change: name === "/unschedule" ? "unschedule" : name.slice(1) as "accept" | "pause" | "resume" });
    }
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
