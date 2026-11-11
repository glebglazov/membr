import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineEvent } from "./src/engine.ts";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";

type Context = Extract<EngineEvent, { kind: "end" }>["context"];

const hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [], dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

// the first message ends with `first`, every later one ends normally
async function serve(first: Partial<Extract<EngineEvent, { kind: "end" }>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-context-"));
  dirs.push(dir);
  let ended = 0;
  const engine = new FakeEngine((epoch) => epoch.emit({ ...END, ...(ended++ === 0 ? first : {}) }));
  const hub = serveHub({ dir, port: 0, engine }); hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token }); clients.push(client);
  await client.wait("ready");
  return { client, engine };
}

async function say(client: TestClient, id: string, text: string) {
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id, text });
  await client.wait("state", mark, (event) => event.state.busy);
  await client.wait("state", mark, (event) => !event.state.busy);
}

const texts = (client: TestClient): string[] => client.events.flatMap((event) => event.type === "entry" ? [event.entry.text] : []);

test("a turn that overflows the epoch fails, a note asks to send it again, and the next message goes to a new epoch", async () => {
  const { client, engine } = await serve({ error: "Prompt is too long", context: "overflow" });
  await say(client, "big", "Read everything");
  await client.wait("entry", 0, (event) => event.entry.text === "The epoch was full, so membr opened a new one. Send your message again.");
  expect(texts(client)).toEqual(["Read everything", "The turn failed: Prompt is too long", "The epoch was full, so membr opened a new one. Send your message again."]);
  await say(client, "again", "Read less");
  expect(engine.epochs.length).toBe(2);
  expect(engine.epochs[1]!.messages.map((message) => message.text)).toEqual(["Read less"]);
});

const near: Array<{ name: string; context: Context; epochs: number }> = [
  { name: "a turn that ends at 220k tokens of a large window opens a new epoch for the next message", context: { used: 220_000, window: 1_000_000 }, epochs: 2 },
  { name: "a turn that ends below 220k tokens of a large window keeps the epoch", context: { used: 219_999, window: 1_000_000 }, epochs: 1 },
  { name: "a turn that ends at 80% of a small window opens a new epoch for the next message", context: { used: 120_000, window: 150_000 }, epochs: 2 },
  { name: "a turn that ends below 80% of a small window keeps the epoch", context: { used: 119_999, window: 150_000 }, epochs: 1 },
  { name: "a turn with no known context keeps the epoch", context: null, epochs: 1 },
];
for (const row of near) {
  test(row.name, async () => {
    const { client, engine } = await serve({ context: row.context });
    await say(client, "first", "Work");
    await say(client, "second", "More");
    expect(engine.epochs.length).toBe(row.epochs);
    expect(engine.epochs.at(-1)!.messages.map((message) => message.text)).toContain("More");
    expect(texts(client).some((text) => text.startsWith("The epoch was full"))).toBe(false);
  });
}
