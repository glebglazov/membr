import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Act, Entry, ImportInput } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";

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
function entries(client: TestClient): Entry[] { return client.events.flatMap((event) => event.type === "entry" ? [event.entry] : []); }
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
    try { return await this.build(prompt); } finally { this.active--; }
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
  expect(fs.readdirSync(path.join(first.dir, "main"))).toEqual([today + ".jsonl"]);
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
  expect(entries(next.client)).toHaveLength(9);
  expect(entries(next.client).at(-1)?.text).toBe("assistant: New at the same time");
  await act(next.client, { type: "act", act: "import", id: "new", ...inputs[0] });
  expect(entries(next.client)).toHaveLength(9);
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
  const journal = fs.readdirSync(path.join(first.dir, "main"))[0];
  const lines = fs.readFileSync(path.join(first.dir, "main", journal), "utf8").trimEnd().split("\n");
  const partial: string[] = []; let imported = 0;
  for (const line of lines) { partial.push(line); if (JSON.parse(line).imported && ++imported === 2) break; }
  const recovered = dir(); fs.mkdirSync(path.join(recovered, "main"));
  fs.copyFileSync(path.join(first.dir, "machine"), path.join(recovered, "machine"));
  fs.writeFileSync(path.join(recovered, "main", journal), partial.join("\n") + "\n");
  const next = await serve(new Compactor(), recovered);
  expect(entries(next.client)).toHaveLength(2);
  await act(next.client, { type: "act", act: "import", id: "interrupted", ...input });
  await complete(next.client, "interrupted");
  expect(entries(next.client).map((entry) => entry.kind)).toEqual(["note", "ai", "ai", "ai"]);
  const status = await next.client.wait("imports", 0, (event) => event.imports.some((run) => run.id === "interrupted" && run.phase === "complete"));
  expect(status.imports.find((run) => run.id === "interrupted")).toEqual({ id: "interrupted", phase: "complete", sessions: 1, messages: 3, compactions: 6 });
  await act(next.client, { type: "act", act: "import", id: "interrupted", ...input });
  expect(entries(next.client)).toHaveLength(4);
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
