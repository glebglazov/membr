import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentInfo } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { storeDir, type Config } from "./src/config.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";
import { testConfig } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

// The Engine holds a turn open on "hold" and ends it on any other message.
const engine = () => new FakeEngine((epoch, message) => { if (message.text !== "hold") epoch.emit(END); });

function start(agents: Array<{ name: string; prompt?: string; home?: string }>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "membr-agents-")));
  dirs.push(dir);
  const fake = engine();
  let config: Config = testConfig(dir, agents);
  const hub = serveHub({ dir, port: 0, engine: fake, config: () => config }); hubs.push(hub);
  return { dir, hub, fake, url: hub.server.url, setConfig: (next: Array<{ name: string; prompt?: string; home?: string }>) => { config = testConfig(dir, next); } };
}
async function join(server: ReturnType<typeof start>, agent: string | null) {
  const socket = new URL(agent === null ? "/ws" : `/membr/${agent}/ws`, server.url);
  socket.protocol = "ws:";
  const client = await TestClient.connect(socket.href, { token: server.hub.token }); clients.push(client);
  await client.wait("ready");
  return client;
}
async function say(client: TestClient, text: string) {
  const id = crypto.randomUUID();
  client.act({ type: "act", act: "say", id, text });
  await client.wait("answer", 0, (event) => event.id === id);
}
const listed = async (server: ReturnType<typeof start>): Promise<AgentInfo[]> => (await fetch(new URL("/membr/agents.json", server.url))).json();
const epochIn = (server: ReturnType<typeof start>, home: string) => server.fake.epochs.find((epoch) => epoch.options.cwd === home)!;

test("a message to an agent lands only in its own store, and each agent's Engine has its own home and prompt", async () => {
  const server = start([{ name: "default", prompt: "I am the first." }, { name: "research", prompt: "I find sources.\nCite each one." }]);
  const research = await join(server, "research");
  await say(research, "Find the paper");
  await research.wait("entry", 0, (event) => event.entry.text === "Find the paper");
  const mine = new Log(storeDir(server.dir, "research")).entries.map((entry) => entry.text);
  expect(mine).toContain("Find the paper");
  expect(new Log(storeDir(server.dir, "default")).entries.map((entry) => entry.text)).not.toContain("Find the paper");

  const researchHome = path.join(storeDir(server.dir, "research"), "home"), defaultHome = path.join(storeDir(server.dir, "default"), "home");
  expect(server.fake.epochs.map((epoch) => epoch.options.cwd).sort()).toEqual([defaultHome, researchHome].sort());
  expect(epochIn(server, researchHome).options.append).toEndWith('In membr, you are the agent "research".\n\nI find sources.\nCite each one.');
  expect(epochIn(server, defaultHome).options.append).toEndWith('In membr, you are the agent "default".\n\nI am the first.');
  expect(epochIn(server, researchHome).messages.map((message) => message.text)).toEqual(["Find the paper"]);
  expect(epochIn(server, defaultHome).messages).toEqual([]);
});

test("a path outside /membr/ is the default agent's", async () => {
  const server = start([{ name: "default" }, { name: "research" }]);
  const client = await join(server, null);
  await say(client, "Old client");
  expect(new Log(storeDir(server.dir, "default")).entries.map((entry) => entry.text)).toContain("Old client");
  expect(new Log(storeDir(server.dir, "research")).entries).toEqual([]);
});

test("the list of agents is JSON and a page with a link to each, an unknown agent is 404, and a name without a slash redirects", async () => {
  const server = start([{ name: "default" }, { name: "research", prompt: "\nFinds sources.\nMore." }]);
  const research = await join(server, "research");
  await say(research, "hold");
  await research.wait("state", 0, (event) => event.state.busy);
  expect(await listed(server)).toEqual([{ name: "default", busy: false, about: "" }, { name: "research", busy: true, about: "Finds sources." }]);

  const page = await fetch(new URL("/membr/", server.url));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain('href="./research/"');
  expect(html).toContain('href="./default/"');
  expect(html).toContain("Finds sources.");

  expect((await fetch(new URL("/membr/nope/ws", server.url))).status).toBe(404);
  expect((await fetch(new URL("/membr/nope/", server.url))).status).toBe(404);
  const redirect = await fetch(new URL("/membr/research", server.url), { redirect: "manual" });
  expect(redirect.status).toBe(301);
  expect(redirect.headers.get("location")).toBe("/membr/research/");
  expect((await fetch(new URL("/membr/research/", server.url))).status).toBe(200);
});

test("a page with a token sets the cookie and redirects to the same path without it", async () => {
  const server = start([{ name: "default" }, { name: "research" }]);
  for (const route of ["/membr/", "/membr/research/"]) {
    const response = await fetch(new URL(`${route}?token=${server.hub.token}`, server.url), { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(route);
    expect(response.headers.get("set-cookie")).toContain(`token=${server.hub.token}`);
  }
});

test("every client learns each agent's busy state before ready and when it changes in another agent", async () => {
  const server = start([{ name: "default" }, { name: "research" }]);
  const first = await join(server, null);
  const replay = first.events.map((event) => event.type);
  expect(replay.at(-1)).toBe("ready");
  expect(replay.at(-2)).toBe("agents");
  expect(first.events.find((event) => event.type === "agents")).toMatchObject({ agents: [{ name: "default", busy: false }, { name: "research", busy: false }] });

  const mark = first.events.length;
  await say(await join(server, "research"), "hold");
  const busy = await first.wait("agents", mark, (event) => event.agents.some((agent) => agent.name === "research" && agent.busy));
  expect(busy.agents.find((agent) => agent.name === "default")?.busy).toBe(false);
});

test("a reload opens a room for a new agent and closes the room of a removed one with 1001", async () => {
  const server = start([{ name: "default" }, { name: "research" }]);
  const main = await join(server, null);
  const research = await join(server, "research");
  await say(research, "Keep this");
  expect((await fetch(new URL("/membr/notes/", server.url))).status).toBe(404);

  server.setConfig([{ name: "default" }, { name: "notes", prompt: "I take notes." }]);
  const mark = main.events.length;
  main.act({ type: "act", act: "reload", id: "reload" });
  expect(await main.wait("answer", mark, (event) => event.id === "reload")).toMatchObject({ ok: true });

  expect((await research.closed).code).toBe(1001);
  expect((await fetch(new URL("/membr/research/", server.url))).status).toBe(404);
  expect((await listed(server)).map((agent) => agent.name)).toEqual(["default", "notes"]);
  expect((await main.wait("agents", mark)).agents.map((agent) => agent.name)).toEqual(["default", "notes"]);
  const notes = await join(server, "notes");
  await say(notes, "Hello notes");
  expect(new Log(storeDir(server.dir, "notes")).entries.map((entry) => entry.text)).toContain("Hello notes");
  expect(server.fake.epochs.find((epoch) => epoch.options.append.endsWith("I take notes."))).toBeDefined();
  expect(new Log(storeDir(server.dir, "research")).entries.map((entry) => entry.text)).toContain("Keep this");
});

test("a reload that changes one agent's prompt writes a note in that agent only", async () => {
  const server = start([{ name: "default" }, { name: "research", prompt: "Old." }]);
  const main = await join(server, null);
  const research = await join(server, "research");
  server.setConfig([{ name: "default" }, { name: "research", prompt: "New." }]);
  main.act({ type: "act", act: "reload", id: "reload" });
  await research.wait("entry", 0, (event) => event.entry.text === "Config reloaded: the prompt changed.");
  await main.wait("answer", 0, (event) => event.id === "reload");
  expect(main.events.some((event) => event.type === "entry" && event.entry.text.startsWith("Config reloaded"))).toBe(false);
});

test("a reload that cannot open a new agent answers the reason from any agent and keeps the agents it had", async () => {
  const server = start([{ name: "default" }, { name: "research" }]);
  const research = await join(server, "research");
  const file = path.join(server.dir, "file");
  fs.writeFileSync(file, "");
  server.setConfig([{ name: "default" }, { name: "research" }, { name: "broken", home: path.join(file, "inside") }]);
  const mark = research.events.length;
  research.act({ type: "act", act: "reload", id: "reload" });
  const answer = await research.wait("answer", mark, (event) => event.id === "reload");
  expect(answer.ok).toBe(false);
  expect(answer.ok ? "" : answer.reason).toStartWith("The config was not reloaded: ");
  expect((await listed(server)).map((agent) => agent.name)).toEqual(["default", "research"]);
  expect((await fetch(new URL("/membr/broken/", server.url))).status).toBe(404);
});
