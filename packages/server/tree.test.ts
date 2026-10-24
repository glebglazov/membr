import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Part } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";

type SavedNode = Part & { text: string; size: number };
const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class Compactor extends FakeEngine {
  readonly prompts: string[] = [];
  active = 0;
  peak = 0;
  constructor(private readonly run: (prompt: string, call: number) => Promise<string | null> = async () => "unii: summary") {
    super((epoch) => epoch.emit(END));
  }
  override async compact(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    this.peak = Math.max(this.peak, ++this.active);
    try { return await this.run(prompt, this.prompts.length); } finally { this.active--; }
  }
}

async function serve(engine = new Compactor(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-tree-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return { ...hub, client, engine, dir };
}

function nodes(dir: string): SavedNode[] {
  return fs.readdirSync(path.join(dir, "tree")).sort().flatMap((file) => fs.readFileSync(path.join(dir, "tree", file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Tree did not reach the expected state");
    await Bun.sleep(5);
  }
}

function nodeCount(count: number): number {
  let total = 0;
  for (; count > 0; count = Math.floor(count / 2)) total += count;
  return total;
}

async function say(hub: Awaited<ReturnType<typeof serve>>, id: string, text: string, images?: string[]) {
  const mark = hub.client.events.length;
  hub.client.act({ type: "act", act: "say", id, text, ...(images ? { images } : {}) });
  const answer = await hub.client.wait("answer", mark, (event) => event.id === id);
  expect(answer.ok).toBe(true);
  await hub.client.wait("state", mark, (event) => !event.state.busy);
}

async function settled(hub: Awaited<ReturnType<typeof serve>>, count: number) {
  await until(() => nodes(hub.dir).length === nodeCount(count));
}

async function coverage(hub: Awaited<ReturnType<typeof serve>>, expected: string[]) {
  const id = crypto.randomUUID();
  hub.client.read({ type: "read", read: "roots", id });
  const roots = (await hub.client.wait("read", 0, (event) => event.id === id)).parts;
  const texts: string[] = [];
  const indexes: number[] = [];
  const pending = [...roots];
  while (pending.length) {
    const part = pending.shift()!;
    const zoom = crypto.randomUUID();
    hub.client.read({ type: "read", read: "zoom", id: zoom, part });
    const result = await hub.client.wait("read", 0, (event) => event.id === zoom);
    pending.unshift(...result.parts);
    const entries = result.entries;
    indexes.push(...entries.map((entry) => entry.i));
    texts.push(...entries.map((entry) => entry.text));
  }
  expect(indexes).toEqual(expected.map((_, i) => i));
  expect(texts).toEqual(expected);
  const saved = nodes(hub.dir);
  for (const part of roots) expect(saved.some((node) => node.l === part.l && node.i === part.i)).toBe(true);
  expect(new Set(saved.map((node) => `${node.l}/${node.i}`)).size).toBe(saved.length);
  for (const node of saved) {
    expect(node.size).toBe(Buffer.byteLength(node.text));
    expect(node.size).toBeLessThanOrEqual(512);
    expect(Buffer.from(node.text).toString("utf8")).toBe(node.text);
    if (node.l > 0) {
      for (const i of [node.i * 2, node.i * 2 + 1]) expect(saved.some((child) => child.l === node.l - 1 && child.i === i)).toBe(true);
    }
  }
}

test("generated message sequences keep every prefix covered with valid 512-byte tree lines", async () => {
  const samples = ["", "plain", "a\nb\n", "é".repeat(260), "🌍".repeat(140), "x".repeat(505), "x".repeat(506), "x".repeat(507), "\ud800", "user: quoted text"];
  for (const seed of [1, 17, 193, 2026]) {
    const hub = await serve();
    const expected: string[] = [];
    let state = seed;
    for (let i = 0; i < 24; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const text = samples[state % samples.length] + (i % 3 === 0 ? ` item ${i}` : "");
      await say(hub, `generated-${i}`, text);
      expected.push(text);
      await settled(hub, expected.length);
      await coverage(hub, expected);
    }
    expect(hub.engine.peak).toBeLessThanOrEqual(4);
    hub.close();
  }
}, 20000);

test("short sources need no call and LEAF and MERGE requests match UniiChat", async () => {
  const hub = await serve(new Compactor(async () => "s".repeat(300)));
  await say(hub, "fits", "x".repeat(506));
  await settled(hub, 1);
  expect(nodes(hub.dir)[0].text).toBe("user: " + "x".repeat(506));
  expect(hub.engine.prompts).toHaveLength(0);
  const image = "a".repeat(64) + ".png";
  await say(hub, "long", "🌍".repeat(150), [image]);
  await settled(hub, 2);
  const ruler = "-".repeat(512);
  expect(hub.engine.prompts[0]).toBe(`<chat>\n0+1|user: ${"x".repeat(506)}\n</chat>\nCompaction: compress message 1 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n<input>\nuser: ${"🌍".repeat(150)}\n[image docs/images/${image}]\n</input>`);
  expect(hub.engine.prompts[1]).toContain(`Compaction: merge lines 0+1 and 1+1, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}\n<chat> may hold their messages, 0 to 1, in more detail: take details\nof them from there too.\n<input>\nuser: ${"x".repeat(506)}\n${"s".repeat(300)}\n</input>`);
});

test("the queue starts four jobs in message order and gives an earlier ready merge priority", async () => {
  const first = Promise.withResolvers<string>();
  const rest = Promise.withResolvers<string>();
  const engine = new Compactor(async (prompt) => /compress message [01] /.test(prompt) ? first.promise : rest.promise);
  const hub = await serve(engine);
  for (let i = 0; i < 10; i++) await say(hub, `held-${i}`, `${i} ` + "x".repeat(600));
  await until(() => engine.prompts.length === 4);
  expect(engine.active).toBe(4);
  expect(engine.prompts.map((prompt) => /compress message (\d+)/.exec(prompt)?.[1])).toEqual(["0", "1", "2", "3"]);
  first.resolve("x".repeat(300));
  await until(() => engine.prompts.length >= 5);
  expect(engine.prompts[4]).toContain("merge lines 0+1 and 1+1");
  rest.resolve("x".repeat(300));
  await settled(hub, 10);
  expect(engine.peak).toBe(4);
  const starts = engine.prompts.map((prompt) => /Compaction: (compress message (\d+)|merge lines (\d+)\+(\d+))/.exec(prompt));
  expect(starts.every(Boolean)).toBe(true);
  const merge = engine.prompts.findIndex((prompt) => prompt.includes("merge lines 0+1 and 1+1"));
  const leaf7 = engine.prompts.findIndex((prompt) => prompt.includes("compress message 7 "));
  expect(merge).toBeLessThan(leaf7);
});

test("outages delay a node without losing it and refusal cuts the UTF-8 source", async () => {
  let fail = true;
  const engine = new Compactor(async () => { if (fail) throw new Error("Fake outage"); return null; });
  const hub = await serve(engine);
  const text = "a".repeat(505) + "🌍".repeat(20);
  await say(hub, "outage", text);
  await until(() => engine.prompts.length === 1);
  expect(nodes(hub.dir)).toEqual([]);
  fail = false;
  await settled(hub, 1);
  expect(engine.prompts).toHaveLength(2);
  expect(engine.prompts[1]).toBe(engine.prompts[0]);
  expect(nodes(hub.dir)[0].text).toBe("user: " + "a".repeat(505));
  await coverage(hub, [text]);
}, 5000);

test("five oversized answers keep the shortest and retries include only the latest size note", async () => {
  const outputs = ["a".repeat(800), "b".repeat(700), "é".repeat(300), "d".repeat(650), "e".repeat(900)];
  const hub = await serve(new Compactor(async (_, call) => outputs[call - 1]));
  await say(hub, "oversized", "source ".repeat(150));
  await settled(hub, 1);
  expect(hub.engine.prompts).toHaveLength(5);
  expect(nodes(hub.dir)[0].text).toBe("é".repeat(256));
  for (let i = 1; i < 5; i++) {
    const prompt = hub.engine.prompts[i];
    expect(prompt.startsWith(hub.engine.prompts[0])).toBe(true);
    expect(prompt.match(/Too long:/g)).toHaveLength(1);
    expect(prompt).toContain(`was ${Buffer.byteLength(outputs[i - 1])} bytes`);
  }
});

test("a refusal after an oversized answer uses the source instead of the earlier answer", async () => {
  const hub = await serve(new Compactor(async (_, call) => call === 1 ? "answer ".repeat(100) : null));
  const source = "source ".repeat(150);
  await say(hub, "refused-retry", source);
  await settled(hub, 1);
  expect(hub.engine.prompts).toHaveLength(2);
  expect(nodes(hub.dir)[0].text).toBe(("user: " + source).slice(0, 512));
});

test("restart rebuilds the index, resumes missing nodes and ignores an old call after close", async () => {
  const pending = Promise.withResolvers<string>();
  const before = await serve(new Compactor(async () => pending.promise));
  await say(before, "saved", "short");
  await settled(before, 1);
  await say(before, "pending", "keep ".repeat(150));
  await until(() => before.engine.active === 1);
  before.close();
  const saved = nodes(before.dir);
  const file = path.join(before.dir, "tree", fs.readdirSync(path.join(before.dir, "tree"))[0]);
  fs.appendFileSync(file, '{"l":0,"i":1');
  fs.rmSync(path.join(before.dir, "tree.index"));
  const after = await serve(new Compactor(), before.dir);
  await settled(after, 2);
  expect(nodes(after.dir).find((node) => node.l === 0 && node.i === 0)).toEqual(saved[0]);
  expect(after.engine.prompts).toHaveLength(1);
  expect(after.engine.prompts[0]).toContain("compress message 1 ");
  const bytes = fs.readFileSync(file);
  pending.resolve("This old result must not be saved");
  await until(() => before.engine.active === 0);
  expect(fs.readFileSync(file)).toEqual(bytes);
  await coverage(after, ["short", "keep ".repeat(150)]);
  const index = fs.readFileSync(path.join(after.dir, "tree.index"));
  for (const node of nodes(after.dir)) {
    const slot = ((2 * node.i + 1) * 2 ** node.l - 1) * 16;
    const day = index.readUInt32LE(slot + 8);
    const at = index.readDoubleLE(slot);
    const length = index.readUInt32LE(slot + 12);
    const data = fs.readFileSync(path.join(after.dir, "tree", new Date(day * 86400000).toISOString().slice(0, 10) + ".jsonl"));
    expect(JSON.parse(data.subarray(at, at + length).toString("utf8"))).toEqual(node);
  }
  after.close();
  const again = await serve(new Compactor(), before.dir);
  await settled(again, 2);
  expect(again.engine.prompts).toHaveLength(0);
  expect(nodes(again.dir)).toEqual(nodes(after.dir));
});

test("restart adds a leaf for the recovery note and close cancels outage retries", async () => {
  const engine = new FakeEngine();
  let calls = 0;
  engine.compact = async () => { calls++; throw new Error("Offline"); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-tree-"));
  dirs.push(dir);
  const before = serveHub({ dir, port: 0, engine });
  hubs.push(before);
  const client = await TestClient.connect(before.server.url.href.replace("http:", "ws:") + "ws", { token: before.token });
  clients.push(client);
  await client.wait("ready");
  client.act({ type: "act", act: "say", id: "interrupted", text: "long ".repeat(150) });
  await client.wait("answer");
  await until(() => calls === 1);
  before.close();
  const after = await serve(new Compactor(), dir);
  await settled(after, 2);
  expect(nodes(dir).some((node) => node.l === 0 && node.i === 1 && node.text === "note: The server restarted before the turn ended.")).toBe(true);
  await Bun.sleep(1100);
  expect(calls).toBe(1);
});
