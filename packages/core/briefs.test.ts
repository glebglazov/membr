import { expect, test } from "bun:test";
import { brief, createModel, hear, rows, type Brief } from "./src/index.ts";
import type { Entry } from "@membr/protocol";

let next = 0;
const entry = (kind: Entry["kind"], text: string): Entry => ({ i: next++, kind, text, date: "2026-10-25T12:00:00.000Z", from: { machine: "server", seq: next } });
const tool = (id: string, name: string, input: unknown) => entry("tool", JSON.stringify({ id, name, input }));
const echo = (id: string, text: string, error = false) => entry("echo", JSON.stringify({ id, text, error }));
const briefs = (entries: Entry[]): Brief[] => brief(entries).flatMap((item) => item.kind === "brief" ? [item.brief] : []);

test("a run of tool calls folds into one brief that pairs each call with its result", () => {
  next = 0;
  const items = brief([
    entry("user", "Check the tree"),
    tool("a", "Read", { file_path: "/Users/me/membr/packages/server/src/tree.ts" }),
    tool("b", "Bash", { command: "bun test\nmore", description: "Run the tests" }),
    echo("b", "1 fail", true),
    echo("a", "export class Tree"),
    tool("c", "mcp__memory__zoom", { id: 12, n: 4 }),
    entry("unii", "Done."),
  ]);
  expect(items.map((item) => item.kind === "message" ? item.entry.kind : item.brief.kind)).toEqual(["user", "tools", "unii"]);
  const tools = items[1].kind === "brief" && items[1].brief.kind === "tools" ? items[1].brief : null;
  expect(tools?.calls.map(({ tool, what, result }) => [tool, what, result])).toEqual([
    ["Read", "…/server/src/tree.ts", { i: 4, text: "export class Tree", error: false }],
    ["Bash", "Run the tests", { i: 3, text: "1 fail", error: true }],
    ["zoom", "messages from 12, 4 of them", null],
  ]);
});

test("a spawn call is its own brief and names the agents the server started", () => {
  next = 0;
  const found = briefs([
    tool("a", "Grep", { pattern: "spawn", path: "packages/server" }),
    echo("a", "agents.ts:61"),
    tool("s", "mcp__memory__spawn", { tasks: [{ name: "Store Reader", task: "Read log.ts" }, { name: "store-reader", task: "Read view.ts" }] }),
    echo("s", "Started store-reader, store-reader-2. Each one's report will reach you as a message when it finishes."),
    tool("t", "mcp__memory__tell", { name: "store-reader", message: "Look at tree.ts too\nthanks" }),
    echo("t", "Sent."),
  ]);
  expect(found.map((item) => item.kind)).toEqual(["tools", "spawn", "tools"]);
  expect(found[1].kind === "spawn" && found[1].agents).toEqual([{ name: "store-reader", task: "Read log.ts" }, { name: "store-reader-2", task: "Read view.ts" }]);
  expect(found[2].kind === "tools" && found[2].calls[0].what).toBe("store-reader: Look at tree.ts too");
});

test("reports and notes are briefs, and imported calls pair with the next result", () => {
  next = 0;
  const found = briefs([
    entry("work", '[store-reader] report\nThe log is append-only.\n\nIt is the source of truth.\nFull chat: zoom("store-reader")'),
    entry("work", "[Agent1] reply\nOld reply"),
    entry("note", "after: hook failed"),
    entry("tool", 'shell {"command":"ls"}'),
    entry("echo", "README.md"),
  ]);
  expect(found).toEqual([
    { kind: "report", i: 0, agent: "store-reader", text: "The log is append-only.\n\nIt is the source of truth." },
    { kind: "report", i: 1, agent: "Agent1", text: "Old reply" },
    { kind: "note", i: 2, text: "after: hook failed" },
    { kind: "tools", i: 3, calls: [{ i: 3, tool: "shell", what: "ls", input: { command: "ls" }, result: { i: 4, text: "README.md", error: false } }] },
  ]);
});

test("the chat rows fold technical entries and keep the conversation whole", () => {
  next = 0;
  let model = hear(createModel(), { type: "ready", version: "1.0" });
  for (const item of [entry("user", "Go"), tool("a", "Read", { file_path: "a.ts" }), echo("a", "text"), entry("unii", "Read it.")]) model = hear(model, { type: "entry", entry: item });
  expect(rows(model).map((row) => row.kind === "message" ? row.entry.text : row.kind)).toEqual(["Go", "brief", "Read it."]);
});
