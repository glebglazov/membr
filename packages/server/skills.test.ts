import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";

const dirs: string[] = [], hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const echo: Skill = { name: "probe-echo", description: "Echo the arguments", argumentHint: "<text>" };
const review: Skill = { name: "review", description: "Review a change", argumentHint: "" };

async function serve(engine: FakeEngine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-skills-")); dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine }); hubs.push(hub);
  // the Engine lists skills once its first epoch starts, so wait for that before any client says hello
  await Bun.sleep(50);
  return { hub, dir, connect: async () => {
    const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token }); clients.push(client);
    await client.wait("ready"); return client;
  } };
}

test("a client gets the skills before ready, and a changed list reaches every client", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.skills = [echo];
  const server = await serve(engine);
  const first = await server.connect(), second = await server.connect();
  for (const client of [first, second]) {
    expect(client.events.findIndex((event) => event.type === "skills")).toBeGreaterThan(-1);
    expect(client.events.findIndex((event) => event.type === "skills")).toBeLessThan(client.events.findIndex((event) => event.type === "ready"));
    expect(await client.wait("skills")).toEqual({ type: "skills", skills: [echo] });
  }
  const marks = [first.events.length, second.events.length];
  engine.epochs[0].emit({ kind: "skills", skills: [echo] });
  engine.epochs[0].emit({ kind: "skills", skills: [echo, review] });
  expect((await first.wait("skills", marks[0])).skills).toEqual([echo, review]);
  expect((await second.wait("skills", marks[1])).skills).toEqual([echo, review]);
  expect(first.events.slice(marks[0]).filter((event) => event.type === "skills")).toHaveLength(1);
  const late = await server.connect();
  expect((await late.wait("skills")).skills).toEqual([echo, review]);
});

test("a skill message reaches the Engine as typed, and the pending import note goes with the next message", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  engine.skills = [echo];
  const server = await serve(engine);
  const client = await server.connect();
  const folder = path.join(server.dir, "projects"); fs.mkdirSync(folder);
  const at = "2026-10-01T12:00:00.000Z";
  fs.writeFileSync(path.join(folder, "s.jsonl"), [0, 1].map((i) => JSON.stringify({ type: i ? "assistant" : "user", uuid: `m${i}`, sessionId: "s", timestamp: at, message: { content: [{ type: "text", text: `Old ${i}` }] } })).join("\n") + "\n");
  client.act({ type: "act", act: "import", id: "import", source: "claude-code", path: folder });
  await client.wait("imports", 0, (event) => event.imports.some((run) => run.phase === "complete"), 5000);

  client.act({ type: "act", act: "say", id: "skill", text: "/probe-echo banana" });
  await client.wait("answer", 0, (event) => event.id === "skill");
  await client.wait("state", 0, (event) => !event.state.busy && engine.epochs[0].messages.length === 1);
  expect(engine.epochs[0].messages.map((message) => message.text)).toEqual(["/probe-echo banana"]);

  client.act({ type: "act", act: "say", id: "plain", text: "Thanks" });
  await client.wait("answer", 0, (event) => event.id === "plain");
  expect(engine.epochs[0].messages).toHaveLength(2);
  expect(engine.epochs[0].messages[1].text).toStartWith("Thanks\n\nMemory update from membr: imported messages ");
});
