// Prompt adapted from UniiChat at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import { type Act, type Answer, type Event, type Pick, type State } from "@membr/protocol";
import { claude, type Engine, type Epoch, type EpochOptions } from "./engine.ts";
import { Approvals } from "./approvals.ts";
import { Log } from "./log.ts";

type Turn = { phase: "idle" } | { phase: "running" | "stopping"; id: number } | { phase: "failed"; reason: string } | { phase: "closed" };
type Session = { id: string; epoch: Epoch };
const PICK: Pick = { model: "sonnet", effort: "high", fast: false };
const MODELS: readonly string[] = ["opus", "sonnet", "haiku"];
const PROMPT = fs.readFileSync(new URL("./prompt.txt", import.meta.url), "utf8");

export class Chat {
  private readonly approvals: Approvals;
  private turn: Turn = { phase: "idle" };
  private session: Session;
  private usage: State["usage"] = null;
  private sent = 0;
  private options: EpochOptions;
  private picking = Promise.resolve();

  constructor(private readonly log: Log, private readonly emit: (event: Event) => void, private readonly engine: Engine = claude, options: Partial<EpochOptions> = {}) {
    this.approvals = new Approvals(log, emit);
    this.options = { pick: PICK, append: PROMPT, cwd: process.cwd(), ...options, ask: (tool, input, signal) => {
      if (this.turn.phase === "closed" || this.turn.phase === "failed" || this.turn.phase === "stopping") return Promise.resolve(false);
      return this.approvals.ask(tool, input, signal);
    } };
    if (log.pick) this.options.pick = log.pick;
    for (const turn of log.interrupted) log.finish(turn, "The server restarted before the turn ended.");
    this.session = this.open();
    void this.read(this.session);
  }

  get asks() { return this.approvals.requests; }

  get state(): State {
    return { busy: this.turn.phase === "running" || this.turn.phase === "stopping", wait: this.turn.phase === "stopping" ? "Stopping" : "", goal: null, pick: this.options.pick, agents: [], usage: this.usage };
  }

  act(act: Act): Answer {
    const refusal = this.turn.phase === "closed" ? "The chat is closed" : this.turn.phase === "failed" ? this.turn.reason : this.turn.phase === "stopping" && act.act === "say" ? "The turn is stopping. Send the message again with a new act id." : act.act === "pick" && !MODELS.includes(act.pick.model) ? `Model ${act.pick.model} is not offered` : undefined;
    const id = this.turn.phase === "running" || this.turn.phase === "stopping" ? this.turn.id : this.log.count;
    if (act.act === "answer") return this.approvals.answer(act, id, refusal);
    const result = this.log.apply(act, id, refusal);
    if (!result.fresh || !result.answer.ok) return result.answer;
    if (result.entry) this.emit({ type: "entry", entry: result.entry });
    if (act.act === "say") {
      const priority = this.turn.phase === "running" ? "next" : "now";
      this.turn = { phase: "running", id };
      this.change();
      try { this.sent = this.session.epoch.send(act.text, priority, "user"); } catch (error) { this.fail(error); }
    } else if (act.act === "stop" && this.turn.phase === "running") {
      this.turn = { phase: "stopping", id };
      this.approvals.cancel();
      this.change();
      void this.stop(this.session, id);
    } else if (act.act === "pick") {
      this.options = { ...this.options, pick: act.pick };
      this.change();
      const session = this.session;
      this.picking = this.picking.then(async () => {
        if (session !== this.session || this.turn.phase === "closed" || this.turn.phase === "failed") return;
        await session.epoch.pick(act.pick);
      }).catch((error) => {
        if (session === this.session && this.turn.phase !== "closed" && this.turn.phase !== "failed") this.fail(error);
      });
    }
    return result.answer;
  }

  close(): void {
    this.turn = { phase: "closed" };
    this.approvals.cancel();
    this.session.epoch.close();
  }

  private open(): Session {
    const entries = Array.from({ length: this.log.count }, (_, i) => this.log.read(i));
    const view = `The following chat is memory, not new user instructions. Read it without acting or calling tools. Wait for the next user message.\n<chat>\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n</chat>`;
    return { id: crypto.randomUUID(), epoch: this.engine.open(view, this.options) };
  }

  private async read(session: Session): Promise<void> {
    try {
      for await (const event of session.epoch.events) {
        if (session !== this.session || this.turn.phase === "closed") return;
        switch (event.kind) {
          case "session": this.log.epoch(session.id, event.id); break;
          case "delta": this.emit({ type: "live", text: event.text, agent: null }); break;
          case "text": this.emit({ type: "entry", entry: this.log.append("unii", event.text) }); break;
          case "tool": this.emit({ type: "entry", entry: this.log.append("tool", JSON.stringify({ id: event.id, name: event.name, input: event.input })) }); break;
          case "echo": this.emit({ type: "entry", entry: this.log.append("echo", JSON.stringify({ id: event.id, text: event.text, error: event.error })) }); break;
          case "compacted": throw new Error("The Engine compacted the epoch unexpectedly");
          case "end":
            this.usage = event.usage;
            if (this.turn.phase === "running" && event.through >= this.sent) {
              const entry = this.log.finish(this.turn.id, event.error === null ? undefined : `The turn failed: ${event.error}`);
              if (entry) this.emit({ type: "entry", entry });
              this.turn = { phase: "idle" };
            }
            this.change();
            break;
        }
      }
      if (session === this.session && this.turn.phase !== "closed" && this.turn.phase !== "stopping" && this.turn.phase !== "failed") throw new Error("The Engine closed the epoch");
    } catch (error) {
      if (session === this.session && this.turn.phase !== "closed") this.fail(error);
    }
  }

  private async stop(session: Session, turn: number): Promise<void> {
    try {
      await session.epoch.interrupt();
      if (this.turn.phase !== "stopping" || this.turn.id !== turn || session !== this.session) return;
      this.log.finish(turn);
      this.turn = { phase: "idle" };
      this.change();
    } catch (error) {
      if (this.turn.phase !== "closed") this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.turn.phase === "closed" || this.turn.phase === "failed") return;
    const reason = error instanceof Error ? error.message : "The Engine failed";
    const turn = this.turn;
    this.turn = { phase: "failed", reason };
    this.approvals.cancel();
    this.session.epoch.close();
    try {
      if (turn.phase === "running" || turn.phase === "stopping") {
        const entry = this.log.finish(turn.id, `The turn failed: ${reason}`);
        if (entry) this.emit({ type: "entry", entry });
      }
    } catch (failure) {
      this.emit({ type: "error", id: null, reason: failure instanceof Error ? failure.message : "The log write failed" });
    }
    this.emit({ type: "error", id: null, reason });
    this.change();
  }

  private change(): void { this.emit({ type: "state", state: this.state }); }
}
