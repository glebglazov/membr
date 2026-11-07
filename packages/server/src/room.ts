import fs from "node:fs";
import { VERSION, isScheduleAct, parseClientMessage, type AgentInfo, type ClientMessage, type Event, type Read } from "@membr/protocol";
import { Log } from "./log.ts";
import { Epochs } from "./epochs.ts";
import { Chat } from "./chat.ts";
import { claude, type Engine, type EpochOptions } from "./engine.ts";
import { Tree } from "./tree.ts";
import { Imports } from "./import.ts";
import { Memory } from "./memory.ts";
import type { AgentConfig } from "./config.ts";
import { imagePath, IMAGE_COUNT, storeImage } from "./images.ts";
import { cleanupEpochs } from "./export-cleanup.ts";
import type { Clock } from "./clock.ts";

// The part of a WebSocket a room needs: it sends events, and refuses with a close.
export type Client = { send(data: string): unknown; close(code?: number, reason?: string): void };

export type RoomOptions = {
  config: AgentConfig; store: string; engine?: Engine; epoch?: Partial<EpochOptions>; clock?: Clock;
  // reloads config.json for every room; null when it loaded, else the reason it did not
  reloadAll: () => string | null;
  // the room's busy state may have changed, so the hub's agent list may be new
  changed: () => void;
};

// One agent inside the hub: its store, its chat and the clients that watch it. Nothing in it is shared with another room.
export class Room {
  readonly name: string;
  private readonly clients = new Set<Client>();
  private readonly log: Log;
  private readonly tree: Tree;
  private readonly memory: Memory;
  private readonly chat: Chat;
  private readonly imports: Imports;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private config: AgentConfig;

  constructor(private readonly options: RoomOptions) {
    this.name = options.config.name;
    this.config = options.config;
    fs.mkdirSync(options.store, { recursive: true });
    fs.mkdirSync(options.config.home, { recursive: true });
    const engine = options.engine ?? claude;
    this.log = new Log(options.store);
    const epochs = new Epochs(options.store);
    let tree: Tree | undefined, chat: Chat | undefined;
    try {
      tree = new Tree(options.store, this.log, engine);
      this.memory = new Memory(this.log, tree, options.store);
      chat = new Chat(this.log, epochs, tree, this.memory, options.store, (event) => {
        if (event.type === "entry") tree?.sync();
        this.broadcast(event);
        if (event.type === "state") options.changed();
      }, options.engine, options.epoch, options.config, options.reloadAll, options.clock);
      this.imports = new Imports(this.log, tree, (event) => this.broadcast(event), (entries) => chat!.imported(entries));
      tree.onChange = () => { this.imports.changed(); chat?.compressed(); };
    } catch (error) {
      chat?.close();
      tree?.close();
      throw error;
    }
    this.tree = tree;
    this.chat = chat;
    const purge = () => void cleanupEpochs(epochs, engine, this.chat.activeEpoch, Date.now(), this.config.home).catch((error) => console.error(`membr: session cleanup of ${this.name} failed`, error));
    purge();
    this.cleanupTimer = setInterval(purge, 86_400_000);
  }

  get info(): AgentInfo {
    return { name: this.name, busy: this.chat.state.busy, about: this.config.prompt.split("\n").find((line) => line.trim())?.trim() ?? "" };
  }

  apply(config: AgentConfig): void {
    this.config = config;
    this.chat.apply(config);
  }

  broadcast(event: Event): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) client.send(data);
  }

  // A client that sent a valid hello gets the latest page of the log and the live state, then every event.
  join(client: Client, agents: AgentInfo[]): void {
    const send = (event: Event) => client.send(JSON.stringify(event));
    send({ type: "history", ...this.chat.page(this.log.count) });
    this.clients.add(client);
    for (const ask of this.chat.asks) send(ask);
    send(this.chat.viewEvent());
    send({ type: "state", state: this.chat.state });
    if (this.chat.live) send({ type: "live", text: this.chat.live, subagent: null });
    send({ type: "imports", imports: this.imports.status });
    send(this.chat.skills);
    send(this.chat.schedules.event);
    send(this.chat.notebook.event);
    send({ type: "agents", agents });
    send({ type: "ready", version: VERSION });
  }

  leave(client: Client): void { this.clients.delete(client); }

  refuse(id: string, reason: string) { return this.chat.refuse(id, reason); }

  async message(client: Client, message: Exclude<ClientMessage, { type: "hello" }>): Promise<void> {
    const send = (event: Event) => client.send(JSON.stringify(event));
    if (message.type === "read") return await this.read(send, message);
    if (message.type === "act" && message.act === "notebook") { send(this.chat.notebook.act(message)); return; }
    send(isScheduleAct(message) ? this.chat.schedules.act(message) : message.act === "import" || message.act === "go" ? await this.imports.act(message) : this.chat.act(message));
  }

  private async read(send: (event: Event) => void, request: Read): Promise<void> {
    if (request.read === "import") {
      try {
        const plan = await this.imports.plan(request);
        send({ type: "import-estimate", id: request.id, estimate: plan.estimate });
      } catch (error) { send({ type: "error", id: request.id, reason: error instanceof Error ? error.message : "The import estimate failed." }); }
      return;
    }
    if (request.read === "subagent") {
      const subagent = this.chat.subagents.read(request.name);
      if (subagent) send({ type: "read", id: request.id, entries: subagent.entries, live: subagent.live, parts: [], lines: [] });
      else send({ type: "error", id: request.id, reason: "No subagent " + request.name + "." });
      return;
    }
    if (request.read === "roots" || request.read === "root") {
      const lines = this.memory.roots();
      send({ type: "read", id: request.id, entries: [], parts: lines.map(({ l, i }) => ({ l, i })), lines });
      return;
    }
    if (request.read === "page") {
      send({ type: "read", id: request.id, ...this.chat.page(request.before), parts: [], lines: [] });
      return;
    }
    if (request.read === "when") {
      send(await this.chat.schedules.preview(request));
      return;
    }
    const opened = this.memory.browse(request.part);
    const lines = opened.kind === "message" ? [] : opened.lines;
    send({ type: "read", id: request.id, entries: opened.kind === "message" ? [opened.entry] : [], parts: lines.map(({ l, i }) => ({ l, i })), lines, ...(opened.kind === "missing" ? { error: opened.reason } : {}) });
  }

  // POST act/say: a message with images, which are too large for the socket.
  async say(request: Request, id: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    try {
      parseClientMessage({ type: "act", act: "say", id, text: "" });
      const previous = this.log.answer(id);
      if (previous) return Response.json(previous);
      const form = await request.formData();
      const text = form.get("text");
      const files = form.getAll("images");
      if (typeof text !== "string" || !files.length || files.length > IMAGE_COUNT || files.some((file) => !(file instanceof File))) throw new Error("Attach 1 to 20 images and a text field.");
      const images: string[] = [];
      for (const file of files) {
        if (!(file instanceof File)) throw new Error("Expected an image file.");
        images.push(await storeImage(this.options.store, Buffer.from(await file.arrayBuffer()), file.type));
      }
      return Response.json(this.chat.act({ type: "act", act: "say", id, text, images }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The image upload failed.";
      if (!id || id.length > 256) return new Response(reason, { status: 400 });
      const answer = this.chat.refuse(id, reason);
      return Response.json(answer, { status: answer.ok ? 200 : 400 });
    }
  }

  export(request: Request): Response {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    return Response.json(this.chat.export(), { headers: { "Content-Disposition": `attachment; filename="membr-${this.name}-memory.json"`, "Cache-Control": "no-store" } });
  }

  notebook(request: Request): Response {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    return new Response(this.chat.notebook.current.text, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${this.name}-notebook.md"`, "Cache-Control": "no-store" } });
  }

  async image(request: Request, name: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    try {
      const file = Bun.file(imagePath(this.options.store, decodeURIComponent(name)));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" } });
    } catch { return new Response("Not found", { status: 404 }); }
  }

  // Clients of a room that closes get a close code, so they do not wait on a chat that is gone.
  close(reason?: string): Promise<void> {
    clearInterval(this.cleanupTimer);
    const importing = this.imports.close();
    this.chat.close();
    this.tree.close();
    if (reason) for (const client of this.clients) client.close(1001, reason.slice(0, 120));
    this.clients.clear();
    return importing;
  }
}
