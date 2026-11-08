import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatStatus } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";

const hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [], dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

async function serve(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-status-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const engine = new FakeEngine();
  const hub = serveHub({ dir, port: 0, engine }); hubs.push(hub);
  return { engine, hub, dir, client: await connect(hub) };
}

async function connect(hub: ReturnType<typeof serveHub>) {
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token }); clients.push(client);
  await client.wait("ready");
  return client;
}

const statuses = (client: TestClient): Array<ChatStatus | null | undefined> => client.events.flatMap((event) => event.type === "state" ? [event.state.status] : []);
const reached = (client: TestClient, from: number, status: ChatStatus | null) => client.wait("state", from, (event) => event.state.status === status);

test("a turn is working, then done", async () => {
  const { client, engine } = await serve();
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "a", text: "Work" });
  await reached(client, mark, "working");
  engine.epochs[0]!.emit({ ...END, reply: "Done" });
  await reached(client, mark, "done");
  expect(statuses(client).slice(-1)).toEqual(["done"]);
});

test("an engine turn that ends with an error is failed", async () => {
  const { client, engine } = await serve();
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "a", text: "Work" });
  await reached(client, mark, "working");
  engine.epochs[0]!.emit({ ...END, error: "boom" });
  await reached(client, mark, "failed");
});

test("an approval blocks the chat until it is answered, then the turn works again", async () => {
  const { client, engine } = await serve();
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "a", text: "Work" });
  await reached(client, mark, "working");
  const decision = engine.epochs[0]!.options.ask!("Bash", { command: "ls" });
  const ask = await client.wait("ask", mark);
  await reached(client, mark, "blocked");
  const answered = client.events.length;
  client.act({ type: "act", act: "answer", id: "yes", approval: ask.id, choice: "once" });
  expect(await decision).toBe(true);
  await reached(client, answered, "working");
  expect(statuses(client).slice(-1)).toEqual(["working"]);
});

test("a stopped turn is done, because the user ended it", async () => {
  const { client } = await serve();
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "a", text: "Work" });
  await reached(client, mark, "working");
  client.act({ type: "act", act: "stop", id: "s", subagent: null });
  await reached(client, mark, "done");
});

test("a client that connects after the turn gets the status in its first state event", async () => {
  const { client, engine, hub } = await serve();
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "a", text: "Work" });
  await reached(client, mark, "working");
  engine.epochs[0]!.emit({ ...END, reply: "Done" });
  await reached(client, mark, "done");
  const late = await connect(hub);
  expect((await late.wait("state")).state.status).toBe("done");
});

test("a chat with no turn since the server started has no status", async () => {
  const { client } = await serve();
  expect((await client.wait("state")).state.status).toBeNull();
});

test("a turn cut short by a server restart is failed on the next start", async () => {
  const first = await serve();
  const mark = first.client.events.length;
  first.client.act({ type: "act", act: "say", id: "a", text: "Work" });
  await reached(first.client, mark, "working");
  first.client.close();
  await hubs.pop()!.close();
  const second = await serve(first.dir);
  expect((await second.client.wait("state")).state.status).toBe("failed");
});
