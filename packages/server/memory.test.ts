import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";
import { seedMemory } from "./test/memory.ts";
import type { Part } from "@membr/protocol";
import type { ToolAnswer } from "./src/memory.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  hubs.splice(0).forEach((hub) => hub.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-memory-"));
  dirs.push(dir);
  return dir;
}
async function start(dir: string, engine: FakeEngine) {
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  const memory = engine.epochs[0].options.memory;
  if (!memory) throw new Error("The Engine did not receive memory tools");
  return { hub, client, memory };
}
function parts(answer: ToolAnswer): Part[] {
  expect(answer.error).toBe(false);
  return answer.text.split("\n").map((line) => {
    const match = /^(\d+)\+(\d+)\|/.exec(line);
    if (!match) throw new Error("The tool did not return a summary line");
    const n = Number(match[2]);
    return { l: Math.log2(n), i: Number(match[1]) / n };
  });
}

test("a fake Engine opens message 3 through the same memory parts as a client in a 500-message chat", async () => {
  const dir = directory();
  const entries = await seedMemory(dir);
  const calls: Array<{ id: number; n: number; answer: ToolAnswer }> = [];
  const engine = new FakeEngine((epoch) => {
    const memory = epoch.options.memory;
    if (!memory) throw new Error("Missing memory tools");
    let id = 0, n = 256;
    for (;;) {
      const answer = memory.zoom(id, n);
      calls.push({ id, n, answer });
      if (n === 1) {
        epoch.emit({ kind: "text", text: answer.text }, END);
        break;
      }
      const children = parts(answer);
      const next = children.find((part) => part.i * 2 ** part.l <= 3 && (part.i + 1) * 2 ** part.l > 3);
      if (!next) throw new Error("Message 3 is missing from the children");
      n = 2 ** next.l;
      id = next.i * n;
    }
  });
  const { client, memory } = await start(dir, engine);
  expect(engine.epochs[0].view).not.toContain("ARCHIVE-PHRASE-731");
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "remember", text: "What was the archive phrase in message 3?" });
  const reply = await client.wait("entry", mark, (event) => event.entry.kind === "unii");
  expect(reply.entry.text).toBe("3+0|user: " + entries[3].text);
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(memory.date(3)).toBe(new Date(entries[3].date).toLocaleString("sv-SE"));
  expect(memory.date(-1)).toBe("No message -1.");
  expect(memory.date(9000)).toBe("No message 9000.");
  for (const call of calls) {
    const request = `client-${call.id}-${call.n}`;
    client.read({ type: "read", id: request, read: "zoom", part: { l: Math.log2(call.n), i: call.id / call.n } });
    const opened = await client.wait("read", mark, (event) => event.id === request);
    if (call.n === 1) expect(opened.entries).toEqual([entries[3]]);
    else {
      expect(opened.parts).toEqual(parts(call.answer));
      expect(opened.lines.map((part) => `${part.i * 2 ** part.l}+${2 ** part.l}|${part.text.replace(/\s*\n\s*/g, " ")}`).join("\n")).toBe(call.answer.text);
      expect(opened.entries).toEqual([]);
    }
  }
  client.read({ type: "read", id: "root", read: "root" });
  const roots = await client.wait("read", mark, (event) => event.id === "root");
  client.read({ type: "read", id: "roots", read: "roots" });
  const alias = await client.wait("read", mark, (event) => event.id === "roots");
  expect(alias.parts).toEqual(roots.parts);
  expect(alias.lines).toEqual(roots.lines);
  for (const [id, n] of [[1, 2], [0, 3], [-1, 1], [9000, 1], [Number.MAX_SAFE_INTEGER, 2]]) {
    const answer = memory.zoom(id, n);
    expect(answer.error).toBe(true);
    expect(answer.images).toEqual([]);
    expect(answer.text).toBe(`No line ${id}+${n}: n is a power of 2, id a multiple of n. The tree's roots: ${roots.parts.map((part) => `${part.i * 2 ** part.l}+${2 ** part.l}`).join(", ")}.`);
  }
  client.read({ type: "read", id: "bad", read: "zoom", part: { l: 52, i: Number.MAX_SAFE_INTEGER } });
  const bad = await client.wait("read", mark, (event) => event.id === "bad");
  expect(bad.error).toContain("No line");
  expect(bad.parts).toEqual(roots.parts);
});

test("zoom pages retain all text, keep surrogate pairs, and include images only on the first page", async () => {
  const dir = directory();
  const image = "0123456789abcdef.png";
  fs.mkdirSync(path.join(dir, "docs", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "images", image), "original");
  fs.writeFileSync(path.join(dir, "docs", "images", image + ".jpg"), "fitted");
  const text = "head\n" + "x".repeat(29999) + "🌍" + "tail".repeat(8000);
  const log = new Log(dir);
  log.apply({ type: "act", act: "say", id: "image", text, images: [image] }, 0);
  log.finish(0);
  const { memory, client } = await start(dir, new FakeEngine());
  let at = 0;
  const pages: string[] = [];
  for (;;) {
    const answer = memory.zoom(0, 1, at);
    expect(answer.error).toBe(false);
    const source = answer.text.slice("0+0|user: ".length).replace(`\n[image docs/images/${image}]`, "");
    const more = /\n\[characters \d+-\d+ of \d+; go on with at (\d+)\]$/.exec(source);
    const content = more ? source.slice(0, more.index) : source;
    expect(Buffer.from(content).toString("utf8")).toBe(content);
    pages.push(content);
    if (at === 0) {
      expect(content).toBe("head\n");
      expect(answer.images).toEqual([{ data: Buffer.from("fitted").toString("base64"), mimeType: "image/jpeg" }]);
      expect(answer.text).toContain(`[image docs/images/${image}]`);
    } else {
      expect(answer.images).toEqual([]);
      expect(answer.text).not.toContain("[image");
    }
    if (!more) break;
    at = Number(more[1]);
  }
  expect(pages.join("")).toBe(text);
  expect(pages[1]).toEndWith("x");
  expect(pages[2]).toStartWith("🌍");
  expect(memory.zoom(0, 1, -1).error).toBe(true);
  client.read({ type: "read", read: "zoom", id: "original", part: { l: 0, i: 0 } });
  expect((await client.wait("read")).entries[0]).toMatchObject({ text, images: [image] });
  fs.rmSync(path.join(dir, "docs", "images", image + ".jpg"));
  expect(memory.zoom(0).images).toEqual([{ data: Buffer.from("original").toString("base64"), mimeType: "image/png" }]);
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "bad-image", text: "Invalid image pointer", images: ["../private.txt"] });
  const added = await client.wait("entry", mark, (event) => event.entry.kind === "user");
  expect(() => memory.zoom(added.entry.i)).toThrow("Invalid image name");
});

test("geometric roots and unbuilt summaries remain navigable while compaction waits", async () => {
  const dir = directory();
  const log = new Log(dir);
  for (let i = 0; i < 8; i++) log.append("user", "x".repeat(600));
  class Waiting extends FakeEngine { override compact(): Promise<string | null> { return new Promise(() => {}); } }
  const { memory, client } = await start(dir, new Waiting());
  client.read({ type: "read", read: "root", id: "root" });
  expect((await client.wait("read")).parts).toEqual([{ l: 3, i: 0 }]);
  expect(memory.zoom(0, 8).text).toBe("0+4|(not summarized yet: zoom it)\n4+4|(not summarized yet: zoom it)");
  expect(memory.zoom(3).text).toBe("3+0|user: " + "x".repeat(600));
  expect(memory.zoom("bad").error).toBe(true);
});
