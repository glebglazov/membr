import type { Act, Answer, Event } from "@membr/protocol";
import { type Clock, systemClock } from "./clock.ts";
import { type AllowRule, Log } from "./log.ts";

type Request = Extract<Event, { type: "ask" }>;
type Pending = { event: Request; resolve: (allow: boolean) => void; cleanup: () => void; asked: number; unattended: boolean; stopTimer?: () => void };

function human(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();

  // limit is read at each arming, so a reloaded config reaches asks already waiting through rearm.
  constructor(private readonly log: Log, private readonly emit: (event: Event) => void, private readonly limit: () => number, private readonly note: (text: string) => void, private readonly clock: Clock = systemClock) {}

  get requests(): Request[] { return [...this.pending.values()].map(({ event }) => event); }

  // An unattended ask is denied at asked + limit. An interactive one waits for the user.
  readonly ask = async (tool: string, input: Record<string, unknown>, signal?: AbortSignal, unattended = false): Promise<boolean> => {
    if (signal?.aborted) return false;
    const rule: AllowRule = { tool, input: structuredClone(input) };
    if (this.log.allows.some((allow) => allow.tool === tool && canonical(allow.input) === canonical(rule.input))) return true;
    const id = crypto.randomUUID();
    const event: Request = { type: "ask", id, ...rule };
    return new Promise<boolean>((resolve) => {
      const abort = () => this.settle(id, false);
      this.pending.set(id, { event, resolve, cleanup: () => signal?.removeEventListener("abort", abort), asked: this.clock.now(), unattended });
      signal?.addEventListener("abort", abort, { once: true });
      this.emit(event);
      this.arm(id);
    });
  };

  answer(act: Extract<Act, { act: "answer" }>, turn: number, refusal?: string): Answer {
    const request = this.pending.get(act.approval);
    const result = this.log.apply(act, turn, refusal ?? (request ? undefined : "The approval is no longer pending"), request?.event);
    if (result.fresh && result.answer.ok) this.settle(act.approval, act.choice !== "deny");
    return result.answer;
  }

  rearm(): void { for (const id of this.pending.keys()) this.arm(id); }

  cancel(): void { for (const id of this.pending.keys()) this.settle(id, false); }

  private arm(id: string): void {
    const request = this.pending.get(id);
    if (!request?.unattended) return;
    request.stopTimer?.();
    const limit = this.limit();
    const expire = () => {
      this.settle(id, false);
      this.note(`Nobody answered the approval for ${request.event.tool} within ${human(limit)}, so membr denied it.`);
    };
    const left = request.asked + limit - this.clock.now();
    if (left <= 0) expire();
    else request.stopTimer = this.clock.wake(left, expire);
  }

  private settle(id: string, allow: boolean): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.cleanup();
    request.stopTimer?.();
    this.emit({ type: "ask-closed", id });
    request.resolve(allow);
  }
}
