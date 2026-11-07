import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { PAGE, page } from "./src/view.ts";
import { TestClient } from "./test/client.ts";
import { FakeEngine } from "./test/engine.ts";
import { defaultStore } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// 200 entries. The view has a summary of 0 to 31, a line for each of 32 to 95, a summary of 96 to 99, and then a line for each entry that follows.
async function join() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-history-"));
  dirs.push(dir);
  const store = defaultStore(dir);
  const log = new Log(store);
  for (let i = 0; i < 200; i++) log.append("unii", `message ${i}`);
  const lines = [{ l: 5, i: 0, text: "summary" }, ...Array.from({ length: 64 }, (_, k) => ({ l: 0, i: 32 + k, text: `unii: message ${32 + k}` })), { l: 2, i: 24, text: "summary" }];
  fs.writeFileSync(path.join(store, "view.json"), JSON.stringify({ lines, pick: null, goal: null }));
  const hub = serveHub({ dir, port: 0, engine: new FakeEngine(() => {}) });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return client;
}

test("a client that joins gets one history event with the latest page, and no entry events", async () => {
  const client = await join();
  const [history, ...more] = client.events.filter((event) => event.type === "history" || event.type === "entry");
  expect(more).toEqual([]);
  if (history?.type !== "history") throw new Error("Expected a history event");
  expect(history.from).toBe(150);
  expect(history.entries.map((entry) => entry.i)).toEqual(Array.from({ length: PAGE }, (_, k) => 150 + k));
});

test("page reads walk back to the start and give each displayable entry once, with no entry under a summary", async () => {
  const client = await join();
  const history = await client.wait("history");
  const seen = history.entries.map((entry) => entry.i);
  const froms = [history.from];
  for (let from = history.from; from > 0; from = froms[froms.length - 1]) {
    const mark = client.events.length;
    client.read({ type: "read", id: `page-${from}`, read: "page", before: from });
    const reply = await client.wait("read", mark, (event) => event.id === `page-${from}`);
    expect(reply.parts).toEqual([]);
    expect(reply.from).toBeLessThan(from);
    seen.unshift(...reply.entries.map((entry) => entry.i));
    froms.push(reply.from!);
  }
  expect(froms).toEqual([150, 96, 46, 0]);
  const expected = [...Array.from({ length: 64 }, (_, k) => 32 + k), ...Array.from({ length: 100 }, (_, k) => 100 + k)];
  expect(seen).toEqual(expected);
});

test("a page read before an index inside a summary shows the whole summary", () => {
  expect(page([{ l: 5, i: 0 }, { l: 0, i: 32 }], 10)).toEqual({ from: 0, indices: [] });
  expect(page([{ l: 0, i: 0 }, { l: 0, i: 1 }, { l: 1, i: 1 }, { l: 0, i: 4 }], 3)).toEqual({ from: 0, indices: [0, 1] });
});
