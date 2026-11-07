export const VERSION = "2.0";

export type Hello = { type: "hello"; version: string; kind: "web" | "term"; device: null; token: string | null };
export type Pick = { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; fast: boolean };
export type Part = { l: number; i: number };
export type MemoryLine = Part & { text: string };
export type ImportSource = "claude-code" | "codex" | "claude.ai" | "chatgpt";
export type ImportFile = { name: string; text: string };
export type ImportInput = { source: ImportSource; path: string; files?: ImportFile[] };
export type ImportEstimate = { sessions: number; messages: number; compactions: number };
export type ImportStatus = ImportEstimate & { id: string; phase: "running" | "paused" | "complete" };
export type ImportMark = { run: string; session: string; message: string };
// One time, or a 5-field cron in a named zone. The zone is a name, never an offset, so DST moves with it.
export type When = { kind: "once"; at: string } | { kind: "cron"; expr: string; zone: string };
export type ScheduleSpec = { text: string; when: When; run: "turn" | "subagent"; missed: "skip" | "once" };
// author is the voice of every fire. since is the latest move to active: no fire before it counts.
export type Schedule = ScheduleSpec & {
  id: string;
  author: "user" | "membr";
  phase: "proposed" | "active" | "paused" | "cancelled";
  since: string;
};
export type Fired = { at: string; result: "ran" | "late" | "skipped"; entry: number | null };
// next and done are derived on each send, never stored. done is a "once" schedule that has fired.
export type ScheduleView = Omit<Schedule, "phase"> & { phase: Schedule["phase"] | "done"; next: string[]; last: Fired | null };
export type Entry = {
  i: number;
  kind: "user" | "unii" | "tool" | "echo" | "work" | "note" | "ai";
  text: string;
  date: string;
  from: { machine: string; seq: number };
  images?: string[];
  imported?: ImportMark;
  scheduled?: { schedule: string; late: boolean };
};
export const SCHEDULE_ACTS = ["schedule", "unschedule", "pause", "accept"] as const;
export type Act = { type: "act"; id: string } & (
  | { act: "say"; text: string; images?: string[] }
  | { act: "stop"; subagent: string | null }
  | { act: "goal"; text: string | null }
  | { act: "pick"; pick: Pick }
  | { act: "reload" }
  | { act: "answer"; approval: string; choice: "once" | "always" | "deny" }
  | ({ act: "import" } & ImportInput)
  | { act: "go"; import: string; paused: boolean }
  | { act: "schedule"; schedule: ScheduleSpec }
  | { act: "unschedule"; schedule: string }
  | { act: "pause"; schedule: string; paused: boolean }
  | { act: "accept"; schedule: string }
);
export type ScheduleAct = Extract<Act, { act: typeof SCHEDULE_ACTS[number] }>;
export type Read = { type: "read"; id: string } & (
  | { read: "zoom"; part: Part }
  | { read: "root" }
  | { read: "roots" }
  | { read: "subagent"; name: string }
  | ({ read: "import" } & ImportInput)
  | { read: "when"; text: string; zone: string }
);
export type Answer = { type: "answer"; id: string } & (
  | { ok: true; entry: number | null }
  | { ok: false; reason: string }
);
// a /name command from the harness that the agent runs when a user message starts with it
export type Skill = { name: string; description: string; argumentHint: string };
// One agent of the server, for the agent switcher. about is the first line of its prompt.
export type AgentInfo = { name: string; busy: boolean; about: string };
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type State = { busy: boolean; wait: string; goal: string | null; pick: Pick | null; subagents: string[]; subagentNames?: string[]; usage: Usage | null; compression?: Usage; context?: Context };
// how full the epoch was at the end of its last turn: `used` of the model's
// `window` tokens, "overflow" when it no longer fit, null before a turn ends
export type Context = { used: number; window: number } | "overflow" | null;
// A turn that ends with the epoch at this many tokens or more gets a new epoch: past it, each request
// costs more and the model reads its context less well. A small window lowers it to 80%, so the next turn still fits.
export const EPOCH_BUDGET = 150_000;
export function epochLimit(window: number): number { return Math.min(EPOCH_BUDGET, Math.round(window * 0.8)); }
export type Event =
  | { type: "ready"; version: string }
  | { type: "refused"; reason: string }
  | { type: "entry"; entry: Entry }
  | { type: "subagent-entry"; name: string; entry: Entry }
  | { type: "live"; text: string; subagent: string | null }
  | { type: "view"; parts: Part[]; lines?: MemoryLine[]; turn?: number }
  | { type: "ask"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "ask-closed"; id: string }
  | { type: "approval"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "state"; state: State }
  | Answer
  | { type: "read"; id: string; entries: Entry[]; parts: Part[]; lines: MemoryLine[]; live?: string; error?: string }
  | { type: "import-estimate"; id: string; estimate: ImportEstimate }
  | { type: "imports"; imports: ImportStatus[] }
  | { type: "skills"; skills: Skill[] }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "schedules"; schedules: ScheduleView[] }
  | { type: "when"; id: string; when: When; text: string; next: string[] }
  | { type: "error"; id: string | null; reason: string };
export type ClientMessage = Hello | Act | Read;

export function isScheduleAct(message: ClientMessage): message is ScheduleAct {
  return message.type === "act" && (SCHEDULE_ACTS as readonly string[]).includes(message.act);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}
function id(value: unknown): string {
  const result = string(value);
  if (!result.length || result.length > 256) throw new Error("Expected an id of 1 to 256 characters");
  return result;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected a boolean");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Expected a nonnegative integer");
  return value;
}
function list<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value.map(parse);
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  const text = string(value);
  if (!values.includes(text)) throw new Error(`Expected one of ${values.join(", ")}`);
  return text as T[number];
}
function instant(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Expected a date");
  return result;
}
function version(value: unknown): string {
  const result = string(value);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(result)) throw new Error("Expected a protocol version such as 1.0");
  return result;
}
export function parsePick(value: unknown): Pick {
  const v = object(value);
  return { model: id(v.model), effort: oneOf(v.effort, ["low", "medium", "high", "xhigh", "max"]), fast: boolean(v.fast) };
}
export function parseWhen(value: unknown): When {
  const v = object(value);
  switch (v.kind) {
    case "once": return { kind: "once", at: instant(v.at) };
    case "cron": return { kind: "cron", expr: string(v.expr), zone: string(v.zone) };
    default: throw new Error("Unknown when");
  }
}
// Schedules persisted before the rename say "agent" for what is now a "subagent".
function parseRun(value: unknown): ScheduleSpec["run"] {
  return oneOf(value === "agent" ? "subagent" : value, ["turn", "subagent"]);
}

export function parseScheduleSpec(value: unknown): ScheduleSpec {
  const v = object(value);
  return { text: string(v.text), when: parseWhen(v.when), run: parseRun(v.run), missed: oneOf(v.missed, ["skip", "once"]) };
}
export function parseSchedule(value: unknown): Schedule {
  const v = object(value);
  return { ...parseScheduleSpec(v), id: id(v.id), author: oneOf(v.author, ["user", "membr"]), phase: oneOf(v.phase, ["proposed", "active", "paused", "cancelled"]), since: instant(v.since) };
}
export function parseFired(value: unknown): Fired {
  const v = object(value);
  return { at: instant(v.at), result: oneOf(v.result, ["ran", "late", "skipped"]), entry: nullable(v.entry, integer) };
}
function scheduleView(value: unknown): ScheduleView {
  const v = object(value);
  const phase = oneOf(v.phase, ["proposed", "active", "paused", "cancelled", "done"]);
  return { ...parseSchedule({ ...v, phase: phase === "done" ? "active" : phase }), phase, next: list(v.next, instant), last: nullable(v.last, parseFired) };
}
function importFiles(value: unknown): ImportFile[] {
  const files = list(value, (item) => { const f = object(item); return { name: string(f.name), text: string(f.text) }; });
  if (files.length > 10000 || files.reduce((n, f) => n + f.text.length, 0) > 32 * 2 ** 20) throw new Error("Choose at most 32 MB of session files.");
  return files;
}
function importEstimate(value: unknown): ImportEstimate {
  const v = object(value);
  return { sessions: integer(v.sessions), messages: integer(v.messages), compactions: integer(v.compactions) };
}
function importMark(value: unknown): ImportMark {
  const v = object(value);
  return { run: id(v.run), session: string(v.session), message: string(v.message) };
}
function memoryLine(value: unknown): MemoryLine {
  const v = object(value);
  return { ...part(v), text: string(v.text) };
}
function part(value: unknown): Part {
  const v = object(value);
  const l = integer(v.l);
  if (l > 52) throw new Error("Part level exceeds 52");
  return { l, i: integer(v.i) };
}
function scheduledMark(value: unknown): { schedule: string; late: boolean } {
  const v = object(value);
  return { schedule: id(v.schedule), late: boolean(v.late) };
}
export function parseEntry(value: unknown): Entry {
  const v = object(value);
  const from = object(v.from);
  const date = string(v.date);
  if (!Number.isFinite(Date.parse(date))) throw new Error("Expected a date");
  return {
    i: integer(v.i), kind: oneOf(v.kind, ["user", "unii", "tool", "echo", "work", "note", "ai"]), text: string(v.text), date,
    from: { machine: id(from.machine), seq: integer(from.seq) },
    ...(v.images === undefined ? {} : { images: list(v.images, string) }),
    ...(v.imported === undefined ? {} : { imported: importMark(v.imported) }),
    ...(v.scheduled === undefined ? {} : { scheduled: scheduledMark(v.scheduled) }),
  };
}
export function parseClientMessage(value: unknown): ClientMessage {
  const v = object(value);
  if (v.type === "hello") {
    if (v.device !== null) throw new Error("Device must be null in protocol v1");
    return { type: "hello", version: version(v.version), kind: oneOf(v.kind, ["web", "term"]), device: null, token: nullable(v.token, string) };
  }
  const requestId = id(v.id);
  if (v.type === "act") {
    const base = { type: "act", id: requestId } as const;
    switch (v.act) {
      case "say": return { ...base, act: "say", text: string(v.text), ...(v.images === undefined ? {} : { images: list(v.images, string) }) };
      case "stop": return { ...base, act: "stop", subagent: nullable(v.subagent, id) };
      case "goal": return { ...base, act: "goal", text: nullable(v.text, string) };
      case "pick": return { ...base, act: "pick", pick: parsePick(v.pick) };
      case "reload": return { ...base, act: "reload" };
      case "answer": return { ...base, act: "answer", approval: id(v.approval), choice: oneOf(v.choice, ["once", "always", "deny"]) };
      case "import": return { ...base, act: "import", source: oneOf(v.source, ["claude-code", "codex", "claude.ai", "chatgpt"]), path: string(v.path), ...(v.files === undefined ? {} : { files: importFiles(v.files) }) };
      case "go": return { ...base, act: "go", import: id(v.import), paused: boolean(v.paused) };
      case "schedule": return { ...base, act: "schedule", schedule: parseScheduleSpec(v.schedule) };
      case "unschedule": return { ...base, act: "unschedule", schedule: id(v.schedule) };
      case "pause": return { ...base, act: "pause", schedule: id(v.schedule), paused: boolean(v.paused) };
      case "accept": return { ...base, act: "accept", schedule: id(v.schedule) };
      default: throw new Error("Unknown act");
    }
  }
  if (v.type === "read") {
    const base = { type: "read", id: requestId } as const;
    switch (v.read) {
      case "zoom": return { ...base, read: "zoom", part: part(v.part) };
      case "root": return { ...base, read: "root" };
      case "roots": return { ...base, read: "roots" };
      case "subagent": return { ...base, read: "subagent", name: id(v.name) };
      case "import": return { ...base, read: "import", source: oneOf(v.source, ["claude-code", "codex", "claude.ai", "chatgpt"]), path: string(v.path), ...(v.files === undefined ? {} : { files: importFiles(v.files) }) };
      case "when": return { ...base, read: "when", text: string(v.text), zone: string(v.zone) };
      default: throw new Error("Unknown read");
    }
  }
  throw new Error("Unknown client message");
}
export function parseEvent(value: unknown): Event {
  const v = object(value);
  switch (v.type) {
    case "ready": return { type: "ready", version: version(v.version) };
    case "refused": return { type: "refused", reason: string(v.reason) };
    case "entry": return { type: "entry", entry: parseEntry(v.entry) };
    case "subagent-entry": return { type: "subagent-entry", name: id(v.name), entry: parseEntry(v.entry) };
    case "live": return { type: "live", text: string(v.text), subagent: nullable(v.subagent, string) };
    case "view": return { type: "view", parts: list(v.parts, part), ...(v.lines === undefined ? {} : { lines: list(v.lines, memoryLine) }), ...(v.turn === undefined ? {} : { turn: integer(v.turn) }) };
    case "ask": return { type: "ask", id: id(v.id), tool: id(v.tool), input: object(v.input) };
    case "ask-closed": return { type: "ask-closed", id: id(v.id) };
    case "approval": return { type: "approval", id: id(v.id), tool: id(v.tool), input: object(v.input) };
    case "answer":
      return boolean(v.ok)
        ? { type: "answer", id: id(v.id), ok: true, entry: nullable(v.entry, integer) }
        : { type: "answer", id: id(v.id), ok: false, reason: string(v.reason) };
    case "read": return { type: "read", id: id(v.id), entries: list(v.entries, parseEntry), parts: list(v.parts, part), lines: list(v.lines, memoryLine), ...(v.live === undefined ? {} : { live: string(v.live) }), ...(v.error === undefined ? {} : { error: string(v.error) }) };
    case "import-estimate": return { type: "import-estimate", id: id(v.id), estimate: importEstimate(v.estimate) };
    case "imports": return { type: "imports", imports: list(v.imports, (item) => { const run = object(item); return { ...importEstimate(run), id: id(run.id), phase: oneOf(run.phase, ["running", "paused", "complete"]) }; }) };
    case "error": return { type: "error", id: nullable(v.id, id), reason: string(v.reason) };
    case "agents": return { type: "agents", agents: list(v.agents, (item) => { const a = object(item); return { name: id(a.name), busy: boolean(a.busy), about: string(a.about) }; }) };
    case "skills": return { type: "skills", skills: list(v.skills, (item) => { const k = object(item); return { name: id(k.name), description: string(k.description), argumentHint: string(k.argumentHint) }; }) };
    case "schedules": return { type: "schedules", schedules: list(v.schedules, scheduleView) };
    case "when": return { type: "when", id: id(v.id), when: parseWhen(v.when), text: string(v.text), next: list(v.next, instant) };
    case "state": {
      const s = object(v.state);
      const usage = (value: unknown): Usage => {
        const u = object(value);
        return { input: integer(u.input), cacheRead: integer(u.cacheRead), cacheWrite: integer(u.cacheWrite), output: integer(u.output) };
      };
      return { type: "state", state: { busy: boolean(s.busy), wait: string(s.wait), goal: nullable(s.goal, string), pick: nullable(s.pick, parsePick), subagents: list(s.subagents, id), ...(s.subagentNames === undefined ? {} : { subagentNames: list(s.subagentNames, id) }), usage: nullable(s.usage, usage), ...(s.compression === undefined ? {} : { compression: usage(s.compression) }), ...(s.context === undefined ? {} : { context: s.context === "overflow" ? "overflow" : nullable(s.context, (value) => { const c = object(value); return { used: integer(c.used), window: integer(c.window) }; }) }) } };
    }
    default: throw new Error("Unknown event");
  }
}
