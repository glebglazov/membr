// Local session readers and estimate adapted from UniiChat Import.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Act, Answer, Entry, Event, ImportEstimate, ImportFile, ImportInput, ImportSource, ImportStatus } from "@membr/protocol";
import type { Log } from "./log.ts";
import type { Tree } from "./tree.ts";

type Message = { id: string; text: string; date: string };
type Session = { id: string; name: string; messages: Message[] };
type Imported = { kind: "note" | "ai"; text: string; date: string; session: string; message: string };
const INJECTED = /^(<[a-z_]+[ >]|# AGENTS\.md)/;
const SKIP = /^(<command-|<local-command|\[Request interrupted)/;
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function parts(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map((item) => { const p = object(item); return typeof item === "string" ? item : typeof p.text === "string" ? p.text : text(p.type).includes("image") ? "[image]" : ""; }).filter(Boolean).join("\n") : "";
}
function date(value: unknown, last: string): string {
  if (value === undefined) return last;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(String(value));
  if (typeof value === "number" && (!Number.isFinite(ms) || Math.abs(ms) > 8640000000000000)) return "";
  return Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? new Date(ms).toISOString() : last;
}

function session(file: ImportFile, source: ImportSource): Session | null {
  const rows: Array<{ row: Record<string, unknown>; n: number }> = [];
  for (const [n, line] of file.text.split("\n").entries()) {
    try { rows.push({ row: object(JSON.parse(line)), n }); } catch {}
  }
  const meta = rows.find(({ row }) => row.type === "session_meta")?.row;
  const payload = object(meta?.payload);
  const origin = object(payload.source);
  if (source === "codex" && (origin.subagent || origin.internal)) return null;
  const first = rows.find(({ row }) => typeof row.sessionId === "string")?.row;
  const id = source + ":" + (text(source === "codex" ? payload.id : first?.sessionId) || path.basename(file.name, ".jsonl"));
  let where = text(payload.cwd), last = "";
  const messages: Message[] = [];
  for (const { row: j, n } of rows) {
    const at = date(j.timestamp, last);
    if (!at) continue;
    last = at;
    where ||= text(j.cwd);
    const emit = (role: string, value: string, block = "0") => {
      if (!value.trim()) return;
      const native = text(j.uuid) || text(object(j.payload).id) || String(n);
      for (let start = 0, page = 0; start < value.length; page++) {
        let end = Math.min(start + 30000, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        messages.push({ id: `${native}:${block}:${page}`, text: `${role}: ${value.slice(start, end)}`, date: at });
        start = end;
      }
    };
    if (source === "claude-code") {
      const attachment = object(j.attachment);
      if (j.type === "attachment" && attachment.type === "queued_command") { emit("user", text(attachment.prompt)); continue; }
      if ((j.type !== "user" && j.type !== "assistant") || j.isMeta || j.isSidechain || j.isCompactSummary) continue;
      const content = object(j.message).content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(object) : [];
      emit(j.type, parts(blocks.filter((b) => b.type === "image" || b.type === "text" && !SKIP.test(text(b.text)))));
      for (const [i, b] of blocks.entries()) {
        if (b.type === "tool_use") emit("tool", text(b.name) + " " + JSON.stringify(b.input), `tool-${i}`);
        if (b.type === "tool_result") emit("echo", parts(b.content), `tool-${i}`);
      }
    } else if (j.type === "response_item") {
      const p = object(j.payload);
      if (p.type === "message" && (p.role === "user" || p.role === "assistant") && p.channel !== "analysis" && p.channel !== "reasoning") {
        emit(p.role, parts(Array.isArray(p.content) ? p.content.filter((c) => !INJECTED.test(text(object(c).text))) : p.content));
      } else if (p.type === "function_call") emit("tool", text(p.name) + " " + text(p.arguments));
      else if (p.type === "custom_tool_call") emit("tool", text(p.name) + " " + JSON.stringify({ input: p.input }));
      else if (p.type === "local_shell_call") emit("tool", "shell " + JSON.stringify({ command: object(p.action).command }));
      else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") emit("echo", parts(p.output));
    }
  }
  messages.sort((a, b) => a.date.localeCompare(b.date));
  return messages.length ? { id, name: `${source === "claude-code" ? "Claude Code" : "Codex"} session in ${where || "unknown folder"}`, messages } : null;
}

async function files(input: ImportInput): Promise<ImportFile[]> {
  const accepted = (name: string) => name.endsWith(".jsonl") && !name.split(/[\\/]/).includes("subagents");
  if (input.files) return input.files.filter((file) => accepted(file.name));
  const root = input.path || (input.source === "claude-code" ? "~/.claude/projects" : "~/.codex");
  const expanded = root === "~" ? os.homedir() : root.startsWith("~/") ? path.join(os.homedir(), root.slice(2)) : path.resolve(root);
  const found: ImportFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === "subagents" || item.isSymbolicLink()) continue;
      const name = path.join(dir, item.name);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile() && accepted(name)) {
        found.push({ name, text: await fs.readFile(name, "utf8") });
      }
    }
  };
  if (input.source === "codex" && path.basename(expanded) === ".codex") {
    for (const folder of ["sessions", "archived_sessions"]) {
      try { await walk(path.join(expanded, folder)); } catch (error) { if (object(error).code !== "ENOENT") throw error; }
    }
  } else await walk(expanded);
  return found;
}

function estimate(log: Log, tree: Tree, entries: Imported[]): ImportEstimate {
  const older = (l: number, i: number): number => {
    const saved = tree.read({ l, i });
    if (saved !== null) return Buffer.byteLength(saved);
    if (l === 0) { const entry = log.read(i)!; const bytes = Buffer.byteLength(`${entry.kind}: ${entry.text}`); return bytes > 512 ? 480 : bytes; }
    const bytes = older(l - 1, i * 2) + 1 + older(l - 1, i * 2 + 1);
    return bytes > 512 ? 480 : bytes;
  };
  let calls = 0, level = 0;
  let nodes = entries.map((entry) => Buffer.byteLength(`${entry.kind}: ${entry.text}`));
  for (let offset = log.count; nodes.length; offset = Math.floor(offset / 2), level++) {
    const lines = nodes.map((bytes) => { if (bytes > 512) { calls++; return 480; } return bytes; });
    const next: number[] = [];
    if (offset % 2 && lines.length) next.push(older(level, offset - 1) + 1 + lines[0]);
    for (let i = offset % 2; i + 1 < lines.length; i += 2) next.push(lines[i] + 1 + lines[i + 1]);
    nodes = next;
  }
  return { sessions: new Set(entries.map((entry) => entry.session)).size, messages: entries.filter((entry) => entry.kind === "ai").length, compactions: calls };
}

export class Imports {
  private queue = Promise.resolve();
  private closed = false;
  private shown = "";
  constructor(private readonly log: Log, private readonly tree: Tree, private readonly emit: (event: Event) => void, private readonly record: (entries: Entry[]) => void) {}

  async plan(input: ImportInput): Promise<{ entries: Imported[]; estimate: ImportEstimate }> {
    const sessions = (await files(input)).map((file) => session(file, input.source)).filter((s): s is Session => s !== null).sort((a, b) => a.messages[0].date.localeCompare(b.messages[0].date) || a.id.localeCompare(b.id));
    const keys = new Set<string>();
    const entries: Imported[] = [];
    for (const s of sessions) {
      const fresh = s.messages.filter((message) => {
        const key = JSON.stringify([s.id, message.id]);
        if (keys.has(key) || this.log.hasImported(s.id, message.id)) return false;
        keys.add(key); return true;
      });
      if (!fresh.length) continue;
      if (!this.log.hasImported(s.id, "note") && !keys.has(JSON.stringify([s.id, "note"]))) {
        entries.push({ kind: "note", text: `${s.name}, from ${s.messages[0].date} (imported)`, date: s.messages[0].date, session: s.id, message: "note" });
        keys.add(JSON.stringify([s.id, "note"]));
      }
      entries.push(...fresh.map((m) => ({ kind: "ai" as const, text: m.text, date: m.date, session: s.id, message: m.id })));
    }
    return { entries, estimate: estimate(this.log, this.tree, entries) };
  }

  act(act: Extract<Act, { act: "import" | "go" }>): Promise<Answer> {
    const result = this.queue.then(async () => {
      const previous = this.log.answer(act.id);
      if (previous) return previous;
      try {
        if (this.closed) throw new Error("The import service is closed.");
        if (act.act === "go") {
          if (!this.log.importRuns.has(act.import)) throw new Error("No import " + act.import + ".");
          const answer = this.log.controlImport(act);
          this.tree.sync(); this.changed(); return answer;
        }
        if (act.source !== "claude-code" && act.source !== "codex") throw new Error("Choose Claude Code or Codex sessions.");
        const plan = await this.plan({ ...act, source: act.source });
        const answered = this.log.answer(act.id);
        if (answered) return answered;
        if (this.closed) throw new Error("The import service is closed.");
        this.log.beginImport(act.id, plan.estimate);
        const entries = plan.entries.map((entry) => this.log.importEntry(act.id, entry));
        const answer = this.log.acceptImport(act, plan.estimate);
        this.record(entries); this.tree.sync(); this.changed();
        return answer;
      } catch (error) {
        return this.log.apply(act, this.log.count, error instanceof Error ? error.message : "The import failed.").answer;
      }
    });
    this.queue = result.then(() => {});
    return result;
  }

  get status(): ImportStatus[] {
    return [...this.log.importRuns].map(([id, run]) => ({ ...run.estimate, id, phase: !this.tree.pendingImport(id) ? "complete" : run.paused ? "paused" : "running" }));
  }
  changed(): void { const imports = this.status, shown = JSON.stringify(imports); if (shown !== this.shown) { this.shown = shown; this.emit({ type: "imports", imports }); } }
  close(): Promise<void> { this.closed = true; return this.queue; }
}
