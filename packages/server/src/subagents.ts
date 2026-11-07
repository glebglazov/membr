// Subagent reports and log notes follow UniiChat Tools.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
import fs from "node:fs";
import path from "node:path";
import { parseEntry, type Entry, type Event } from "@membr/protocol";
import { type Effort, type Engine, type Epoch, type EpochOptions, type From } from "./engine.ts";
import { identity } from "./log.ts";
import { appendFile, truncateFile } from "./durable.ts";
import { pump } from "./pump.ts";

// from is the voice of the first message. A run with a schedule, or spawned in a scheduled turn, is unattended.
export type Task = { name: string; task: string; from?: From; schedule?: string };
type Ask = (tool: string, input: Record<string, unknown>, signal: AbortSignal, unattended: boolean) => Promise<boolean>;
export type SubagentTools = { spawn(tasks: Task[], effort?: Effort): string; tell(name: string, message: string): string };
// A subagent does one task. Its session lives only as long as this run: new work goes to a new subagent.
type Run = { phase: "running" | "stopping"; session: Epoch; sent: number; replies: string[]; halt: AbortController; schedule?: string; origin?: string };
type Subagent = { name: string; entries: Entry[]; state: Run | { phase: "finished" }; live: string; failure?: unknown };
const SUB_HEAD = `You are a subagent of membr, an AI agent that works for one user in a
single chat that never ends. membr gave you a task. Do it yourself, with
your tools, following the user's instructions in this prompt.

Your first message holds the main view, then your chat with membr so far,
its lines as "i|kind: text". Use the view as context only. Do what your task
says, not what the user's last message says. membr may have given you only
part of the work. Your final reply is your report to membr. membr may send
you more messages while you work. Answer the last message.`;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESTARTED = "Stopped: the server restarted.";

export class Subagents implements SubagentTools {
  private readonly registry = new Map<string, Subagent>();
  private readonly dir: string;
  private readonly machine: string;
  private closed = false;
  private readonly restarted: Subagent[] = [];

  constructor(dir: string, private readonly engine: Engine, private readonly options: () => EpochOptions, private readonly view: () => string, private readonly ask: Ask, private readonly emit: (event: Event) => void, private readonly change: () => void, private readonly report: (text: string, stopped: boolean, schedule?: string) => void) {
    this.dir = path.join(dir, "docs", "subagent");
    // Logs written before the rename live in docs/agent: move that folder over once.
    const legacy = path.join(dir, "docs", "agent");
    if (fs.existsSync(legacy) && !fs.existsSync(this.dir)) fs.renameSync(legacy, this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.machine = identity(dir, "machine");
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith(".jsonl") || !NAME.test(file.slice(0, -6))) continue;
      const name = file.slice(0, -6);
      const full = path.join(this.dir, file);
      const data = fs.readFileSync(full, "utf8");
      const end = data.lastIndexOf("\n") + 1;
      const entries = data.slice(0, end).split("\n").filter(Boolean).map((line, i) => {
        const entry = parseEntry(JSON.parse(line));
        if (entry.i !== i) throw new Error(`Invalid subagent log ${name}`);
        return entry;
      });
      if (end < data.length) truncateFile(full, Buffer.byteLength(data.slice(0, end)));
      const subagent: Subagent = { name, entries, state: { phase: "finished" }, live: "" };
      this.registry.set(name, subagent);
      // finish ends every run with a note. Logs written before it did end on the subagent's reply,
      // so only a task or a tool step at the end marks a subagent the server stopped mid-run.
      const last = entries.at(-1)?.kind;
      if (last === "user" || last === "tool" || last === "echo") this.restarted.push(subagent);
    }
  }

  // Records in the main chat each subagent the restart stopped, once: its stop note makes the next start
  // see it as finished. Like a turn the restart cut off, it starts no new turn.
  reportRestarted(): void {
    for (const subagent of this.restarted.splice(0)) {
      this.append(subagent, "note", RESTARTED);
      this.report(`[${subagent.name}] report\n${RESTARTED}\nFull chat: zoom("${subagent.name}")`, true);
    }
  }

  get active(): string[] { return [...this.registry.values()].filter((subagent) => subagent.state.phase === "running" || subagent.state.phase === "stopping").map((subagent) => subagent.name); }
  get names(): string[] { return [...this.registry.keys()]; }
  has(name: string): boolean { return this.registry.has(name); }
  scheduled(schedule: string): boolean { return [...this.registry.values()].some((subagent) => subagent.state.phase !== "finished" && subagent.state.schedule === schedule); }
  read(name: string): { entries: Entry[]; live: string } | null {
    const subagent = this.registry.get(name);
    return subagent ? { entries: subagent.entries.slice(), live: subagent.live } : null;
  }

  spawn(tasks: Task[], effort?: Effort, unattended = false): string {
    if (this.closed) throw new Error("The chat is closed");
    if (!tasks.length) return "No tasks.";
    const names = tasks.map((task) => {
      const name = this.freeName(task.name);
      const subagent: Subagent = { name, entries: [], state: { phase: "finished" }, live: "" };
      const fd = fs.openSync(path.join(this.dir, name + ".jsonl"), "wx", 0o600);
      fs.closeSync(fd);
      this.registry.set(name, subagent);
      this.append(subagent, "note", "subagent" + (effort ? " at effort " + effort : ""));
      this.start(subagent, task, effort, unattended || task.schedule !== undefined);
      return name;
    });
    return "Started " + names.join(", ") + ". Each one's report will reach you as a message when it finishes.";
  }

  tell(name: string, message: string): string {
    if (this.closed) throw new Error("The chat is closed");
    const subagent = this.registry.get(name);
    if (!subagent) return "No subagent " + name + " to tell.";
    if (subagent.state.phase === "stopping") return name + " is stopping.";
    if (subagent.state.phase === "finished") return name + " has finished. Spawn a new subagent with the context it needs.";
    this.send(subagent, subagent.state, message, "next");
    return "Sent. " + name + " reads it between its tool calls, and its report answers it.";
  }

  stop(name: string | null): void {
    for (const subagent of this.registry.values()) {
      if (name !== null && subagent.name !== name || subagent.state.phase !== "running") continue;
      const run = subagent.state;
      run.phase = "stopping";
      run.halt.abort();
      void run.session.interrupt().then(() => {
        if (subagent.state === run) this.finish(subagent, run, "Stopped.");
      }).catch((error) => this.failed(subagent, run, error));
    }
    this.change();
  }

  close(): void {
    this.closed = true;
    for (const subagent of this.registry.values()) {
      if (subagent.state.phase === "finished") continue;
      subagent.state.halt.abort();
      subagent.state.session.close();
      subagent.state = { phase: "finished" };
    }
  }

  // Lowercases the name the model gave into a file-safe slug, and adds -2, -3, … when an earlier subagent has it.
  // Taken names compare without case, because older logs such as Agent1.jsonl share a case-blind file system.
  private freeName(wanted: string): string {
    const base = wanted.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 56) || "subagent";
    const taken = new Set([...this.registry.keys()].map((name) => name.toLowerCase()));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    return name;
  }

  private start(subagent: Subagent, task: Task, effort: Effort | undefined, unattended: boolean): void {
    const halt = new AbortController();
    const { subagents: _, schedules: __, ...options } = this.options();
    const session = this.engine.open(this.view() + `\n\nYou are subagent ${subagent.name}.`, { ...options, append: options.append + "\n\n" + SUB_HEAD, pick: { ...options.pick, effort: effort ?? options.pick.effort }, ask: (tool, input, signal) => {
      if (subagent.state.phase !== "running") return Promise.resolve(false);
      return this.ask(tool, input, signal ? AbortSignal.any([signal, halt.signal]) : halt.signal, unattended);
    } });
    // The main agent did not spawn a scheduled run, so its report says where it came from.
    const origin = task.schedule === undefined ? {} : { schedule: task.schedule, origin: `Schedule ${task.schedule} started this subagent at its time, with the task ${task.from === "user" ? "the user scheduled" : "you scheduled"}: ${task.task}\nTell the user what it found.\n\n` };
    const run: Run = { phase: "running", session, sent: 0, replies: [], halt, ...origin };
    subagent.state = run;
    void this.listen(subagent, run);
    this.send(subagent, run, task.task, "now", task.from);
  }

  private send(subagent: Subagent, run: Run, text: string, priority: "now" | "next", from: From = "membr"): void {
    try {
      this.append(subagent, "user", text);
      run.sent = run.session.send(text, priority, from);
      this.change();
    } catch (error) { this.failed(subagent, run, error); }
  }

  private listen(subagent: Subagent, run: Run): Promise<void> {
    return pump(run.session, "subagent", {
      guard: () => this.closed || subagent.state !== run ? "stop" : "take",
      session: () => {},
      live: (text) => { subagent.live += text; this.emit({ type: "live", subagent: subagent.name, text }); },
      entry: (kind, text) => {
        this.append(subagent, kind, text);
        if (kind === "unii") subagent.live = "";
      },
      end: (event) => {
        run.replies.push(event.error === null ? event.reply : "failed: " + event.error);
        if (run.phase === "running" && event.through >= run.sent) this.finish(subagent, run);
      },
      expectsEvents: () => true,
      fail: (error) => this.failed(subagent, run, error),
    });
  }

  private finish(subagent: Subagent, run: Run, note?: string): void {
    this.append(subagent, "note", note ?? "Finished.");
    if (note) run.replies.push(note);
    this.end(subagent, run);
    this.report(`[${subagent.name}] report\n${run.origin ?? ""}${run.replies.filter(Boolean).join("\n\n")}\nFull chat: zoom("${subagent.name}")`, run.phase === "stopping", run.schedule);
  }

  private failed(subagent: Subagent, run: Run, error: unknown): void {
    if (subagent.state !== run) return;
    try { this.finish(subagent, run, "failed: " + (error instanceof Error ? error.message : String(error))); }
    catch (failure) {
      subagent.failure = failure;
      this.end(subagent, run);
      this.emit({ type: "error", id: null, reason: String(failure) });
    }
  }

  private end(subagent: Subagent, run: Run): void {
    run.halt.abort();
    run.session.close();
    subagent.state = { phase: "finished" };
    subagent.live = "";
    this.change();
  }

  private append(subagent: Subagent, kind: Entry["kind"], text: string): void {
    if (subagent.failure) throw subagent.failure;
    const entry: Entry = { i: subagent.entries.length, kind, text, date: new Date().toISOString(), from: { machine: this.machine, seq: subagent.entries.length } };
    try { appendFile(path.join(this.dir, subagent.name + ".jsonl"), JSON.stringify(entry) + "\n"); }
    catch (error) { subagent.failure = error; throw error; }
    subagent.entries.push(entry);
    this.emit({ type: "subagent-entry", name: subagent.name, entry });
  }
}
