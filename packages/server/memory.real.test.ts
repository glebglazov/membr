import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { seedMemory } from "./test/memory.ts";

test.skipIf(process.env.MEMBR_REAL_SDK !== "1")("S1 real Engine uses zoom to answer from an old message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-real-memory-"));
  const secret = "ARCHIVE-" + crypto.randomUUID();
  await seedMemory(dir, 500, secret);
  expect(fs.readFileSync(path.join(dir, "view.json"), "utf8")).not.toContain(secret);
  const hub = serveHub({ dir, port: 0, epoch: { cwd: dir, pick: { model: "sonnet", effort: "low", fast: false } } });
  let client: TestClient | undefined;
  try {
    client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
    await client.wait("ready");
    const mark = client.events.length;
    client.act({ type: "act", act: "say", id: "old-memory", text: "What archive phrase did I record in message 3? Open the memory with zoom before answering. Reply with the exact phrase. Use only the memory tools." });
    expect((await client.wait("answer", mark)).ok).toBe(true);
    await client.wait("entry", mark, (event) => event.entry.kind === "tool" && JSON.parse(event.entry.text).name === "mcp__memory__zoom", 180000);
    const reply = await client.wait("entry", mark, (event) => event.entry.kind === "unii" && event.entry.text.includes(secret), 180000);
    await client.wait("state", mark, (event) => !event.state.busy, 180000);
    const calls = client.events.slice(mark).flatMap((event) => event.type === "entry" && event.entry.kind === "tool" ? [JSON.parse(event.entry.text)] : []);
    const zooms = new Set(calls.filter((call) => call.name === "mcp__memory__zoom").map((call) => call.id));
    const result = client.events.slice(mark).find((event) => {
      if (event.type !== "entry" || event.entry.kind !== "echo") return false;
      const answer = JSON.parse(event.entry.text);
      return zooms.has(answer.id) && answer.error === false && answer.text.includes(secret);
    });
    if (!result || result.type !== "entry") throw new Error("The zoom result was not logged");
    expect(JSON.parse(result.entry.text)).toMatchObject({ error: false, text: expect.stringContaining(secret) });
    const tools = calls.map((call) => call.name);
    expect(tools.every((name) => name === "mcp__memory__zoom" || name === "mcp__memory__date")).toBe(true);
    expect(client.events.filter((event) => event.type === "error")).toEqual([]);
    console.log(JSON.stringify({ zoom: calls.find((call) => call.id === JSON.parse(result.entry.text).id), result: JSON.parse(result.entry.text), tools, reply: reply.entry.text, dataDirectory: dir }));
  } finally {
    client?.close();
    hub.close();
  }
}, 240000);
