import { expect, test } from "bun:test";
import { act, createModel, hear, rows } from "./src/index.ts";
import { parseEvent, type Entry, type MemoryLine, type Part, type Read } from "@membr/protocol";

const root = { l: 2, i: 0 };
const halves = [{ l: 1, i: 0, text: "First half" }, { l: 1, i: 1, text: "Second half" }];
const leaves = [{ l: 0, i: 0, text: "A summary of the first message" }, { l: 0, i: 1, text: "A second message" }];
const original: Entry = { i: 0, kind: "user", text: "The original message, word for word.", date: "2026-10-24T12:00:00Z", from: { machine: "server", seq: 0 } };
function reply(id: string, lines: MemoryLine[], entries: Entry[] = []) {
  return parseEvent({ type: "read", id, lines, entries, parts: lines.map(({ l, i }) => ({ l, i })) });
}
function ready() {
  return hear(hear(createModel(), { type: "ready", version: "1.0" }), { type: "view", parts: [root], lines: [{ ...root, text: "Four messages" }] });
}
function rootsRead(reads: Read[]): Read { const request = reads.find((request) => request.read === "roots"); if (!request) throw new Error("Expected roots read"); return request; }

test("S2 opens a summary into two halves and then the original message, and closes it", () => {
  let model = hear(ready(), { type: "entry", entry: original });
  expect(rows(model)).toEqual([{ kind: "summary", part: root, text: "Four messages" }]);
  let result = act(model, { type: "open", id: "open-root", part: root });
  expect(result.reads).toEqual([{ type: "read", read: "zoom", id: "open-root", part: root }]);
  expect(result.acts).toEqual([]);
  model = hear(result.model, reply("open-root", halves));
  expect(rows(model)).toEqual([{ kind: "open", part: root, loading: false, rows: halves.map(({ text, ...part }) => ({ kind: "summary", part, text })) }]);
  result = act(model, { type: "open", id: "open-half", part: halves[0] });
  model = hear(result.model, reply("open-half", leaves));
  result = act(model, { type: "open", id: "open-leaf", part: leaves[0] });
  expect(result.reads).toEqual([{ type: "read", read: "zoom", id: "open-leaf", part: leaves[0] }]);
  model = hear(result.model, reply("open-leaf", [], [original]));
  const text = JSON.stringify(rows(model));
  expect(text).toContain(original.text);
  expect(text.match(/word for word/g)).toHaveLength(1);
  model = act(model, { type: "close", part: root }).model;
  expect(rows(model)).toEqual([{ kind: "summary", part: root, text: "Four messages" }]);
});

test("S2 fold uses the roots and the second /fold restores the current view", () => {
  const part = { l: 0, i: 4 };
  let model = hear(ready(), { type: "view", parts: [root, part], lines: [{ ...part, text: "user: New message" }] });
  const result = act(model, { type: "send", id: "local-command", text: " /fold " });
  expect(result.acts).toEqual([]);
  const request = rootsRead(result.reads);
  model = hear(result.model, reply(request.id, [{ ...root, text: "Four messages" }, { ...part, text: "Last message" }]));
  expect(rows(model)).toHaveLength(2);
  expect(model.pending.size).toBe(0);
  expect(model.folded).toBe(true);
  model = act(model, { type: "send", id: "unfold", text: "/fold" }).model;
  expect(model.folded).toBe(false);
  expect(rows(model).map((row) => row.kind)).toEqual(["summary", "summary"]);
  expect(model.parts).toEqual([root, part]);
});

test("S2 tree roots refresh with the view and stale reads cannot restore a closed block or page", () => {
  let result = act(ready(), { type: "page", page: "tree" });
  const old = rootsRead(result.reads);
  let model = hear(result.model, { type: "view", parts: [root], lines: [{ ...root, text: "Four messages" }] });
  const current = rootsRead(act(model, { type: "reads" }).reads);
  model = hear(model, reply(old.id, [{ l: 0, i: 0, text: "Stale root" }]));
  expect(model.roots).toBeNull();
  model = hear(model, reply(current.id, [{ ...root, text: "Four messages" }]));
  expect(rows(model)).toEqual([{ kind: "summary", part: root, text: "Four messages" }]);
  result = act(model, { type: "open", id: "slow-open", part: root });
  model = act(result.model, { type: "close", part: root }).model;
  model = hear(model, reply("slow-open", halves));
  expect(rows(model)[0]?.kind).toBe("summary");
  result = act(model, { type: "page", page: "tree" });
  model = act(result.model, { type: "page", page: "chat" }).model;
  model = hear(model, reply(rootsRead(result.reads).id, halves));
  expect(model.page).toBe("chat");
  expect(model.reads.size).toBe(0);
});

test("S2 pending memory reads resend on reconnect and a read error permits retry", () => {
  let result = act(ready(), { type: "open", id: "lost-read", part: root });
  let model = hear(result.model, { type: "offline" });
  expect(act(model, { type: "flush" }).reads).toEqual([]);
  model = hear(model, { type: "ready", version: "1.0" });
  expect(act(model, { type: "flush" }).reads).toEqual(result.reads);
  model = hear(model, { type: "read", id: "lost-read", entries: [], parts: [], lines: [], error: "No line" });
  expect(model.error).toBe("No line");
  expect(rows(model)[0]?.kind).toBe("summary");
  result = act(model, { type: "open", id: "retry", part: root });
  expect(result.reads).toHaveLength(1);
  model = hear(result.model, { type: "error", id: "retry", reason: "Read failed" });
  expect(model.reads.size).toBe(0);
  expect(rows(model)[0]?.kind).toBe("summary");
});

test("S2 current view hides archived entries, keeps single messages whole and includes new tail once", () => {
  const leaf: Part = { l: 0, i: 4 };
  let model = hear(ready(), { type: "entry", entry: original });
  model = hear(model, { type: "entry", entry: { ...original, i: 4, text: "Long original ".repeat(100) } });
  model = hear(model, { type: "view", parts: [root, leaf], turn: 5, lines: [{ ...root, text: "Old chat" }, { ...leaf, text: "A summary of the long message" }] });
  model = hear(model, { type: "entry", entry: { ...original, i: 5, kind: "unii", text: "A live tail" } });
  expect(rows(model)).toEqual([
    { kind: "summary", part: root, text: "Old chat" },
    { kind: "message", entry: { ...original, i: 4, text: "Long original ".repeat(100) } },
    { kind: "message", entry: { ...original, i: 5, kind: "unii", text: "A live tail" } },
  ]);
});

test("S2 current-turn long messages remain whole after a view update and reconnect", () => {
  const leaf = { l: 0, i: 4 };
  const answer: Entry = { ...original, i: 4, kind: "unii", text: "The full final answer. ".repeat(80) };
  const view = parseEvent({ type: "view", parts: [root, leaf], turn: 4, lines: [{ ...root, text: "Old chat" }, { ...leaf, text: "(not summarized yet: zoom it)" }] });
  let model = hear(ready(), { type: "entry", entry: answer });
  model = hear(model, view);
  expect(rows(model)).toEqual([{ kind: "summary", part: root, text: "Old chat" }, { kind: "message", entry: answer }]);
  model = hear(hear(model, { type: "offline" }), { type: "connecting" });
  model = hear(hear(model, { type: "entry", entry: answer }), view);
  model = hear(model, { type: "ready", version: "1.0" });
  expect(rows(model)[1]).toEqual({ kind: "message", entry: answer });
  let other = hear(createModel(), { type: "entry", entry: answer });
  other = hear(other, view);
  expect(rows(other)).toEqual(rows(model));
  model = hear(model, parseEvent({ ...view, turn: 5 }));
  expect(rows(model)[1]).toEqual({ kind: "message", entry: answer });
  const folded = act(model, { type: "fold" });
  model = hear(folded.model, reply(rootsRead(folded.reads).id, [{ ...leaf, text: "An answer summary" }]));
  expect(rows(model)).toEqual([{ kind: "summary", part: leaf, text: "An answer summary" }]);
});

test("S2 a normal message unfolds the chat and drops obsolete reads", () => {
  const folded = act(ready(), { type: "fold" });
  const result = act(folded.model, { type: "send", id: "say-after-fold", text: "Continue the conversation" });
  expect(result.acts).toEqual([{ type: "act", act: "say", id: "say-after-fold", text: "Continue the conversation" }]);
  expect(result.model.folded).toBe(false);
  expect(result.model.reads.size).toBe(0);
  const afterStaleRoots = hear(result.model, reply(rootsRead(folded.reads).id, halves));
  expect(rows(afterStaleRoots)).toEqual([{ kind: "summary", part: root, text: "Four messages" }]);
});
