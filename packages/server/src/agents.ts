// Agent reports and log notes follow UniiChat Tools.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
import fs from "node:fs";
import path from "node:path";
import { parseEntry, type Entry, type Event } from "@membr/protocol";
import type { Ask, Effort, Engine, Epoch, EpochOptions } from "./engine.ts";
import { identity } from "./log.ts";

export type AgentTools = { spawn(tasks: string[], effort?: Effort): string; tell(name: string, message: string): string };
type Run = { phase: "running" | "stopping"; sent: number; replies: string[]; halt: AbortController };
type Agent = { name: string; entries: Entry[]; effort?: Effort; session: Epoch | null; state: Run | { phase: "idle" | "closed" }; live: string; failure?: unknown };
const SUB_HEAD = `You are a subagent of membr, an AI agent that works for one user in a
single chat that never ends. membr gave you a task. Do it yourself, with
your tools, following the user's instructions in this prompt.

Your first message holds the main view, then your chat with membr so far,
its lines as "i|kind: text". Use the view as context only. Do what your task
says, not what the user's last message says. membr may have given you only
part of the work. Your final reply is your report to membr. membr may send
you more messages while you work. Answer the last message.`;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
function effort(value: string): value is Effort { return EFFORTS.includes(value); }

export class Agents implements AgentTools {
  private readonly registry = new Map<string, Agent>();
  private readonly dir: string;
  private readonly machine: string;
  private closed = false;

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
      if (end < data.length) {
        const fd = fs.openSync(full, "r+");
        try { fs.ftruncateSync(fd, Buffer.byteLength(data.slice(0, end))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      const saved = entries[0]?.text.replace(/^subagent at effort /, "");
      this.registry.set(name, { name, entries, ...(saved && effort(saved) ? { effort: saved } : {}), session: null, state: { phase: "idle" }, live: "" });
    }
  }

  get active(): string[] { return [...this.registry.values()].filter((agent) => agent.state.phase === "running" || agent.state.phase === "stopping").map((agent) => agent.name); }
  has(name: string): boolean { return this.registry.has(name); }
  read(name: string): { entries: Entry[]; live: string } | null {
    const agent = this.registry.get(name);
    return agent ? { entries: agent.entries.slice(), live: agent.live } : null;
  }

  spawn(tasks: string[], effort?: Effort): string {
    if (this.closed) throw new Error("The chat is closed");
    if (!tasks.length) return "No tasks.";
    const names = tasks.map((task) => {
      let i = 1;
      while (this.registry.has(`Agent${i}`)) i++;
      const name = `Agent${i}`;
      const agent: Agent = { name, entries: [], effort, session: null, state: { phase: "idle" }, live: "" };
      const fd = fs.openSync(path.join(this.dir, name + ".jsonl"), "wx", 0o600);
      fs.closeSync(fd);
      this.registry.set(name, agent);
      this.append(agent, "note", "subagent" + (effort ? " at effort " + effort : ""));
      this.send(agent, task);
      return name;
    });
    return "Started " + names.join(", ") + ". Each one's report will reach you as a message when it finishes.";
  }

  tell(name: string, message: string): string {
    if (this.closed) throw new Error("The chat is closed");
    const agent = this.registry.get(name);
    if (!agent) return "No agent " + name + " to tell.";
    if (agent.state.phase === "stopping") return name + " is stopping.";
    const running = agent.state.phase === "running";
    this.send(agent, message);
    return running ? "Sent. " + name + " reads it between its tool calls, and its report answers it." : "Sent. " + name + "'s reply will reach you as a message.";
  }

  stop(name: string | null): void {
    for (const agent of this.registry.values()) {
      if (name !== null && agent.name !== name || agent.state.phase !== "running") continue;
      const run = agent.state;
      run.phase = "stopping";
      run.halt.abort();
      void agent.session?.interrupt().then(() => {
        if (agent.state === run) this.finish(agent, run, "Stopped.");
      }).catch((error) => { if (agent.state === run) this.failed(agent, error); });
    }
    this.change();
  }

  close(): void {
    this.closed = true;
    for (const agent of this.registry.values()) {
      if (agent.state.phase === "running" || agent.state.phase === "stopping") agent.state.halt.abort();
      agent.state = { phase: "closed" };
      agent.session?.close();
    }
  }

  private send(agent: Agent, text: string): void {
    if (agent.failure) throw agent.failure;
    const history = agent.entries.map((entry) => `${entry.i}|${entry.kind}: ${entry.text}`).join("\n\n");
    this.append(agent, "user", text);
    const running = agent.state.phase === "running";
    const run: Run = agent.state.phase === "running" ? agent.state : { phase: "running", sent: 0, replies: [], halt: new AbortController() };
    agent.state = run;
    try {
      if (!agent.session) {
        const { agents: _, ...options } = this.options();
        agent.session = this.engine.open(this.view() + `\n\nYou are subagent ${agent.name}.\n` + history, { ...options, append: options.append + "\n\n" + SUB_HEAD, pick: { ...options.pick, effort: agent.effort ?? options.pick.effort }, ask: (tool, input, signal) => {
          if (agent.state.phase !== "running") return Promise.resolve(false);
          return this.ask(tool, input, signal ? AbortSignal.any([signal, agent.state.halt.signal]) : agent.state.halt.signal);
        } });
        void this.listen(agent, agent.session);
      }
      run.sent = agent.session.send(text, running ? "next" : "now", "membr");
      this.change();
    } catch (error) { this.failed(agent, error); }
  }

  private async listen(agent: Agent, session: Epoch): Promise<void> {
    try {
      for await (const event of session.events) {
        if (this.closed || agent.session !== session) return;
        const run = agent.state;
        if (run.phase !== "running" && run.phase !== "stopping") continue;
        switch (event.kind) {
          case "session": break;
          case "delta": agent.live += event.text; this.emit({ type: "live", agent: agent.name, text: event.text }); break;
          case "text": this.append(agent, "unii", event.text); agent.live = ""; break;
          case "tool": this.append(agent, "tool", JSON.stringify({ id: event.id, name: event.name, input: event.input })); break;
          case "echo": this.append(agent, "echo", JSON.stringify({ id: event.id, text: event.text, error: event.error })); break;
          case "compacted": throw new Error("The Engine compacted the agent unexpectedly");
          case "end":
            run.replies.push(event.error === null ? event.reply : "failed: " + event.error);
            if (run.phase === "running" && event.through >= run.sent) this.finish(agent, run);
            break;
        }
      }
      if (!this.closed && agent.session === session) throw new Error("The Engine closed the agent");
    } catch (error) { if (!this.closed && agent.session === session) this.failed(agent, error); }
  }

  private finish(agent: Agent, run: Run, note?: string): void {
    if (note) { this.append(agent, "note", note); run.replies.push(note); }
    const stopped = run.phase === "stopping";
    run.halt.abort();
    agent.state = { phase: "idle" };
    agent.live = "";
    this.change();
    this.report(`[${agent.name}] report\n${run.replies.filter(Boolean).join("\n\n")}\nFull chat: zoom("${agent.name}")`, stopped);
  }

  private failed(agent: Agent, error: unknown): void {
    const run = agent.state;
    agent.session?.close();
    agent.session = null;
    if (run.phase === "running" || run.phase === "stopping") {
      try { this.finish(agent, run, "failed: " + (error instanceof Error ? error.message : String(error))); }
      catch (failure) { agent.failure = failure; run.halt.abort(); agent.state = { phase: "idle" }; this.emit({ type: "error", id: null, reason: String(failure) }); this.change(); }
    }
  }

  private append(agent: Agent, kind: Entry["kind"], text: string): void {
    if (agent.failure) throw agent.failure;
    const entry: Entry = { i: agent.entries.length, kind, text, date: new Date().toISOString(), from: { machine: this.machine, seq: agent.entries.length } };
    try {
      const fd = fs.openSync(path.join(this.dir, agent.name + ".jsonl"), "a", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(entry) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const directory = fs.openSync(this.dir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) { agent.failure = error; throw error; }
    agent.entries.push(entry);
    this.emit({ type: "agent-entry", name: agent.name, entry });
  }
}
