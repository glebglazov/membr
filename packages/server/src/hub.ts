import fs from "node:fs";
import type { ServerWebSocket } from "bun";
import { VERSION, parseClientMessage, type AgentInfo, type ClientMessage } from "@membr/protocol";
import { identity } from "./log.ts";
import type { Engine, EpochOptions } from "./engine.ts";
import { DEFAULT_AGENT, readConfig, storeDir, type AgentConfig, type Config, type Listen } from "./config.ts";
import { tailscaleServe } from "./tailscale.ts";
import { web } from "./web.ts";
import { access, admit, type Admitted } from "./access.ts";
import { Room } from "./room.ts";
import type { Clock } from "./clock.ts";

type Connection = { room: string } & ({ phase: "hello"; access: Admitted } | { phase: "ready" });
type Socket = ServerWebSocket<Connection>;

// Every agent lives under this path: /membr/<name>/ is its web app, and /membr/ lists the agents.
export const BASE_PATH = "/membr";

const same = (a: Listen, b: Listen) => a.port === b.port && a.host === b.host && a.tailscale === b.tailscale;

// A path names the agent it is for. A path outside /membr/ is the default agent's, so clients from before many agents still work.
export function route(pathname: string): { kind: "list" } | { kind: "slash"; to: string } | { kind: "agent"; agent: string; rest: string } {
  if (pathname === BASE_PATH) return { kind: "slash", to: BASE_PATH + "/" };
  if (pathname === BASE_PATH + "/" || pathname === BASE_PATH + "/agents.json") return { kind: "list" };
  if (!pathname.startsWith(BASE_PATH + "/")) return { kind: "agent", agent: DEFAULT_AGENT, rest: pathname };
  const tail = pathname.slice(BASE_PATH.length + 1);
  const slash = tail.indexOf("/");
  if (slash === -1) return { kind: "slash", to: pathname + "/" };
  return { kind: "agent", agent: decodeURIComponent(tail.slice(0, slash)), rest: tail.slice(slash) };
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function listPage(agents: AgentInfo[]): string {
  const rows = agents.map((agent) => `<li><a href="./${encodeURIComponent(agent.name)}/">${escape(agent.name)}</a> <span class="state">${agent.busy ? "busy" : "idle"}</span>${agent.about ? `<p>${escape(agent.about)}</p>` : ""}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>membr agents</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#fbfaf7;color:#1d1f23}a{color:#2f6f5e;font-weight:600}ul{list-style:none;padding:0}li{padding:12px 0;border-bottom:1px solid #e3e0d8}p{margin:4px 0 0;color:#5d6470}.state{font-size:13px;color:#5d6470;margin-left:8px}
@media (prefers-color-scheme: dark){body{background:#15171a;color:#e8e6e1}a{color:#6cc4a8}li{border-color:#2e3238}p,.state{color:#9aa1ab}}</style></head>
<body><h1>membr agents</h1><ul>${rows}</ul></body></html>`;
}

// config is called at start and again on each reload. port, hostname and tailscale are where the hub starts; a reload whose
// listen differs from the one the previous load gave moves it, and onListen hears where it went.
export function serveHub(options: {
  dir: string; port: number; hostname?: string; tailscale?: boolean; engine?: Engine; epoch?: Partial<EpochOptions>;
  config?: () => Config; clock?: Clock; onListen?: (url: string, tailnet: string | null) => void;
}) {
  fs.mkdirSync(options.dir, { recursive: true });
  const token = identity(options.dir, "token");
  const rooms = new Map<string, Room>();
  const sockets = new Set<Socket>();
  const agents = (): AgentInfo[] => [...rooms.values()].map((room) => room.info);
  let shownAgents = "";
  // Every client sees every agent's busy state in its switcher, so a change in one room goes to all clients.
  function agentsChanged() {
    const event = JSON.stringify({ type: "agents", agents: agents() });
    if (event === shownAgents) return;
    shownAgents = event;
    for (const socket of sockets) if (socket.data.phase === "ready") socket.send(event);
  }
  function refuse(socket: Socket, reason: string) {
    socket.send(JSON.stringify({ type: "refused", reason }));
    socket.close(1008, reason.slice(0, 120));
  }
  function signIn(url: URL, secure: boolean): Response {
    url.searchParams.delete("token");
    return new Response(null, { status: 303, headers: {
      Location: url.pathname + url.search, "Set-Cookie": `token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } });
  }

  const listen = (port: number, hostname: string) => Bun.serve<Connection>({
    hostname,
    port,
    maxRequestBodySize: 32 * 2 ** 20,
    async fetch(request, server) {
      const url = new URL(request.url);
      const granted = access(request, server.requestIP(request)?.address ?? "", token);
      if (granted.kind === "refused") return new Response(granted.reason, { status: granted.status });
      const where = route(url.pathname);
      const page = where.kind === "list" ? !url.pathname.endsWith(".json") : where.kind === "agent" && where.rest === "/";
      if (page && url.searchParams.has("token") && request.method === "GET") return signIn(url, granted.secureCookie);
      if (where.kind === "slash") return new Response(null, { status: 301, headers: { Location: where.to + url.search } });
      if (where.kind === "list") {
        if (url.pathname.endsWith(".json")) return Response.json(agents(), { headers: { "Cache-Control": "no-store" } });
        return new Response(listPage(agents()), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }
      const room = rooms.get(where.agent);
      if (!room) return new Response(`No agent ${where.agent}. Agents: ${[...rooms.keys()].join(", ")}.`, { status: 404 });
      if (where.rest === "/ws") {
        if (server.upgrade(request, { data: { room: room.name, phase: "hello", access: granted } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (where.rest === "/act/say") return room.say(request, url.searchParams.get("id") ?? "");
      if (where.rest === "/export") return room.export(request);
      if (where.rest === "/notebook.md") return room.notebook(request);
      if (where.rest.startsWith("/docs/images/")) return room.image(request, where.rest.slice("/docs/images/".length));
      return web(request, where.rest);
    },
    websocket: {
      maxPayloadLength: 36 * 2 ** 20,
      async message(socket, data) {
        const room = rooms.get(socket.data.room);
        try {
          if (!room) return refuse(socket, `The agent ${socket.data.room} was removed`);
          const input: unknown = JSON.parse(typeof data === "string" ? data : data.toString());
          let message: ClientMessage;
          try { message = parseClientMessage(input); }
          catch (error) {
            if (socket.data.phase !== "ready" || input === null || typeof input !== "object" || !("type" in input) || input.type !== "act"
              || !("id" in input) || typeof input.id !== "string" || input.id.length === 0 || input.id.length > 256) throw error;
            const reason = error instanceof Error ? error.message : "Request failed";
            socket.send(JSON.stringify(room.refuse(input.id, reason)));
            return;
          }
          if (socket.data.phase === "hello") {
            if (message.type !== "hello") return refuse(socket, "The first message must be hello");
            if (Number(message.version.split(".")[0]) !== Number(VERSION.split(".")[0])) return refuse(socket, `Protocol ${message.version} is incompatible with ${VERSION}`);
            if (!admit(socket.data.access, message.token, token)) return refuse(socket, "Invalid bearer token");
            socket.data = { room: room.name, phase: "ready" };
            sockets.add(socket);
            room.join(socket, agents());
            return;
          }
          if (message.type === "hello") return refuse(socket, "Hello was already received");
          await room.message(socket, message);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Request failed";
          if (socket.data.phase === "hello") refuse(socket, reason);
          else socket.send(JSON.stringify({ type: "error", id: null, reason }));
        }
      },
      close(socket) {
        sockets.delete(socket);
        rooms.get(socket.data.room)?.leave(socket);
      },
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
  const open = (config: AgentConfig) => new Room({
    config, store: storeDir(options.dir, config.name), engine: options.engine, epoch: options.epoch, clock: options.clock,
    reloadAll, changed: agentsChanged,
  });
  // Rooms follow the agents map: a new entry opens a room, a removed one closes it, and the rest get their new config.
  function reloadAll(): string | null {
    let next: Config;
    try {
      next = load();
      if (!same(known, next.listen)) move(next.listen);
      known = next.listen;
      for (const [name, room] of rooms) {
        if (next.agents.has(name)) continue;
        rooms.delete(name);
        void room.close(`The agent ${name} was removed from config.json`);
      }
      for (const config of next.agents.values()) {
        const room = rooms.get(config.name);
        if (room) room.apply(config);
        else rooms.set(config.name, open(config));
      }
    } catch (error) {
      return "The config was not reloaded: " + (error instanceof Error ? error.message : String(error));
    } finally { agentsChanged(); }
    return null;
  }

  let known: Listen;
  try {
    const first = load();
    known = first.listen;
    for (const config of first.agents.values()) rooms.set(config.name, open(config));
  } catch (error) {
    for (const room of rooms.values()) void room.close();
    server.stop(true);
    throw error;
  }

  let shutdown: Promise<void> | null = null;
  return {
    get server() { return server; },
    get tailnet() { return tailnet; },
    token,
    // SIGHUP has no act to answer, so a config that fails to load reaches every client as an error.
    reload() {
      const reason = reloadAll();
      if (reason) for (const room of rooms.values()) room.broadcast({ type: "error", id: null, reason });
    },
    close(): Promise<void> {
      if (shutdown) return shutdown;
      server.stop(true);
      shutdown = Promise.all([...rooms.values()].map((room) => room.close())).then(() => {});
      return shutdown;
    },
  };
}
