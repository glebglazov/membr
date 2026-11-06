import type { ServerWebSocket } from "bun";
import { VERSION, isScheduleAct, parseClientMessage, type ClientMessage, type Event, type Hello, type Read } from "@membr/protocol";
import { Log, identity } from "./log.ts";
import { Epochs } from "./epochs.ts";
import { Chat } from "./chat.ts";
import { claude, type Engine, type EpochOptions } from "./engine.ts";
import { Tree } from "./tree.ts";
import { Imports } from "./import.ts";
import { Memory } from "./memory.ts";
import { readConfig, type Config, type Listen } from "./config.ts";
import { tailscaleServe } from "./tailscale.ts";
import { web } from "./web.ts";
import { imagePath, IMAGE_COUNT, storeImage } from "./images.ts";
import { cleanupEpochs } from "./export-cleanup.ts";
import { access, admit, type Admitted } from "./access.ts";
import type { Clock } from "./clock.ts";

type Connection = { phase: "hello"; access: Admitted } | { phase: "ready"; hello: Hello };
type Socket = ServerWebSocket<Connection>;

const same = (a: Listen, b: Listen) => a.port === b.port && a.host === b.host && a.tailscale === b.tailscale;

// config is called at start and again on each reload. port, hostname and tailscale are where the hub starts; a reload whose
// listen differs from the one the previous load gave moves it, and onListen hears where it went.
export function serveHub(options: {
  dir: string; port: number; hostname?: string; tailscale?: boolean; engine?: Engine; epoch?: Partial<EpochOptions>;
  config?: () => Config; clock?: Clock; onListen?: (url: string, tailnet: string | null) => void;
}) {
  const log = new Log(options.dir);
  const epochs = new Epochs(options.dir);
  let tree: Tree | undefined;
  let memory: Memory;
  let imports: Imports | undefined;
  const token = identity(options.dir, "token");
  const sockets = new Set<Socket>();
  const send = (socket: Socket, event: Event) => socket.send(JSON.stringify(event));
  function refuse(socket: Socket, reason: string) {
    send(socket, { type: "refused", reason });
    socket.close(1008, reason.slice(0, 120));
  }
  async function read(socket: Socket, request: Read) {
    if (request.read === "import") {
      try {
        const plan = await imports!.plan(request);
        send(socket, { type: "import-estimate", id: request.id, estimate: plan.estimate });
      } catch (error) { send(socket, { type: "error", id: request.id, reason: error instanceof Error ? error.message : "The import estimate failed." }); }
      return;
    }
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
    if (request.read === "when") {
      send(socket, await chat!.schedules.preview(request));
      return;
    }
    const opened = memory.browse(request.part);
    const lines = opened.kind === "message" ? [] : opened.lines;
    send(socket, { type: "read", id: request.id, entries: opened.kind === "message" ? [opened.entry] : [], parts: lines.map(({ l, i }) => ({ l, i })), lines, ...(opened.kind === "missing" ? { error: opened.reason } : {}) });
  }
  const listen = (port: number, hostname: string) => Bun.serve<Connection>({
    hostname,
    port,
    maxRequestBodySize: 32 * 2 ** 20,
    async fetch(request, server) {
      const url = new URL(request.url);
      const granted = access(request, server.requestIP(request)?.address ?? "", token);
      if (granted.kind === "refused") return new Response(granted.reason, { status: granted.status });
      if (url.pathname === "/ws") {
        if (server.upgrade(request, { data: { phase: "hello", access: granted } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (url.pathname === "/" && url.searchParams.has("token") && request.method === "GET") {
        return new Response(null, { status: 303, headers: {
          Location: "/", "Set-Cookie": `token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${granted.secureCookie ? "; Secure" : ""}`,
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
          const answer = chat!.refuse(id, reason);
          return Response.json(answer, { status: answer.ok ? 200 : 400 });
        }
      }
      if (url.pathname === "/export") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
        return Response.json(chat!.export(), { headers: { "Content-Disposition": 'attachment; filename="membr-memory.json"', "Cache-Control": "no-store" } });
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
      maxPayloadLength: 36 * 2 ** 20,
      async message(socket, data) {
        try {
          const input: unknown = JSON.parse(typeof data === "string" ? data : data.toString());
          let message: ClientMessage;
          try { message = parseClientMessage(input); }
          catch (error) {
            if (socket.data.phase !== "ready" || input === null || typeof input !== "object" || !("type" in input) || input.type !== "act"
              || !("id" in input) || typeof input.id !== "string" || input.id.length === 0 || input.id.length > 256) throw error;
            const reason = error instanceof Error ? error.message : "Request failed";
            send(socket, chat!.refuse(input.id, reason));
            return;
          }
          if (socket.data.phase === "hello") {
            if (message.type !== "hello") return refuse(socket, "The first message must be hello");
            if (Number(message.version.split(".")[0]) !== Number(VERSION.split(".")[0])) return refuse(socket, `Protocol ${message.version} is incompatible with ${VERSION}`);
            if (!admit(socket.data.access, message.token, token)) return refuse(socket, "Invalid bearer token");
            socket.data = { phase: "ready", hello: message };
            for (let i = 0; i < log.count; i++) {
              const entry = log.read(i);
              if (entry) send(socket, { type: "entry", entry });
            }
            sockets.add(socket);
            for (const ask of chat!.asks) send(socket, ask);
            send(socket, chat!.viewEvent());
            send(socket, { type: "state", state: chat!.state });
            if (chat!.live) send(socket, { type: "live", text: chat!.live, agent: null });
            send(socket, { type: "imports", imports: imports!.status });
            send(socket, chat!.skills);
            send(socket, chat!.schedules.event);
            send(socket, { type: "ready", version: VERSION });
            return;
          }
          if (message.type === "hello") return refuse(socket, "Hello was already received");
          if (message.type === "read") return await read(socket, message);
          send(socket, isScheduleAct(message) ? chat!.schedules.act(message) : message.act === "import" || message.act === "go" ? await imports!.act(message) : chat!.act(message));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Request failed";
          if (socket.data.phase === "hello") refuse(socket, reason);
          else send(socket, { type: "error", id: null, reason });
        }
      },
      close(socket) { sockets.delete(socket); },
    },
  });
  // Nothing stays bound when tailscale serve fails, so the caller sees one error and no half-open hub.
  function bind(where: Listen) {
    const next = listen(where.port, where.host);
    try { return { server: next, tailnet: where.tailscale ? tailscaleServe(next.port!) : null }; }
    catch (error) { next.stop(true); throw error; }
  }
  let host = options.hostname ?? "127.0.0.1";
  let { server, tailnet } = bind({ port: options.port, host, tailscale: options.tailscale ?? false });

  // The old listener goes first, so a move to the same port with another host can bind. Open sockets stay until their
  // answers are out, then close with 1012 so that clients connect again.
  function move(where: Listen) {
    const port = server.port!;
    server.stop();
    try { ({ server, tailnet } = bind(where)); }
    catch (error) {
      server = listen(port, host);
      throw error;
    }
    host = where.host;
    const moved = [...sockets];
    setTimeout(() => { for (const socket of moved) socket.close(1012, "membr moved to " + server.url.href); }, 100);
    options.onListen?.(server.url.href, tailnet);
  }
  const load = options.config ?? (() => readConfig(options.dir));
  let known: Listen | undefined;
  const config = () => {
    const next = load();
    if (known && !same(known, next.listen)) move(next.listen);
    known = next.listen;
    return next;
  };

  let chat: Chat | undefined;
  try {
    tree = new Tree(options.dir, log, options.engine ?? claude);
    memory = new Memory(log, tree, options.dir);
    chat = new Chat(log, epochs, tree, memory, options.dir, (event) => {
      if (event.type === "entry") tree?.sync();
      for (const client of sockets) send(client, event);
    }, options.engine, options.epoch, config, options.clock);
    imports = new Imports(log, tree, (event) => { for (const client of sockets) send(client, event); }, (entries) => chat!.imported(entries));
    tree.onChange = () => { imports?.changed(); chat?.compressed(); };
  } catch (error) {
    chat?.close();
    tree?.close();
    server.stop(true);
    throw error;
  }
  let shutdown: Promise<void> | null = null;
  const purge = () => void cleanupEpochs(epochs, options.engine ?? claude, chat!.activeEpoch, Date.now(), options.epoch?.cwd ?? process.cwd()).catch((error) => console.error("membr: session cleanup failed", error));
  purge();
  const cleanupTimer = setInterval(purge, 86_400_000);
  return { get server() { return server; }, get tailnet() { return tailnet; }, token, reload: () => chat!.reload(), close(): Promise<void> {
    if (shutdown) return shutdown;
    clearInterval(cleanupTimer);
    const importing = imports?.close() ?? Promise.resolve();
    server.stop(true);
    const done = Promise.all([chat?.close(), importing]).then(() => {});
    if (!chat?.afterCommand) {
      tree?.close();
      shutdown = done;
    } else shutdown = done.then(() => { tree?.close(); });
    return shutdown;
  } };
}
