export const VERSION = "1.0";

export type Hello = { type: "hello"; version: string; kind: "web" | "term"; device: null; token: string | null };
export type Pick = { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; fast: boolean };
export type Part = { l: number; i: number };
export type Entry = {
  i: number;
  kind: "user" | "unii" | "tool" | "echo" | "work" | "note";
  text: string;
  date: string;
  from: { machine: string; seq: number };
  images?: string[];
};
export type Act = { type: "act"; id: string } & (
  | { act: "say"; text: string; images?: string[] }
  | { act: "stop"; agent: string | null }
  | { act: "goal"; text: string | null }
  | { act: "pick"; pick: Pick }
  | { act: "answer"; approval: string; choice: "once" | "always" | "deny" }
  | { act: "import"; source: "claude-code" | "codex" | "claude.ai" | "chatgpt"; path: string }
  | { act: "go"; import: string; paused: boolean }
);
export type Read = { type: "read"; id: string } & (
  | { read: "zoom"; part: Part }
  | { read: "roots" }
  | { read: "agent"; name: string }
);
export type Answer = { type: "answer"; id: string } & (
  | { ok: true; entry: number | null }
  | { ok: false; reason: string }
);
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type State = { busy: boolean; wait: string; goal: string | null; pick: Pick | null; agents: string[]; usage: Usage | null };
export type Event =
  | { type: "ready"; version: string }
  | { type: "refused"; reason: string }
  | { type: "entry"; entry: Entry }
  | { type: "live"; text: string; agent: string | null }
  | { type: "view"; parts: Part[] }
  | { type: "approval"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "state"; state: State }
  | Answer
  | { type: "read"; id: string; entries: Entry[]; parts: Part[] }
  | { type: "error"; id: string | null; reason: string };
export type ClientMessage = Hello | Act | Read;

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
function version(value: unknown): string {
  const result = string(value);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(result)) throw new Error("Expected a protocol version such as 1.0");
  return result;
}
function pick(value: unknown): Pick {
  const v = object(value);
  return { model: id(v.model), effort: oneOf(v.effort, ["low", "medium", "high", "xhigh", "max"]), fast: boolean(v.fast) };
}
function part(value: unknown): Part {
  const v = object(value);
  const l = integer(v.l);
  if (l > 52) throw new Error("Part level exceeds 52");
  return { l, i: integer(v.i) };
}
export function parseEntry(value: unknown): Entry {
  const v = object(value);
  const from = object(v.from);
  const date = string(v.date);
  if (!Number.isFinite(Date.parse(date))) throw new Error("Expected a date");
  return {
    i: integer(v.i), kind: oneOf(v.kind, ["user", "unii", "tool", "echo", "work", "note"]), text: string(v.text), date,
    from: { machine: id(from.machine), seq: integer(from.seq) },
    ...(v.images === undefined ? {} : { images: list(v.images, string) }),
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
      case "stop": return { ...base, act: "stop", agent: nullable(v.agent, id) };
      case "goal": return { ...base, act: "goal", text: nullable(v.text, string) };
      case "pick": return { ...base, act: "pick", pick: pick(v.pick) };
      case "answer": return { ...base, act: "answer", approval: id(v.approval), choice: oneOf(v.choice, ["once", "always", "deny"]) };
      case "import": return { ...base, act: "import", source: oneOf(v.source, ["claude-code", "codex", "claude.ai", "chatgpt"]), path: id(v.path) };
      case "go": return { ...base, act: "go", import: id(v.import), paused: boolean(v.paused) };
      default: throw new Error("Unknown act");
    }
  }
  if (v.type === "read") {
    const base = { type: "read", id: requestId } as const;
    switch (v.read) {
      case "zoom": return { ...base, read: "zoom", part: part(v.part) };
      case "roots": return { ...base, read: "roots" };
      case "agent": return { ...base, read: "agent", name: id(v.name) };
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
    case "live": return { type: "live", text: string(v.text), agent: nullable(v.agent, string) };
    case "view": return { type: "view", parts: list(v.parts, part) };
    case "approval": return { type: "approval", id: id(v.id), tool: id(v.tool), input: object(v.input) };
    case "answer":
      return boolean(v.ok)
        ? { type: "answer", id: id(v.id), ok: true, entry: nullable(v.entry, integer) }
        : { type: "answer", id: id(v.id), ok: false, reason: string(v.reason) };
    case "read": return { type: "read", id: id(v.id), entries: list(v.entries, parseEntry), parts: list(v.parts, part) };
    case "error": return { type: "error", id: nullable(v.id, id), reason: string(v.reason) };
    case "state": {
      const s = object(v.state);
      const usage = nullable(s.usage, (value): Usage => {
        const u = object(value);
        return { input: integer(u.input), cacheRead: integer(u.cacheRead), cacheWrite: integer(u.cacheWrite), output: integer(u.output) };
      });
      return { type: "state", state: { busy: boolean(s.busy), wait: string(s.wait), goal: nullable(s.goal, string), pick: nullable(s.pick, pick), agents: list(s.agents, id), usage } };
    }
    default: throw new Error("Unknown event");
  }
}
