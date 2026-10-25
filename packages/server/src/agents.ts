// Agent reports and log notes follow UniiChat Tools.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
import fs from "node:fs";
import path from "node:path";
import { parseEntry, type Entry, type Event } from "@membr/protocol";
import { type Ask, type Effort, type Engine, type Epoch, type EpochOptions } from "./engine.ts";
import { identity } from "./log.ts";
import { appendFile, truncateFile } from "./durable.ts";
import { pump } from "./pump.ts";

export type Task = { name: string; task: string };
export type AgentTools = { spawn(tasks: Task[], effort?: Effort): string; tell(name: string, message: string): string };
// A subagent does one task. Its session lives only as long as this run: new work goes to a new subagent.
type Run = { phase: "running" | "stopping"; session: Epoch; sent: number; replies: string[]; halt: AbortController };
type Agent = { name: string; entries: Entry[]; state: Run | { phase: "finished" }; live: string; failure?: unknown };
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

export class Agents implements AgentTools {
  private readonly registry = new Map<string, Agent>();
  private readonly dir: string;
  private readonly machine: string;
  private closed = false;
  private readonly restarted: Agent[] = [];

  constructor(dir: string, private readonly engine: Engine, private readonly options: () => EpochOptions, private readonly view: () => string, private readonly ask: Ask, private readonly emit: (event: Event) => void, private readonly change: () => void, private readonly report: (text: string, stopped: boolean) => void) {
    this.dir = path.join(dir, "docs", "agent");
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
        if (entry.i !== i) throw new Error(`Invalid agent log ${name}`);
        return entry;
      });
      if (end < data.length) truncateFile(full, Buffer.byteLength(data.slice(0, end)));
      const agent: Agent = { name, entries, state: { phase: "finished" }, live: "" };
      this.registry.set(name, agent);
      // finish ends every run with a note. Logs written before it did end on the agent's reply,
      // so only a task or a tool step at the end marks a subagent the server stopped mid-run.
      const last = entries.at(-1)?.kind;
      if (last === "user" || last === "tool" || last === "echo") this.restarted.push(agent);
    }
  }

  // Records in the main chat each subagent the restart stopped, once: its stop note makes the next start
  // see it as finished. Like a turn the restart cut off, it starts no new turn.
  reportRestarted(): void {
    for (const agent of this.restarted.splice(0)) {
      this.append(agent, "note", RESTARTED);
      this.report(`[${agent.name}] report\n${RESTARTED}\nFull chat: zoom("${agent.name}")`, true);
    }
  }

  get active(): string[] { return [...this.registry.values()].filter((agent) => agent.state.phase === "running" || agent.state.phase === "stopping").map((agent) => agent.name); }
  get names(): string[] { return [...this.registry.keys()]; }
  has(name: string): boolean { return this.registry.has(name); }
  read(name: string): { entries: Entry[]; live: string } | null {
    const agent = this.registry.get(name);
    return agent ? { entries: agent.entries.slice(), live: agent.live } : null;
  }

  spawn(tasks: Task[], effort?: Effort): string {
    if (this.closed) throw new Error("The chat is closed");
    if (!tasks.length) return "No tasks.";
    const names = tasks.map(({ name: wanted, task }) => {
      const name = this.freeName(wanted);
      const agent: Agent = { name, entries: [], state: { phase: "finished" }, live: "" };
      const fd = fs.openSync(path.join(this.dir, name + ".jsonl"), "wx", 0o600);
      fs.closeSync(fd);
      this.registry.set(name, agent);
      this.append(agent, "note", "subagent" + (effort ? " at effort " + effort : ""));
      this.start(agent, task, effort);
      return name;
    });
    return "Started " + names.join(", ") + ". Each one's report will reach you as a message when it finishes.";
  }

  tell(name: string, message: string): string {
    if (this.closed) throw new Error("The chat is closed");
    const agent = this.registry.get(name);
    if (!agent) return "No agent " + name + " to tell.";
    if (agent.state.phase === "stopping") return name + " is stopping.";
    if (agent.state.phase === "finished") return name + " has finished. Spawn a new agent with the context it needs.";
    this.send(agent, agent.state, message, "next");
    return "Sent. " + name + " reads it between its tool calls, and its report answers it.";
  }

  stop(name: string | null): void {
    for (const agent of this.registry.values()) {
      if (name !== null && agent.name !== name || agent.state.phase !== "running") continue;
      const run = agent.state;
      run.phase = "stopping";
      run.halt.abort();
      void run.session.interrupt().then(() => {
        if (agent.state === run) this.finish(agent, run, "Stopped.");
      }).catch((error) => this.failed(agent, run, error));
    }
    this.change();
  }

  close(): void {
    this.closed = true;
    for (const agent of this.registry.values()) {
      if (agent.state.phase === "finished") continue;
      agent.state.halt.abort();
      agent.state.session.close();
      agent.state = { phase: "finished" };
    }
  }

  // Lowercases the name the model gave into a file-safe slug, and adds -2, -3, … when an earlier agent has it.
  // Taken names compare without case, because older logs such as Agent1.jsonl share a case-blind file system.
  private freeName(wanted: string): string {
    const base = wanted.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 56) || "agent";
    const taken = new Set([...this.registry.keys()].map((name) => name.toLowerCase()));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    return name;
  }

  private start(agent: Agent, task: string, effort: Effort | undefined): void {
    const halt = new AbortController();
    const { agents: _, ...options } = this.options();
    const session = this.engine.open(this.view() + `\n\nYou are subagent ${agent.name}.`, { ...options, append: options.append + "\n\n" + SUB_HEAD, pick: { ...options.pick, effort: effort ?? options.pick.effort }, ask: (tool, input, signal) => {
      if (agent.state.phase !== "running") return Promise.resolve(false);
      return this.ask(tool, input, signal ? AbortSignal.any([signal, halt.signal]) : halt.signal);
    } });
    const run: Run = { phase: "running", session, sent: 0, replies: [], halt };
    agent.state = run;
    void this.listen(agent, run);
    this.send(agent, run, task, "now");
  }

  private send(agent: Agent, run: Run, text: string, priority: "now" | "next"): void {
    try {
      this.append(agent, "user", text);
      run.sent = run.session.send(text, priority, "membr");
      this.change();
    } catch (error) { this.failed(agent, run, error); }
  }

  private listen(agent: Agent, run: Run): Promise<void> {
    return pump(run.session, "agent", {
      guard: () => this.closed || agent.state !== run ? "stop" : "take",
      session: () => {},
      live: (text) => { agent.live += text; this.emit({ type: "live", agent: agent.name, text }); },
      entry: (kind, text) => {
        this.append(agent, kind, text);
        if (kind === "unii") agent.live = "";
      },
      end: (event) => {
        run.replies.push(event.error === null ? event.reply : "failed: " + event.error);
        if (run.phase === "running" && event.through >= run.sent) this.finish(agent, run);
      },
      expectsEvents: () => true,
      fail: (error) => this.failed(agent, run, error),
    });
  }

  private finish(agent: Agent, run: Run, note?: string): void {
    this.append(agent, "note", note ?? "Finished.");
    if (note) run.replies.push(note);
    this.end(agent, run);
    this.report(`[${agent.name}] report\n${run.replies.filter(Boolean).join("\n\n")}\nFull chat: zoom("${agent.name}")`, run.phase === "stopping");
  }

  private failed(agent: Agent, run: Run, error: unknown): void {
    if (agent.state !== run) return;
    try { this.finish(agent, run, "failed: " + (error instanceof Error ? error.message : String(error))); }
    catch (failure) {
      agent.failure = failure;
      this.end(agent, run);
      this.emit({ type: "error", id: null, reason: String(failure) });
    }
  }

  private end(agent: Agent, run: Run): void {
    run.halt.abort();
    run.session.close();
    agent.state = { phase: "finished" };
    agent.live = "";
    this.change();
  }

  private append(agent: Agent, kind: Entry["kind"], text: string): void {
    if (agent.failure) throw agent.failure;
    const entry: Entry = { i: agent.entries.length, kind, text, date: new Date().toISOString(), from: { machine: this.machine, seq: agent.entries.length } };
    try { appendFile(path.join(this.dir, agent.name + ".jsonl"), JSON.stringify(entry) + "\n"); }
    catch (error) { agent.failure = error; throw error; }
    agent.entries.push(entry);
    this.emit({ type: "agent-entry", name: agent.name, entry });
  }
}
