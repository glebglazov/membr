import type { ServerWebSocket } from "bun";
import { VERSION, parseClientMessage, type Event, type Hello, type Read } from "@membr/protocol";
import { Log, identity } from "./log.ts";
import { Chat } from "./chat.ts";
import type { Engine, EpochOptions } from "./engine.ts";

type Connection = { phase: "hello"; tokens: string[] } | { phase: "ready"; hello: Hello };
type Socket = ServerWebSocket<Connection>;

function credentials(request: Request): string[] {
  const tokens: string[] = [];
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer (.+)$/i.exec(authorization);
    if (!match) throw new Error("Expected a bearer token");
    tokens.push(match[1]);
  }
  const url = new URL(request.url);
  tokens.push(...url.searchParams.getAll("token"));
  for (const cookie of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === "token") tokens.push(decodeURIComponent(value.join("=")));
  }
  return tokens;
}

export function serveHub(options: { dir: string; port: number; engine?: Engine; epoch?: Partial<EpochOptions> }) {
  const log = new Log(options.dir);
  const token = identity(options.dir, "token");
  const sockets = new Set<Socket>();
  const send = (socket: Socket, event: Event) => socket.send(JSON.stringify(event));
  function refuse(socket: Socket, reason: string) {
    send(socket, { type: "refused", reason });
    socket.close(1008, reason.slice(0, 120));
  }
  function read(socket: Socket, request: Read) {
    if (request.read === "agent") {
      send(socket, { type: "error", id: request.id, reason: "Agent logs are not available yet" });
      return;
    }
    if (request.read === "roots") {
      send(socket, { type: "read", id: request.id, entries: [], parts: Array.from({ length: log.count }, (_, i) => ({ l: 0, i })) });
      return;
    }
    const start = request.part.i * 2 ** request.part.l;
    const end = Math.min(log.count, start + 2 ** request.part.l);
    const entries = [];
    for (let i = start; i < end; i++) {
      const entry = log.read(i);
      if (entry) entries.push(entry);
    }
    send(socket, { type: "read", id: request.id, entries, parts: [] });
  }
  const server = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/ws") return url.pathname === "/" ? new Response("membr") : new Response("Not found", { status: 404 });
      let tokens: string[];
      try { tokens = credentials(request); } catch {
        return new Response("Invalid bearer credentials", { status: 401 });
      }
      if (tokens.some((value) => value !== token)) return new Response("Invalid bearer token", { status: 401 });
      if (server.upgrade(request, { data: { phase: "hello", tokens } })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, data) {
        try {
          const message = parseClientMessage(JSON.parse(typeof data === "string" ? data : data.toString()));
          if (socket.data.phase === "hello") {
            if (message.type !== "hello") return refuse(socket, "The first message must be hello");
            if (Number(message.version.split(".")[0]) !== Number(VERSION.split(".")[0])) return refuse(socket, `Protocol ${message.version} is incompatible with ${VERSION}`);
            const tokens = [...socket.data.tokens, ...(message.token === null ? [] : [message.token])];
            if (!tokens.length || tokens.some((value) => value !== token)) return refuse(socket, "Invalid bearer token");
            socket.data = { phase: "ready", hello: message };
            for (let i = 0; i < log.count; i++) {
              const entry = log.read(i);
              if (entry) send(socket, { type: "entry", entry });
            }
            sockets.add(socket);
            for (const ask of chat.asks) send(socket, ask);
            send(socket, { type: "state", state: chat.state });
            send(socket, { type: "ready", version: VERSION });
            return;
          }
          if (message.type === "hello") return refuse(socket, "Hello was already received");
          if (message.type === "read") return read(socket, message);
          send(socket, chat.act(message));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Request failed";
          if (socket.data.phase === "hello") refuse(socket, reason);
          else send(socket, { type: "error", id: null, reason });
        }
      },
      close(socket) { sockets.delete(socket); },
    },
  });
  let chat: Chat;
  try {
    chat = new Chat(log, (event) => { for (const client of sockets) send(client, event); }, options.engine, options.epoch);
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return { server, token, close() { chat.close(); server.stop(true); } };
}
