import { act, createModel, hear, type Input, type Model } from "@membr/core";
import { VERSION, parseEvent } from "@membr/protocol";

export type Session = {
  model(): Model;
  subscribe(listener: () => void): () => void;
  input(value: Input): void;
  close(): void;
};

export type SessionOptions = {
  url: string;
  token: string | null;
  // Wait before reconnect attempt n, the last value repeating. The attempt counter resets on `ready`.
  delays?: number[];
};

export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The socket adapter. It owns the connection lifecycle and the current Model, and nothing about the screen.
export function connectSession(options: SessionOptions): Session {
  const delays = options.delays ?? [1000, 2000, 4000, 8000];
  const listeners = new Set<() => void>();
  let model = createModel();
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const change = (next: Model) => { model = next; for (const listener of listeners) listener(); };

  function input(value: Input) {
    const result = act(model, value);
    change(result.model);
    for (const message of [...result.acts, ...result.reads]) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  }

  function connect() {
    change(hear(model, { type: "connecting" }));
    const current = new WebSocket(options.url);
    socket = current;
    current.onopen = () => current.send(JSON.stringify({ type: "hello", version: VERSION, kind: "term", device: null, token: options.token }));
    current.onmessage = (message) => {
      if (socket !== current) return;
      try {
        const event = parseEvent(JSON.parse(String(message.data)));
        change(hear(model, event));
        if (event.type === "ready") { attempt = 0; input({ type: "flush" }); }
        else if (event.type === "view") input({ type: "reads" });
        else if (event.type === "when") input({ type: "schedule-save", id: newId() });
      } catch {
        change(hear(model, { type: "refused", reason: "The server sent an invalid response." }));
        current.close();
      }
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      change(event.code === 1008 && model.connection !== "refused"
        ? hear(model, { type: "refused", reason: "Access refused. Pass --token with the token that membr serve printed." })
        : hear(model, { type: "offline" }));
      if (closed || model.connection === "refused") return;
      timer = setTimeout(connect, delays[Math.min(attempt++, delays.length - 1)]);
    };
  }

  connect();
  return {
    model: () => model,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    input,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
