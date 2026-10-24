// Adapted from UniiChat View.ts at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import type { Act, Entry, Event, Part, State } from "@membr/protocol";

export type Model = {
  connection: "offline" | "connecting" | "ready" | "refused";
  entries: ReadonlyMap<number, Entry>;
  live: string;
  state: State;
  parts: Part[];
  pending: ReadonlyMap<string, Act>;
  error: string | null;
};
export type Input = { type: "send"; id: string; text: string } | { type: "stop"; id: string } | { type: "flush" };
export type ConnectionEvent = { type: "connecting" | "offline" };

export function createModel(): Model {
  return {
    connection: "offline", entries: new Map(), live: "", parts: [], pending: new Map(), error: null,
    state: { busy: false, wait: "", goal: null, pick: null, agents: [], usage: null },
  };
}

export function hear(model: Model, event: Event | ConnectionEvent): Model {
  switch (event.type) {
    case "connecting": return { ...model, connection: "connecting", live: "" };
    case "offline": return { ...model, connection: model.connection === "refused" ? "refused" : "offline", live: "" };
    case "ready": return { ...model, connection: "ready" };
    case "refused": return { ...model, connection: "refused", error: event.reason, live: "" };
    case "entry": {
      const entries = new Map(model.entries);
      entries.set(event.entry.i, event.entry);
      return { ...model, entries, live: event.entry.kind === "unii" ? "" : model.live };
    }
    case "live": return event.agent === null ? { ...model, live: model.live + event.text } : model;
    case "state": return { ...model, state: event.state, live: event.state.busy ? model.live : "" };
    case "view": return { ...model, parts: event.parts };
    case "answer": {
      const pending = new Map(model.pending);
      pending.delete(event.id);
      return { ...model, pending, error: event.ok ? model.error : event.reason };
    }
    case "error": return { ...model, error: event.reason };
    default: return model;
  }
}

export function act(model: Model, input: Input): { model: Model; acts: Act[] } {
  if (input.type === "flush") return { model, acts: model.connection === "ready" ? [...model.pending.values()] : [] };
  if (input.type === "send" && !input.text.trim()) return { model, acts: [] };
  if (model.pending.has(input.id)) return { model, acts: [] };
  const message: Act = input.type === "send"
    ? { type: "act", act: "say", id: input.id, text: input.text }
    : { type: "act", act: "stop", id: input.id, agent: null };
  const pending = new Map(model.pending);
  pending.set(message.id, message);
  return { model: { ...model, pending, error: null }, acts: model.connection === "ready" ? [message] : [] };
}
