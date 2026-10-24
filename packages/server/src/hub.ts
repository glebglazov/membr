import type { ServerWebSocket } from "bun";
import { VERSION, parseClientMessage, type Event, type Hello, type Read } from "@membr/protocol";
import { Log, identity } from "./log.ts";
import { Chat } from "./chat.ts";
import { claude, type Engine, type EpochOptions } from "./engine.ts";
import { Tree } from "./tree.ts";
import { Memory } from "./memory.ts";
import type { ChatConfig } from "./config.ts";
import { readConfig } from "./config.ts";
import { web } from "./web.ts";
import { imagePath, IMAGE_COUNT, storeImage } from "./images.ts";

type Connection = { phase: "hello"; tokens: string[]; local: boolean } | { phase: "ready"; hello: Hello };
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

function loopback(address: string): boolean {
  return address === "::1" || address === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(address) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(address);
}

export function serveHub(options: { dir: string; port: number; hostname?: string; engine?: Engine; epoch?: Partial<EpochOptions>; config?: ChatConfig }) {
  const config = options.config ?? readConfig(options.dir);
  const log = new Log(options.dir);
  let tree: Tree | undefined;
  let memory: Memory;
  const token = identity(options.dir, "token");
  const sockets = new Set<Socket>();
  const send = (socket: Socket, event: Event) => socket.send(JSON.stringify(event));
  function refuse(socket: Socket, reason: string) {
    send(socket, { type: "refused", reason });
    socket.close(1008, reason.slice(0, 120));
  }
  function read(socket: Socket, request: Read) {
    if (request.read === "agent") {
      const agent = chat!.agents.read(request.name);
      if (agent) send(socket, { type: "read", id: request.id, entries: agent.entries, live: agent.live, parts: [], lines: [] });
      else send(socket, { type: "error", id: request.id, reason: "No agent " + request.name + "." });
      return;
    }
    if (request.read === "roots" || request.read === "root") {
      const lines = memory.roots();
      send(socket, { type: "read", id: request.id, entries: [], parts: lines.map(({ l, i }) => ({ l, i })), lines });
      return;
    }
    const opened = memory.browse(request.part);
    const lines = opened.kind === "message" ? [] : opened.lines;
    send(socket, { type: "read", id: request.id, entries: opened.kind === "message" ? [opened.entry] : [], parts: lines.map(({ l, i }) => ({ l, i })), lines, ...(opened.kind === "missing" ? { error: opened.reason } : {}) });
  }
  const server = Bun.serve<Connection>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    maxRequestBodySize: 32 * 2 ** 20,
    async fetch(request, server) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
      const local = loopback(server.requestIP(request)?.address ?? "") && (loopback(url.hostname) || url.hostname === "localhost");
      let tokens: string[];
      try { tokens = credentials(request); } catch {
        return new Response("Invalid bearer credentials", { status: 401 });
      }
      if (tokens.some((value) => value !== token)) return new Response("Invalid bearer token", { status: 401 });
      if (url.pathname === "/ws") {
        if (!local && !tokens.length && (origin !== null || request.headers.get("upgrade")?.toLowerCase() !== "websocket")) return new Response("Bearer token required", { status: 401 });
        if (server.upgrade(request, { data: { phase: "hello", tokens, local } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (!local && !tokens.length) return new Response("Bearer token required", { status: 401 });
      if (url.pathname === "/" && url.searchParams.has("token") && request.method === "GET") {
        return new Response(null, { status: 303, headers: {
          Location: "/", "Set-Cookie": `token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${url.protocol === "https:" ? "; Secure" : ""}`,
          "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        } });
      }
      if (url.pathname === "/act/say") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
        const id = url.searchParams.get("id") ?? "";
        try {
          parseClientMessage({ type: "act", act: "say", id, text: "" });
          const previous = log.answer(id);
          if (previous) return Response.json(previous);
          const form = await request.formData();
          const text = form.get("text");
          const files = form.getAll("images");
          if (typeof text !== "string" || !files.length || files.length > IMAGE_COUNT || files.some((file) => !(file instanceof File))) throw new Error("Attach 1 to 20 images and a text field.");
          const images: string[] = [];
          for (const file of files) {
            if (!(file instanceof File)) throw new Error("Expected an image file.");
            images.push(await storeImage(options.dir, Buffer.from(await file.arrayBuffer()), file.type));
          }
          return Response.json(chat!.act({ type: "act", act: "say", id, text, images }));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "The image upload failed.";
          if (!id || id.length > 256) return new Response(reason, { status: 400 });
          const answer = log.apply({ type: "act", act: "say", id, text: "" }, log.count, reason).answer;
          return Response.json(answer, { status: answer.ok ? 200 : 400 });
        }
      }
      if (url.pathname.startsWith("/docs/images/")) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        try {
          const file = Bun.file(imagePath(options.dir, decodeURIComponent(url.pathname.slice("/docs/images/".length))));
          if (!(await file.exists())) return new Response("Not found", { status: 404 });
          return new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" } });
        } catch { return new Response("Not found", { status: 404 }); }
      }
      return web(request);
    },
    websocket: {
      message(socket, data) {
        try {
          const message = parseClientMessage(JSON.parse(typeof data === "string" ? data : data.toString()));
          if (socket.data.phase === "hello") {
            if (message.type !== "hello") return refuse(socket, "The first message must be hello");
            if (Number(message.version.split(".")[0]) !== Number(VERSION.split(".")[0])) return refuse(socket, `Protocol ${message.version} is incompatible with ${VERSION}`);
            const tokens = [...socket.data.tokens, ...(message.token === null ? [] : [message.token])];
            if ((!socket.data.local && !tokens.length) || tokens.some((value) => value !== token)) return refuse(socket, "Invalid bearer token");
            socket.data = { phase: "ready", hello: message };
            for (let i = 0; i < log.count; i++) {
              const entry = log.read(i);
              if (entry) send(socket, { type: "entry", entry });
            }
            sockets.add(socket);
            for (const ask of chat!.asks) send(socket, ask);
            send(socket, { type: "view", parts: chat!.parts, lines: chat!.lines, turn: chat!.latestTurn });
            send(socket, { type: "state", state: chat!.state });
            if (chat!.live) send(socket, { type: "live", text: chat!.live, agent: null });
            send(socket, { type: "ready", version: VERSION });
            return;
          }
          if (message.type === "hello") return refuse(socket, "Hello was already received");
          if (message.type === "read") return read(socket, message);
          send(socket, chat!.act(message));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Request failed";
          if (socket.data.phase === "hello") refuse(socket, reason);
          else send(socket, { type: "error", id: null, reason });
        }
      },
      close(socket) { sockets.delete(socket); },
    },
  });
  let chat: Chat | undefined;
  try {
    tree = new Tree(options.dir, log, options.engine ?? claude);
    memory = new Memory(log, tree, options.dir);
    chat = new Chat(log, tree, memory, options.dir, (event) => {
      if (event.type === "entry") tree?.sync();
      for (const client of sockets) send(client, event);
    }, options.engine, options.epoch, config);
  } catch (error) {
    chat?.close();
    tree?.close();
    server.stop(true);
    throw error;
  }
  let shutdown: Promise<void> | null = null;
  return { server, token, close(): Promise<void> {
    if (shutdown) return shutdown;
    server.stop(true);
    const done = chat?.close() ?? Promise.resolve();
    if (!config.afterCommand) {
      tree?.close();
      shutdown = done;
    } else shutdown = done.then(() => { tree?.close(); });
    return shutdown;
  } };
}
