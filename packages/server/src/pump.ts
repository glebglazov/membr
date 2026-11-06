import type { Entry, Skill } from "@membr/protocol";
import type { EngineEvent, Epoch } from "./engine.ts";

export type Sink = {
  guard(): "stop" | "skip" | "take";
  session(id: string): void;
  live(text: string): void;
  skills?(skills: Skill[]): void;
  entry(kind: Extract<Entry["kind"], "unii" | "tool" | "echo">, text: string): void;
  end(event: Extract<EngineEvent, { kind: "end" }>): void;
  expectsEvents(): boolean;
  fail(error: unknown): void;
};

export async function pump(epoch: Epoch, noun: string, sink: Sink): Promise<void> {
  try {
    for await (const event of epoch.events) {
      const guard = sink.guard();
      if (guard === "stop") return;
      if (guard === "skip") continue;
      switch (event.kind) {
        case "session": sink.session(event.id); break;
        case "delta": sink.live(event.text); break;
        case "text": sink.entry("unii", event.text); break;
        case "tool": sink.entry("tool", JSON.stringify({ id: event.id, name: event.name, input: event.input })); break;
        case "echo": sink.entry("echo", JSON.stringify({ id: event.id, text: event.text, error: event.error })); break;
        case "skills": sink.skills?.(event.skills); break;
        case "compacted": throw new Error(`The Engine compacted the ${noun} unexpectedly`);
        case "end": sink.end(event); break;
      }
    }
    if (sink.guard() !== "stop" && sink.expectsEvents()) throw new Error(`The Engine closed the ${noun}`);
  } catch (error) {
    if (sink.guard() !== "stop") sink.fail(error);
  }
}
