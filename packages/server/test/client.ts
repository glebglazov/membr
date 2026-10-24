import { VERSION, parseEvent, type Act, type Event, type Hello, type Read } from "@membr/protocol";

export class TestClient {
  readonly events: Event[] = [];
  readonly closed: Promise<CloseEvent>;
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.addEventListener("message", (message) => {
      this.events.push(parseEvent(JSON.parse(String(message.data))));
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string, options: { token?: string | null; version?: string; kind?: "web" | "term"; headers?: Record<string, string> } = {}): Promise<TestClient> {
    // lib.dom hides Bun's options overload when browser packages share this build.
    const Socket = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new Socket(url, { headers: options.headers });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket connection timed out")); }, 3000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); }, { once: true });
    });
    const hello: Hello = { type: "hello", version: options.version ?? VERSION, kind: options.kind ?? "term", device: null, token: options.token ?? null };
    socket.send(JSON.stringify(hello));
    return client;
  }

  act(act: Act): void { this.socket.send(JSON.stringify(act)); }
  read(read: Read): void { this.socket.send(JSON.stringify(read)); }

  wait<T extends Event["type"]>(type: T, from = 0, predicate: (event: Extract<Event, { type: T }>) => boolean = () => true, timeout = 3000): Promise<Extract<Event, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
      const check = () => {
        const event = this.events.slice(from).find((event): event is Extract<Event, { type: T }> => event.type === type && predicate(event as Extract<Event, { type: T }>));
        if (event) { clearTimeout(timer); this.listeners.delete(check); resolve(event); }
      };
      this.listeners.add(check);
      check();
    });
  }

  close(): void { this.socket.close(); }
}
