// Protocol replay adapted from UniiChat cache.test.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { NO_USAGE } from "./src/engine.ts";
import { END, FakeEngine, type FakeEpoch } from "./test/engine.ts";
import { defaultStore } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function serve(engine: FakeEngine, dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-view-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return { ...hub, client, dir, engine };
}
async function say(hub: Awaited<ReturnType<typeof serve>>, id: string, text: string) {
  const mark = hub.client.events.length;
  hub.client.act({ type: "act", act: "say", id, text });
  expect((await hub.client.wait("answer", mark, (event) => event.id === id)).ok).toBe(true);
  await hub.client.wait("state", mark, (event) => !event.state.busy, 10000);
}
function saved(dir: string): { lines: Array<{ l: number; i: number; text: string }>; pick: unknown; goal: string | null } {
  return JSON.parse(fs.readFileSync(path.join(defaultStore(dir), "view.json"), "utf8"));
}
function bytes(seed: number, n: number): string {
  let text = "";
  for (let i = 0; text.length < n; i++) text += createHash("sha256").update(`${seed}/${i}`).digest("base64");
  return text.slice(0, n);
}
class Prefixes {
  previous = Buffer.alloc(0);
  readonly samples: Array<{ reuse: number; input: number; share: number }> = [];
  add(prompt: string): void {
    const input = Buffer.from(prompt);
    let reuse = 0;
    while (reuse < input.length && reuse < this.previous.length && input[reuse] === this.previous[reuse]) reuse++;
    this.samples.push({ reuse, input: input.length, share: reuse / input.length });
    this.previous = input;
  }
  get share() { return this.samples.reduce((n, s) => n + s.reuse, 0) / this.samples.reduce((n, s) => n + s.input, 0); }
}

// The 64 KB budget is the view's: the notebook block before it has its own cap.
const withoutNotebook = (view: string) => view.slice(view.indexOf("The following chat"));

test("3000 protocol messages retain at least 95% prompt prefixes and rotate only at complete batches", async () => {
  const turns = new Prefixes(), compactions = new Prefixes();
  const transcripts = new Map<FakeEpoch, string>();
  let previousParts: Array<{ l: number; i: number }> = [];
  let entriesSeen = 0;
  let replacements = 0;
  let messages = 0;
  let dir = "";
  class Replay extends FakeEngine {
    override open(view: string, options: Parameters<FakeEngine["open"]>[1]) {
      if (this.epochs.length) {
        expect(this.epochs.at(-1)!.closed).toBe(true);
        expect(Buffer.byteLength(withoutNotebook(view))).toBeLessThanOrEqual(64000);
        const state = saved(dir);
        const all = state.lines.map((part) => `${part.i * 2 ** part.l}+${2 ** part.l}|${part.text.replace(/\s*\n\s*/g, " ")}\n`).join("");
        expect(Buffer.byteLength(withoutNotebook(view).slice(0, withoutNotebook(view).indexOf("<chat>\n")) + `<chat>\n${all}</chat>\n`)).toBeLessThanOrEqual(64000);
        const body = state.lines.filter((line) => (line.i + 1) * 2 ** line.l <= messages).map((line) => `${line.i * 2 ** line.l}+${2 ** line.l}|${line.text.replace(/\s*\n\s*/g, " ")}\n`).join("");
        expect(view.slice(view.indexOf("<chat>\n"))).toBe(`<chat>\n${body}</chat>\n`);
      }
      return super.open(view, options);
    }
    override async compact(prompt: string) {
      compactions.add(prompt.slice(0, prompt.indexOf("Compaction:")));
      const task = prompt.slice(prompt.indexOf("Compaction:"));
      const hash = createHash("sha256").update(task).digest("hex");
      return { line: `summary ${hash} ` + bytes(parseInt(hash.slice(0, 6), 16), 240 + parseInt(hash.slice(0, 2), 16) % 160), usage: NO_USAGE };
    }
  }
  const engine = new Replay((epoch, message) => {
    const input = (transcripts.get(epoch) ?? epoch.view) + `\nuser: ${message.text}\n`;
    turns.add(input);
    const n = messages;
    const tool = { id: `tool-${n}`, name: "Read", input: { file_path: `/file-${n}` } };
    const echo = bytes(n + 1, 600 + n % 1300);
    const reply = bytes(n + 2, 200 + n % 800);
    transcripts.set(epoch, input + `tool: ${JSON.stringify(tool)}\necho: ${echo}\nunii: ${reply}\n`);
    messages += 4;
    epoch.emit({ kind: "tool", ...tool }, { kind: "echo", id: tool.id, text: echo, error: false }, { kind: "text", text: reply }, END);
  });
  const hub = await serve(engine); dir = hub.dir;
  for (let i = 0; i < 750; i++) {
    const mark = hub.client.events.length;
    const priorEpochs = engine.epochs.length;
    await say(hub, `message-${i}`, bytes(i * 4, 80 + i % 900));
    const waits = hub.client.events.slice(mark).filter((event) => event.type === "state" && event.state.wait === "summaries");
    expect(engine.epochs.length - priorEpochs).toBe(waits.length ? 1 : 0);
    const priorReplacements = replacements;
    for (const event of hub.client.events.slice(mark)) {
      if (event.type === "entry") entriesSeen++;
      if (event.type !== "view") continue;
      let covered = 0;
      for (const part of event.parts) {
        expect(part.i * 2 ** part.l).toBe(covered);
        covered = (part.i + 1) * 2 ** part.l;
      }
      expect(covered).toBe(entriesSeen);
      const appended = previousParts.every((part, k) => event.parts[k]?.l === part.l && event.parts[k]?.i === part.i);
      if (!appended) replacements++;
      previousParts = event.parts;
    }
    expect(engine.epochs.length - priorEpochs).toBe(replacements - priorReplacements);
  }
  expect(messages).toBe(3000);
  expect(hub.client.events.filter((event) => event.type === "entry")).toHaveLength(3000);
  expect(engine.epochs.length).toBeGreaterThan(2);
  expect(replacements).toBe(engine.epochs.length - 1);
  expect(turns.samples).toHaveLength(750);
  expect(compactions.samples.length).toBeGreaterThan(1000);
  expect(turns.samples[0].reuse).toBe(0);
  expect(compactions.samples[0].reuse).toBe(0);
  console.log(`prefix reuse: turns ${(100 * turns.share).toFixed(2)}%, compactions ${(100 * compactions.share).toFixed(2)}%; ${engine.epochs.length - 1} batches, ${compactions.samples.length} compactions, ${messages} messages`);
  expect(turns.share).toBeGreaterThanOrEqual(0.95);
  expect(compactions.share).toBeGreaterThanOrEqual(0.95);
  const before = fs.readFileSync(path.join(defaultStore(dir), "view.json"), "utf8");
  hub.close();
  const after = await serve(new FakeEngine(), dir);
  expect(fs.readFileSync(path.join(defaultStore(dir), "view.json"), "utf8")).toBe(before);
  expect(after.engine.epochs[0].view).toContain("<chat>\n");
}, 120000);

test("restart keeps placeholders, pick and goal in the saved view", async () => {
  const held = Promise.withResolvers<string>();
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.compact = () => held.promise.then((line) => ({ line, usage: NO_USAGE }));
  const before = await serve(engine);
  await say(before, "long", "long message ".repeat(100));
  expect(saved(before.dir).lines[0].text).toBe("(not summarized yet: zoom it)");
  const pick = { model: "haiku", effort: "low", fast: false } as const;
  before.client.act({ type: "act", act: "pick", id: "pick", pick });
  await before.client.wait("answer", 0, (event) => event.id === "pick");
  expect(saved(before.dir).pick).toEqual(pick);
  before.client.act({ type: "act", act: "goal", id: "goal", text: "Keep the saved view" });
  await before.client.wait("answer", 0, (event) => event.id === "goal");
  expect(saved(before.dir).goal).toBe("Keep the saved view");
  held.resolve("The tree summary is complete.");
  const treeDir = path.join(defaultStore(before.dir), "tree");
  for (let attempt = 0; attempt < 100 && fs.readdirSync(treeDir).length === 0; attempt++) await Bun.sleep(10);
  const summaries = fs.readdirSync(treeDir).map((file) => fs.readFileSync(path.join(treeDir, file), "utf8"));
  expect(summaries.join("\n")).toContain("The tree summary is complete.");
  expect(saved(before.dir).lines[0].text).toBe("(not summarized yet: zoom it)");
  const bytes = fs.readFileSync(path.join(defaultStore(before.dir), "view.json"));
  await before.close();
  const after = await serve(new FakeEngine(), before.dir);
  expect(fs.readFileSync(path.join(defaultStore(before.dir), "view.json"))).toEqual(bytes);
  expect(after.engine.epochs[0].view).toContain("0+1|(not summarized yet: zoom it)");
  expect(after.engine.epochs[0].options.pick).toEqual(pick);
  expect((await after.client.wait("state")).state.goal).toBe("Keep the saved view");
});

async function waitingBatch() {
  const held = Promise.withResolvers<string>();
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.compact = () => held.promise.then((line) => ({ line, usage: NO_USAGE }));
  const hub = await serve(engine);
  for (let i = 0; i < 300; i++) {
    const mark = hub.client.events.length;
    hub.client.act({ type: "act", act: "say", id: `seed-${i}`, text: bytes(i, 500) });
    expect((await hub.client.wait("answer", mark)).ok).toBe(true);
    if (hub.client.events.slice(mark).some((event) => event.type === "state" && event.state.wait === "summaries")) return { ...hub, held, cutoff: i };
    await hub.client.wait("state", mark, (event) => !event.state.busy);
  }
  throw new Error("The view never crossed 128000 bytes");
}

test("a batch waits for summaries, uses the latest pick and sends queued input once", async () => {
  const hub = await waitingBatch();
  expect(hub.engine.epochs).toHaveLength(1);
  expect(hub.engine.epochs[0].closed).toBe(false);
  const before = saved(hub.dir).lines;
  hub.client.act({ type: "act", act: "say", id: "queued", text: "QUEUED INPUT" });
  await hub.client.wait("answer", 0, (event) => event.id === "queued");
  const pick = { model: "haiku", effort: "low", fast: false } as const;
  hub.client.act({ type: "act", act: "pick", id: "during-wait", pick });
  await hub.client.wait("answer", 0, (event) => event.id === "during-wait");
  expect(saved(hub.dir).lines.slice(0, before.length)).toEqual(before);
  const mark = hub.client.events.length;
  hub.held.resolve("s".repeat(400));
  await hub.client.wait("state", mark, (event) => !event.state.busy, 10000);
  expect(hub.engine.epochs).toHaveLength(2);
  const epoch = hub.engine.epochs[1];
  expect(epoch.options.pick).toEqual(pick);
  expect(epoch.view).not.toContain("QUEUED INPUT");
  expect(epoch.messages.map((message) => message.text)).toEqual([bytes(hub.cutoff, 500), "QUEUED INPUT"]);
  expect(Buffer.byteLength(epoch.view)).toBeLessThanOrEqual(64000);
  expect(hub.engine.epochs[0].closed).toBe(true);
});

test("a batch fits the complete view with a large pending tail and sends every input once", async () => {
  const hub = await waitingBatch();
  const pending = Array.from({ length: 130 }, (_, i) => bytes(10000 + i, 500));
  for (const [i, text] of pending.entries()) {
    hub.client.act({ type: "act", act: "say", id: `pending-${i}`, text });
    expect((await hub.client.wait("answer", 0, (event) => event.id === `pending-${i}`)).ok).toBe(true);
  }
  const mark = hub.client.events.length;
  hub.held.resolve("s".repeat(400));
  await hub.client.wait("state", mark, (event) => !event.state.busy, 10000);
  expect(hub.engine.epochs).toHaveLength(2);
  const epoch = hub.engine.epochs[1];
  expect(epoch.messages.map((message) => message.text)).toEqual([bytes(hub.cutoff, 500), ...pending]);
  for (const text of pending) expect(epoch.view).not.toContain(text);
  let history = 0;
  for (const match of epoch.view.matchAll(/^(\d+)\+(\d+)\|/gm)) {
    expect(Number(match[1])).toBe(history);
    history += Number(match[2]);
  }
  expect(history).toBe(hub.cutoff);
  const lines = saved(hub.dir).lines;
  let covered = 0;
  for (const part of lines) {
    expect(part.i * 2 ** part.l).toBe(covered);
    covered = (part.i + 1) * 2 ** part.l;
  }
  expect(covered).toBe(hub.cutoff + pending.length + 1);
  const body = lines.map((part) => `${part.i * 2 ** part.l}+${2 ** part.l}|${part.text.replace(/\s*\n\s*/g, " ")}\n`).join("");
  const full = withoutNotebook(epoch.view).slice(0, withoutNotebook(epoch.view).indexOf("<chat>\n")) + `<chat>\n${body}</chat>\n`;
  expect(Buffer.byteLength(full)).toBeLessThanOrEqual(64000);
});

test("a permanent tree write failure ends the summary wait", async () => {
  const hub = await waitingBatch();
  const tree = path.join(defaultStore(hub.dir), "tree");
  const file = path.join(tree, new Date().toISOString().slice(0, 10) + ".jsonl");
  fs.renameSync(file, file + ".saved");
  fs.mkdirSync(file);
  const mark = hub.client.events.length;
  hub.held.resolve("s".repeat(400));
  expect((await hub.client.wait("error", mark, () => true, 10000)).reason).toContain(file);
  expect((await hub.client.wait("state", mark, (event) => !event.state.busy)).state.wait).toBe("");
  expect(hub.engine.epochs).toHaveLength(1);
  expect(hub.engine.epochs[0].closed).toBe(true);
});

test("stop cancels a summary wait without opening or sending to another epoch", async () => {
  const hub = await waitingBatch();
  const mark = hub.client.events.length;
  hub.client.act({ type: "act", act: "stop", id: "stop", subagent: null });
  expect((await hub.client.wait("answer", mark)).ok).toBe(true);
  await hub.client.wait("state", mark, (event) => !event.state.busy);
  const sent = hub.engine.epochs[0].messages.length;
  hub.held.resolve("s".repeat(400));
  await Bun.sleep(20);
  expect(hub.engine.epochs).toHaveLength(1);
  expect(hub.engine.epochs[0].messages).toHaveLength(sent);
  expect(hub.engine.epochs[0].closed).toBe(false);
});

test("close cancels a summary wait and late summaries do not rewrite the view", async () => {
  const hub = await waitingBatch();
  const before = fs.readFileSync(path.join(defaultStore(hub.dir), "view.json"));
  hub.close();
  hub.held.resolve("s".repeat(400));
  await Bun.sleep(20);
  expect(hub.engine.epochs).toHaveLength(1);
  expect(fs.readFileSync(path.join(defaultStore(hub.dir), "view.json"))).toEqual(before);
});

test("a failed view save fails the chat after the input reaches the log", async () => {
  const hub = await serve(new FakeEngine());
  expect(saved(hub.dir).pick).toEqual({ model: "sonnet", effort: "high", fast: false });
  fs.mkdirSync(path.join(defaultStore(hub.dir), "view.json.tmp"));
  hub.client.act({ type: "act", act: "say", id: "failed-save", text: "Keep this durable input" });
  expect((await hub.client.wait("answer", 0, (event) => event.id === "failed-save")).ok).toBe(true);
  await hub.client.wait("error");
  hub.client.act({ type: "act", act: "say", id: "after-failure", text: "Must not run" });
  expect((await hub.client.wait("answer", 0, (event) => event.id === "after-failure")).ok).toBe(false);
  expect(hub.engine.epochs[0].messages).toHaveLength(0);
  expect(hub.engine.epochs[0].closed).toBe(true);
  hub.close();
  fs.rmdirSync(path.join(defaultStore(hub.dir), "view.json.tmp"));
  const after = await serve(new FakeEngine(), hub.dir);
  expect(after.engine.epochs[0].view).toContain("Keep this durable input");
  expect(after.client.events.filter((event) => event.type === "entry" && event.entry.kind === "note")).toHaveLength(1);
});

test("a failed send after a batch fails the new epoch and ends the wait", async () => {
  const hub = await waitingBatch();
  const open = hub.engine.open.bind(hub.engine);
  hub.engine.open = (view, options) => {
    const epoch = open(view, options);
    epoch.send = () => { throw new Error("New epoch send failed"); };
    return epoch;
  };
  const mark = hub.client.events.length;
  hub.held.resolve("s".repeat(400));
  expect((await hub.client.wait("error", mark, () => true, 10000)).reason).toBe("New epoch send failed");
  expect((await hub.client.wait("state", mark, (event) => !event.state.busy)).state.wait).toBe("");
  expect(hub.engine.epochs).toHaveLength(2);
  expect(hub.engine.epochs[1].closed).toBe(true);
});
