import type { Act, Answer, Event } from "@membr/protocol";
import type { Ask } from "./engine.ts";
import { type AllowRule, Log } from "./log.ts";

type Request = Extract<Event, { type: "ask" }>;
type Pending = { event: Request; resolve: (allow: boolean) => void; cleanup: () => void };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly log: Log, private readonly emit: (event: Event) => void) {}

  get requests(): Request[] { return [...this.pending.values()].map(({ event }) => event); }

  readonly ask: Ask = async (tool, input, signal) => {
    if (signal?.aborted) return false;
    const rule: AllowRule = { tool, input: structuredClone(input) };
    if (this.log.allows.some((allow) => allow.tool === tool && canonical(allow.input) === canonical(rule.input))) return true;
    const id = crypto.randomUUID();
    const event: Request = { type: "ask", id, ...rule };
    return new Promise<boolean>((resolve) => {
      const abort = () => this.settle(id, false);
      this.pending.set(id, { event, resolve, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      this.emit(event);
    });
  };

  answer(act: Extract<Act, { act: "answer" }>, turn: number, refusal?: string): Answer {
    const request = this.pending.get(act.approval);
    const result = this.log.apply(act, turn, refusal ?? (request ? undefined : "The approval is no longer pending"), request?.event);
    if (result.fresh && result.answer.ok) this.settle(act.approval, act.choice !== "deny");
    return result.answer;
  }

  cancel(): void { for (const id of this.pending.keys()) this.settle(id, false); }

  private settle(id: string, allow: boolean): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.cleanup();
    this.emit({ type: "ask-closed", id });
    request.resolve(allow);
  }
}
