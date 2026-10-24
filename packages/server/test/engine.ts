import type { Account, Engine, EngineEvent, Epoch, EpochOptions, From, Pick, Priority } from "../src/engine.ts";

export const END: Extract<EngineEvent, { kind: "end" }> = { kind: "end", reply: "", error: null, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, fast: null, through: 0 };
type Message = { text: string; priority: Priority; from: From; images?: import("../src/images.ts").Image[] };

export class FakeEpoch implements Epoch {
  readonly messages: Message[] = [];
  readonly picks: Pick[] = [];
  interrupts = 0;
  closed = false;
  private readonly queue: EngineEvent[] = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  onInterrupt: () => Promise<void> = async () => {};
  onPick: (pick: Pick) => Promise<void> = async () => {};

  constructor(readonly view: string, readonly options: EpochOptions, private readonly script: (epoch: FakeEpoch, message: Message) => void) {}

  send(text: string, priority: Priority, from: From, images?: import("../src/images.ts").Image[]): number {
    if (this.closed) throw new Error("The fake epoch is closed");
    const message = { text, priority, from, ...(images?.length ? { images } : {}) };
    this.messages.push(message);
    this.script(this, message);
    return this.messages.length;
  }

  emit(...events: EngineEvent[]): void { this.queue.push(...events.map((event) => event.kind === "end" && event.through === 0 ? { ...event, through: this.messages.length } : event)); this.wake?.(); }
  fail(error: Error): void { this.failure = error; this.wake?.(); }
  async interrupt(): Promise<void> { this.interrupts++; await this.onInterrupt(); }
  async pick(pick: Pick): Promise<void> { this.picks.push(pick); await this.onPick(pick); }
  close(): void { this.closed = true; this.wake?.(); }
  get events(): AsyncIterable<EngineEvent> { return this.stream(); }

  private async *stream(): AsyncGenerator<EngineEvent> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.closed) return;
      const event = this.queue.shift();
      if (event) yield event;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

export class FakeEngine implements Engine {
  readonly epochs: FakeEpoch[] = [];
  readonly checks: Array<{ goal: string; chat: string; signal: AbortSignal }> = [];
  onCheck: (goal: string, chat: string, signal: AbortSignal) => Promise<boolean> = async () => true;
  constructor(private readonly script: (epoch: FakeEpoch, message: Message) => void = () => {}) {}
  open(view: string, options: EpochOptions): Epoch {
    const epoch = new FakeEpoch(view, options, this.script);
    this.epochs.push(epoch);
    epoch.emit({ kind: "session", id: `fake-session-${this.epochs.length}` });
    return epoch;
  }
  async compact(_prompt: string): Promise<string | null> { return "A compacted message."; }
  async checkGoal(goal: string, chat: string, signal: AbortSignal): Promise<boolean> {
    this.checks.push({ goal, chat, signal });
    return this.onCheck(goal, chat, signal);
  }
  async account(): Promise<Account> { throw new Error("No account was scripted"); }
}
