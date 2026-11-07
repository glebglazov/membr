import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Act, Entry, ImportInput } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { NO_USAGE } from "./src/engine.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";
import { defaultStore } from "./test/config.ts";

const dirs: string[] = [], hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function dir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-import-")); dirs.push(dir); return dir; }
function json(lines: unknown[]): string { return lines.map((line) => JSON.stringify(line)).join("\n") + "\n"; }
const at = "2026-10-01T12:00:00.000Z";
function claude(n = 3, large = true): string {
  return json(Array.from({ length: n }, (_, i) => ({ type: i % 2 ? "assistant" : "user", uuid: `message-${i}`, sessionId: "claude-session", cwd: "/project", timestamp: at, message: { content: [{ type: "thinking", thinking: "PRIVATE THINKING" }, { type: "text", text: `Claude ${i} ` + (large ? "x".repeat(700) : "") }] } })));
}
function codex(): string {
  return json([
    { type: "session_meta", timestamp: at, payload: { id: "codex-session", cwd: "/project", source: "cli" } },
    { type: "response_item", timestamp: at, payload: { type: "reasoning", summary: "PRIVATE THINKING" } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "PRIVATE ANALYSIS" }] } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }, { type: "input_text", text: "Codex question " + "y".repeat(700) }] } },
    { type: "response_item", timestamp: at, payload: { type: "function_call", name: "shell", arguments: "z".repeat(700) } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "Codex answer " + "z".repeat(700) }] } },
  ]);
}
async function serve(engine = new FakeEngine((epoch) => epoch.emit(END)), directory = dir()) {
  const hub = serveHub({ dir: directory, port: 0, engine }); hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token }); clients.push(client);
  await client.wait("ready"); return { hub, client, engine, dir: directory };
}
async function act(client: TestClient, body: Act) {
  const mark = client.events.length; client.act(body);
  const answer = await client.wait("answer", mark, (event) => event.id === body.id);
  expect(answer.ok).toBe(true); return mark;
}
async function plan(client: TestClient, input: ImportInput) {
  const id = crypto.randomUUID(); client.read({ type: "read", read: "import", id, ...input });
  return (await client.wait("import-estimate", 0, (event) => event.id === id)).estimate;
}
function entries(client: TestClient): Entry[] { return client.entries; }
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("Import did not reach the expected state"); await Bun.sleep(5); }
}
async function complete(client: TestClient, id: string) { await client.wait("imports", 0, (event) => event.imports.some((run) => run.id === id && run.phase === "complete"), 5000); }

class Compactor extends FakeEngine {
  calls: string[] = []; active = 0; peak = 0;
  constructor(readonly build: (prompt: string) => Promise<string | null> = async () => "s".repeat(480)) { super((epoch) => epoch.emit(END)); }
  override async compact(prompt: string) {
    this.calls.push(prompt); this.peak = Math.max(this.peak, ++this.active);
    try { return { line: await this.build(prompt), usage: NO_USAGE }; } finally { this.active--; }
  }
}

test("S1 imports local sessions with estimates, original dates, no thinking, and durable incremental identity", async () => {
  const folder = dir();
  fs.mkdirSync(path.join(folder, "projects")); fs.mkdirSync(path.join(folder, "sessions")); fs.mkdirSync(path.join(folder, "archived_sessions"));
  const file = path.join(folder, "projects", "claude.jsonl");
  fs.writeFileSync(file, claude()); fs.writeFileSync(path.join(folder, "sessions", "codex.jsonl"), codex());
  const engine = new Compactor(); const first = await serve(engine);
  const inputs: ImportInput[] = [{ source: "claude-code", path: path.join(folder, "projects") }, { source: "codex", path: folder }];
  expect(await plan(first.client, inputs[0])).toEqual({ sessions: 1, messages: 3, compactions: 6 });
  await act(first.client, { type: "act", act: "import", id: "claude", ...inputs[0] }); await complete(first.client, "claude");
  expect(await plan(first.client, inputs[1])).toEqual({ sessions: 1, messages: 3, compactions: 7 });
  await act(first.client, { type: "act", act: "import", id: "codex", ...inputs[1] }); await complete(first.client, "codex");
  const imported = entries(first.client);
  expect(imported.map((entry) => entry.kind)).toEqual(["note", "ai", "ai", "ai", "note", "ai", "ai", "ai"]);
  expect(imported.every((entry) => entry.date === at)).toBe(true);
  expect(imported.map((entry) => entry.text).join("\n")).not.toMatch(/PRIVATE|AGENTS/);
  expect(imported[1].text).toStartWith("user: Claude 0"); expect(imported[2].text).toStartWith("assistant: Claude 1");
  expect(engine.calls).toHaveLength(13);
  expect(engine.peak).toBeLessThanOrEqual(4);
  const today = new Date().toISOString().slice(0, 10);
  expect(fs.readdirSync(path.join(defaultStore(first.dir), "main"))).toEqual([today + ".jsonl"]);
  for (const input of inputs) {
    expect(await plan(first.client, input)).toEqual({ sessions: 0, messages: 0, compactions: 0 });
    await act(first.client, { type: "act", act: "import", id: crypto.randomUUID(), ...input });
  }
  expect(entries(first.client)).toHaveLength(8);
  await first.hub.close();
  fs.renameSync(path.join(folder, "sessions", "codex.jsonl"), path.join(folder, "archived_sessions", "codex.jsonl"));
  fs.appendFileSync(file, json([{ type: "assistant", uuid: "new-at-same-time", sessionId: "claude-session", timestamp: at, message: { content: "New at the same time" } }]));
  const next = await serve(new Compactor(), first.dir);
  expect((await plan(next.client, inputs[0])).messages).toBe(1);
  expect((await plan(next.client, inputs[1])).messages).toBe(0);
  await act(next.client, { type: "act", act: "import", id: "new", ...inputs[0] });
  expect(entries(next.client).map((entry) => entry.text)).toEqual(["assistant: New at the same time"]);
  await act(next.client, { type: "act", act: "import", id: "new", ...inputs[0] });
  expect(entries(next.client)).toHaveLength(1);
});

test("S1 folder payload skips malformed lines, subagents, injected context, and invalid dates", async () => {
  const { client } = await serve();
  const text = claude(1, false) + "null\nBAD JSON\n" + json([
    { type: "user", timestamp: 1e20, message: { content: "INVALID DATE" } },
    { type: "user", timestamp: at, message: { content: [null] } },
    { type: "assistant", uuid: "good", sessionId: "claude-session", timestamp: at, message: { content: "Still valid" } },
  ]);
  const input: ImportInput = { source: "claude-code", path: "projects", files: [{ name: "projects/a.jsonl", text }, { name: "projects/subagents/ignored.jsonl", text: claude(9) }] };
  expect((await plan(client, input)).messages).toBe(2);
  await act(client, { type: "act", act: "import", id: "files", ...input });
  expect(entries(client).map((entry) => entry.text).join("\n")).not.toMatch(/PRIVATE|INVALID DATE/);
  expect(entries(client)).toHaveLength(3);
});

test("S1 an act answered during a folder scan keeps one durable effect", async () => {
  const folder = dir();
  const nested = path.join(folder, ...Array.from({ length: 20 }, (_, i) => String(i)));
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "session.jsonl"), claude(1, false));
  const first = await serve();
  first.client.act({ type: "act", act: "import", id: "shared", source: "claude-code", path: folder });
  first.client.act({ type: "act", act: "say", id: "shared", text: "The first accepted act" });
  await until(() => first.client.events.filter((event) => event.type === "answer" && event.id === "shared").length === 2);
  const answers = first.client.events.filter((event) => event.type === "answer" && event.id === "shared");
  expect(answers[1]).toEqual(answers[0]);
  expect(entries(first.client).map((entry) => entry.text)).toEqual(["The first accepted act"]);
  await first.hub.close();
  const restarted = await serve(new FakeEngine(), first.dir);
  expect(entries(restarted.client).map((entry) => entry.text)).toEqual(["The first accepted act"]);
});

test("S1 paused import leaves capacity for a forced batch turn, then resumes after restart", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const engine = new Compactor(async (prompt) => { if (prompt.includes("ai: ")) await held; return "summary"; });
  const first = await serve(engine);
  await act(first.client, { type: "act", act: "say", id: "fill", text: "Prepare the view" });
  for (let i = 0; i < 280; i++) engine.epochs[0].emit({ kind: "text", text: `${i} ` + "v".repeat(480) });
  await until(() => entries(first.client).length === 281);
  const input: ImportInput = { source: "claude-code", path: "projects", files: [{ name: "a.jsonl", text: claude(300) }] };
  await act(first.client, { type: "act", act: "import", id: "held", ...input });
  await until(() => engine.active === 3);
  await act(first.client, { type: "act", act: "go", id: "pause", import: "held", paused: true });
  const mark = await act(first.client, { type: "act", act: "say", id: "live", text: "Answer during import" });
  await first.client.wait("state", mark, (event) => !event.state.busy);
  expect(engine.epochs.length).toBeGreaterThan(1);
  expect(engine.epochs.at(-1)?.messages[0].text).toContain("Answer during import");
  expect(engine.epochs.at(-1)?.messages[0].text).toContain("Memory update from membr");
  const original = engine.epochs.at(-1)?.options.memory?.zoom(282).text;
  expect(original).toContain("Claude 0");
  const calls = engine.calls.length; release(); await until(() => engine.active === 0);
  await Bun.sleep(30); expect(engine.calls.length).toBe(calls);
  expect(engine.peak).toBeLessThanOrEqual(4);
  await first.hub.close();
  const resumed = new Compactor(async () => "summary"); const second = await serve(resumed, first.dir);
  await second.client.wait("imports", 0, (event) => event.imports.some((run) => run.id === "held" && run.phase === "paused"));
  await Bun.sleep(30); expect(resumed.calls).toHaveLength(0);
  await act(second.client, { type: "act", act: "go", id: "resume", import: "held", paused: false });
  await complete(second.client, "held"); expect(resumed.calls.length).toBeGreaterThan(0);
}, 15000);

test("S1 pause prevents failed import calls from retrying until resume", async () => {
  let fail = true;
  const engine = new Compactor(async () => { if (fail) throw new Error("Temporary outage"); return "summary"; });
  const { client } = await serve(engine);
  await act(client, { type: "act", act: "import", id: "retry", source: "claude-code", path: "", files: [{ name: "a.jsonl", text: claude(10) }] });
  await until(() => engine.calls.length === 3);
  await act(client, { type: "act", act: "go", id: "pause-retry", import: "retry", paused: true });
  await Bun.sleep(1150); expect(engine.calls).toHaveLength(3);
  fail = false;
  await act(client, { type: "act", act: "go", id: "resume-retry", import: "retry", paused: false });
  await complete(client, "retry"); expect(engine.calls.length).toBeGreaterThan(3);
}, 10000);

test("S1 retries an interrupted ingest from its durable entry identities and saved estimate", async () => {
  const input: ImportInput = { source: "claude-code", path: "projects", files: [{ name: "a.jsonl", text: claude() }] };
  const first = await serve(new Compactor());
  await act(first.client, { type: "act", act: "import", id: "interrupted", ...input });
  await first.hub.close();
  const journal = fs.readdirSync(path.join(defaultStore(first.dir), "main"))[0];
  const lines = fs.readFileSync(path.join(defaultStore(first.dir), "main", journal), "utf8").trimEnd().split("\n");
  const partial: string[] = []; let imported = 0;
  for (const line of lines) { partial.push(line); if (JSON.parse(line).imported && ++imported === 2) break; }
  const recovered = dir(), store = defaultStore(recovered); fs.mkdirSync(path.join(store, "main"), { recursive: true });
  fs.copyFileSync(path.join(defaultStore(first.dir), "machine"), path.join(store, "machine"));
  fs.writeFileSync(path.join(store, "main", journal), partial.join("\n") + "\n");
  const next = await serve(new Compactor(), recovered);
  expect(entries(next.client)).toEqual([]);
  await act(next.client, { type: "act", act: "import", id: "interrupted", ...input });
  await complete(next.client, "interrupted");
  expect(entries(next.client).map((entry) => entry.kind)).toEqual(["ai", "ai"]);
  const status = await next.client.wait("imports", 0, (event) => event.imports.some((run) => run.id === "interrupted" && run.phase === "complete"));
  expect(status.imports.find((run) => run.id === "interrupted")).toEqual({ id: "interrupted", phase: "complete", sessions: 1, messages: 3, compactions: 6 });
  await act(next.client, { type: "act", act: "import", id: "interrupted", ...input });
  expect(entries(next.client)).toHaveLength(2);
});

test("S1 a mixed parent ending in a live message does not reopen a completed import", async () => {
  const engine = new Compactor(); const { client } = await serve(engine);
  await act(client, { type: "act", act: "import", id: "past", source: "claude-code", path: "", files: [{ name: "a.jsonl", text: claude(2) }] });
  await complete(client, "past");
  await act(client, { type: "act", act: "go", id: "pause-complete", import: "past", paused: true });
  const mark = client.events.length;
  await act(client, { type: "act", act: "say", id: "present", text: "Present " + "v".repeat(700) });
  await until(() => engine.calls.some((prompt) => prompt.includes("merge lines 0+2 and 2+2")));
  expect(client.events.slice(mark).flatMap((event) => event.type === "imports" ? event.imports : []).some((run) => run.id === "past" && run.phase !== "complete")).toBe(false);
});

test("S1 a goal check keeps a bounded recent tail while a large import is paused", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const engine = new Compactor(async () => { await held; return "summary"; });
  const { client, hub } = await serve(engine);
  await act(client, { type: "act", act: "import", id: "goal-import", source: "claude-code", path: "", files: [{ name: "a.jsonl", text: claude(1023) }] });
  await until(() => engine.active === 3);
  await act(client, { type: "act", act: "go", id: "goal-pause", import: "goal-import", paused: true });
  await act(client, { type: "act", act: "goal", id: "goal", text: "Check the newest request" });
  await act(client, { type: "act", act: "say", id: "goal-turn", text: "The newest request" });
  await until(() => engine.checks.length === 1);
  expect(Buffer.byteLength(engine.checks[0].chat)).toBeLessThan(40000);
  expect(engine.checks[0].chat).toContain("The newest request");
  expect(engine.checks[0].chat).toContain("not summarized yet: zoom it");
  expect(engine.checks[0].chat).not.toContain("user: Claude 0 ");
  expect(engine.active).toBe(3);
  await hub.close(); release();
}, 15000);

for (const [source, fixture, expected] of [
  ["claude.ai", "claude-ai", ["user: Claude website question\n[file notes.txt]", "assistant: Claude website answer", 'tool: search {"query":"membr"}', "echo: Found membr"]],
  ["chatgpt", "chatgpt", ["user: ChatGPT website question\n[image]", "tool: browser Search membr", "echo: Search result", "assistant: ChatGPT website answer"]],
] as const) {
  for (const format of ["payload", "json", "zip", ...(source === "chatgpt" ? ["zip64"] : [])]) {
    test(`S1 imports the ${source} ${format} conversations fixture with dates and durable identity`, async () => {
      const file = path.join(import.meta.dir, "test", "fixtures", fixture + ".json");
      const input: ImportInput = format === "payload"
        ? { source, path: "conversations.json", files: [{ name: "conversations.json", text: fs.readFileSync(file, "utf8") }] }
        : { source, path: path.join(import.meta.dir, "test", "fixtures", fixture + (format === "zip64" ? "-zip64.zip" : "." + format)) };
      const first = await serve(new Compactor());
      expect(await plan(first.client, input)).toEqual({ sessions: 1, messages: 4, compactions: 0 });
      expect(entries(first.client)).toEqual([]);
      await act(first.client, { type: "act", act: "import", id: "website", ...input });
      await complete(first.client, "website");
      const saved = entries(first.client);
      expect(saved[0].kind).toBe("note");
      expect(saved.slice(1).map((entry) => entry.text)).toEqual([...expected]);
      expect(saved.slice(1).map((entry) => entry.date)).toEqual(source === "claude.ai" ? ["2026-10-01T12:00:01.000Z", ...Array(3).fill("2026-10-01T12:00:02.000Z")] : [...Array(3).fill("2026-10-01T12:00:01.000Z"), "2026-10-01T12:00:02.000Z"]);
      await first.hub.close();
      const next = await serve(new Compactor(), first.dir);
      expect(await plan(next.client, { source, path: file })).toEqual({ sessions: 0, messages: 0, compactions: 0 });
      const chats = JSON.parse(fs.readFileSync(file, "utf8"));
      if (source === "claude.ai") chats[0].chat_messages.push({ uuid: "new-same-time", sender: "assistant", created_at: "2026-10-01T12:00:02Z", text: "New website answer" });
      else {
        chats[0].mapping.new = { parent: "a", message: { id: "new-same-time", author: { role: "assistant" }, recipient: "all", create_time: 1790856002, content: { content_type: "text", parts: ["New website answer"] } } };
        chats[0].current_node = "new";
      }
      const updated: ImportInput = { source, path: "renamed.json", files: [{ name: "renamed.json", text: JSON.stringify(chats) }] };
      expect((await plan(next.client, updated)).messages).toBe(1);
      await act(next.client, { type: "act", act: "import", id: "website-new", ...updated });
      expect(entries(next.client).at(-1)?.text).toBe("assistant: New website answer");
    });
  }
}

test("S1 rejects invalid website exports and cyclic ChatGPT trees before writing", async () => {
  const { client } = await serve();
  const chats = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "test", "fixtures", "chatgpt.json"), "utf8"));
  chats[0].mapping.u.parent = "a";
  for (const [source, contents, reason] of [
    ["claude.ai", "not JSON", "not valid JSON"],
    ["claude.ai", '{"chat_messages":[]}', "list of conversations"],
    ["chatgpt", '[{"uuid":"wrong","chat_messages":[]}]', "not a chatgpt"],
    ["chatgpt", JSON.stringify(chats), "invalid message tree"],
  ] as const) {
    const id = crypto.randomUUID(), input = { source, path: "conversations.json", files: [{ name: "conversations.json", text: contents }] };
    client.read({ type: "read", read: "import", id, ...input });
    expect((await client.wait("error", 0, (event) => event.id === id)).reason).toContain(reason);
    client.act({ type: "act", act: "import", id, ...input });
    const answer = await client.wait("answer", 0, (event) => event.id === id);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.reason).toContain(reason);
  }
  expect(entries(client)).toEqual([]);
});
