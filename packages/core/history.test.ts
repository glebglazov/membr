import { expect, test } from "bun:test";
import { act, createModel, earlier, hear, rows } from "./src/index.ts";
import type { Entry, Event } from "@membr/protocol";

const entry = (i: number): Entry => ({ i, kind: "unii", text: `message ${i}`, date: "2026-10-24T12:00:00.000Z", from: { machine: "server", seq: i } });
const span = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => entry(from + k));
const texts = (model: Parameters<typeof rows>[0]) => rows(model).flatMap((row) => row.kind === "message" ? [row.entry.i] : []);
// the view has a line for each of the first 10 entries
const parts = span(0, 10).map(({ i }) => ({ l: 0, i }));
function joined(history: Event) {
  let model = hear(createModel(), { type: "ready", version: "1.0" });
  model = hear(model, history);
  return hear(model, { type: "view", parts, lines: parts.map(({ i }) => ({ l: 0, i, text: `unii: message ${i}` })) });
}

test("history shows only the page it carries, then the entries after the view", () => {
  const model = joined({ type: "history", from: 6, entries: [...span(6, 10), ...span(10, 13)] });
  expect(model.from).toBe(6);
  expect(texts(model)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  expect(earlier(model)).toBe("idle");
});

test("an older page request goes out once, and its reply adds the entries and moves from", () => {
  const model = joined({ type: "history", from: 6, entries: span(6, 10) });
  const first = act(model, { type: "older", id: "older-1" });
  expect(first.reads).toEqual([{ type: "read", read: "page", id: "older-1", before: 6 }]);
  expect(earlier(first.model)).toBe("loading");
  const second = act(first.model, { type: "older", id: "older-2" });
  expect(second.reads).toEqual([]);
  const loaded = hear(second.model, { type: "read", id: "older-1", entries: span(2, 6), parts: [], lines: [], from: 2 });
  expect(loaded.from).toBe(2);
  expect(texts(loaded)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  const last = hear(act(loaded, { type: "older", id: "older-3" }).model, { type: "read", id: "older-3", entries: span(0, 2), parts: [], lines: [], from: 0 });
  expect(texts(last)).toEqual(span(0, 10).map(({ i }) => i));
  expect(earlier(last)).toBe("none");
  expect(act(last, { type: "older", id: "older-4" }).reads).toEqual([]);
});

test("a reconnect keeps the older pages that are loaded, and drops them when the log moved on past a gap", () => {
  let model = joined({ type: "history", from: 6, entries: span(6, 10) });
  model = hear(act(model, { type: "older", id: "o" }).model, { type: "read", id: "o", entries: span(2, 6), parts: [], lines: [], from: 2 });
  const again = hear(model, { type: "history", from: 7, entries: [...span(7, 10), entry(10)] });
  expect(again.from).toBe(2);
  expect([...again.entries.keys()].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const gap = hear(model, { type: "history", from: 40, entries: span(40, 45) });
  expect(gap.from).toBe(40);
  expect([...gap.entries.keys()]).toEqual([40, 41, 42, 43, 44]);
});
