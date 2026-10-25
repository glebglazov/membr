import type { Entry } from "@membr/protocol";

// One tool call and its result, paired from a tool entry and its echo entry.
export type Call = { i: number; tool: string; what: string; input: unknown; result: { text: string; error: boolean } | null };
// A brief stands for technical entries in the chat: it reads as one line and opens to the detail.
export type Brief =
  | { kind: "tools"; i: number; calls: Call[] }
  | { kind: "spawn"; i: number; call: Call; agents: { name: string; task: string }[] }
  | { kind: "report"; i: number; agent: string; text: string }
  | { kind: "note"; i: number; text: string };
export type Item = { kind: "message"; entry: Entry } | { kind: "brief"; brief: Brief };

type Pending = { id: string | null; call: Call };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function json(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : value;
}
function firstLine(value: string): string { return value.trim().split("\n")[0]; }

// The one argument that says what a call did, such as the file it read or the command it ran.
function describe(tool: string, input: unknown): string {
  const fields = object(input);
  switch (tool) {
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return shortPath(string(fields.file_path) || string(fields.notebook_path));
    case "Bash": return firstLine(string(fields.description) || string(fields.command));
    case "Grep": return `"${string(fields.pattern)}"` + (fields.path ? " in " + shortPath(string(fields.path)) : "");
    case "Glob": return string(fields.pattern);
    case "WebFetch": return string(fields.url);
    case "WebSearch": return string(fields.query);
    case "zoom": return typeof fields.id === "string" ? `${fields.id}'s chat` : `messages from ${fields.id}` + (typeof fields.n === "number" && fields.n > 1 ? `, ${fields.n} of them` : "");
    case "date": return `message ${fields.id}`;
    case "tell": return `${string(fields.name)}: ${firstLine(string(fields.message))}`;
  }
  const first = Object.values(fields).find((value) => typeof value === "string");
  return typeof first === "string" ? firstLine(first) : "";
}

// Tool entries are {id, name, input} JSON from the engine, or "name input" text from an imported chat.
function call(entry: Entry): Pending {
  const parsed = object(json(entry.text));
  let name = string(parsed.name), input: unknown = parsed.input, id: string | null = string(parsed.id) || null;
  if (!name) {
    const space = entry.text.indexOf(" ");
    name = space < 0 ? entry.text : entry.text.slice(0, space);
    const rest = space < 0 ? "" : entry.text.slice(space + 1);
    input = json(rest) ?? { text: rest };
    id = null;
  }
  const tool = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return { id, call: { i: entry.i, tool, what: describe(tool, input), input, result: null } };
}

// Echo entries are {id, text, error} JSON from the engine, or plain text from an imported chat.
function echo(entry: Entry): { id: string | null; text: string; error: boolean } {
  const parsed = object(json(entry.text));
  return typeof parsed.text === "string"
    ? { id: string(parsed.id) || null, text: parsed.text, error: parsed.error === true }
    : { id: null, text: entry.text, error: false };
}

function spawned(call: Call): { name: string; task: string }[] {
  const tasks = Array.isArray(object(call.input).tasks) ? object(call.input).tasks as unknown[] : [];
  const asked = tasks.map((task) => typeof task === "string" ? { name: "", task } : { name: string(object(task).name), task: string(object(task).task) });
  const started = /^Started (.+?)\. /.exec(call.result?.text ?? "")?.[1].split(", ");
  return asked.map((task, index) => ({ name: started?.[index] ?? task.name, task: task.task }));
}

function report(entry: Entry): Brief {
  const head = /^\[([^\]]+)\] (?:report|reply)\n/.exec(entry.text);
  if (!head) return { kind: "note", i: entry.i, text: entry.text };
  return { kind: "report", i: entry.i, agent: head[1], text: entry.text.slice(head[0].length).replace(/\nFull chat: zoom\("[^"]*"\)$/, "") };
}

// Folds each run of tool and echo entries into one brief, with each spawn call as a brief of its own,
// and makes each report and note a brief.
export function brief(entries: Entry[]): Item[] {
  const out: Item[] = [];
  const add = (brief: Brief) => out.push({ kind: "brief", brief });
  let run: Pending[] = [];
  const flush = () => {
    let calls: Call[] = [];
    for (const { call } of run) {
      if (call.tool !== "spawn") { calls.push(call); continue; }
      if (calls.length) add({ kind: "tools", i: calls[0].i, calls });
      calls = [];
      add({ kind: "spawn", i: call.i, call, agents: spawned(call) });
    }
    if (calls.length) add({ kind: "tools", i: calls[0].i, calls });
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") { run.push(call(entry)); continue; }
    if (entry.kind === "echo") {
      const result = echo(entry);
      const open = run.find((pending) => pending.call.result === null && result.id !== null && pending.id === result.id)
        ?? (result.id === null ? run.findLast((pending) => pending.call.result === null) : undefined);
      if (open) open.call.result = { text: result.text, error: result.error };
      else run.push({ id: result.id, call: { i: entry.i, tool: "result", what: "of an earlier call", input: {}, result: { text: result.text, error: result.error } } });
      continue;
    }
    flush();
    if (entry.kind === "work") add(report(entry));
    else if (entry.kind === "note") add({ kind: "note", i: entry.i, text: entry.text });
    else out.push({ kind: "message", entry });
  }
  flush();
  return out;
}
