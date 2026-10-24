import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { seedMemory } from "./test/memory.ts";
import { TestClient } from "./test/client.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const dirs: string[] = [];
const clients: TestClient[] = [];
const processes: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) await hub.close();
  for (const proc of processes.splice(0)) { proc.kill(); await proc.exited; }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function start(hostname = "127.0.0.1", engine = new FakeEngine()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-web-"));
  dirs.push(dir);
  const hub = serveHub({ dir, port: 0, hostname, engine });
  hubs.push(hub);
  return hub;
}

async function startCLI(hostname = "127.0.0.1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-web-cli-"));
  dirs.push(dir);
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "test/web-serve.ts"), "serve", "--port", "0", "--host", hostname], {
    env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe",
  });
  processes.push(proc);
  let output = "";
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    output += chunk;
    const link = /sign in at (\S+)/.exec(output)?.[1];
    if (link) return { url: new URL("/", link), link, token: new URL(link).searchParams.get("token")! };
  }
  throw new Error(await new Response(proc.stderr).text());
}

test("loopback opens the page and socket without a token", async () => {
  const hub = await startCLI();
  const page = await fetch(hub.url);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('name="color-scheme" content="light dark"');
  const assets = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), ([, asset]) => new URL(asset!, hub.url)).filter((url) => url.protocol !== "data:");
  expect(assets.length).toBeGreaterThan(0);
  const contentTypes: string[] = [];
  for (const asset of assets) {
    const response = await fetch(asset);
    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type")!;
    contentTypes.push(contentType);
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
    if (contentType.includes("text/css")) expect(body).toContain("prefers-color-scheme");
  }
  expect(contentTypes.some((type) => type.includes("javascript"))).toBe(true);
  expect(contentTypes.some((type) => type.includes("text/css"))).toBe(true);
  const client = await TestClient.connect(new URL("/ws", hub.url).href.replace("http:", "ws:"));
  clients.push(client);
  await client.wait("ready");
  expect((await fetch(hub.url, { headers: { Origin: "https://other.example" } })).status).toBe(403);
  expect((await fetch(hub.url, { headers: { Host: "other.example" } })).status).toBe(401);
  expect((await fetch(hub.url, { headers: { Cookie: "token=wrong" } })).status).toBe(401);
});

test("the export JSON matches the saved chat and memory", async () => {
  const hub = start();
  const client = await TestClient.connect(new URL("/ws", hub.server.url).href.replace("http:", "ws:"));
  clients.push(client);
  await client.wait("ready");
  client.act({ type: "act", act: "say", id: "export-message", text: "Keep this in the export." });
  const saved = await client.wait("entry", 0, (event) => event.entry.text === "Keep this in the export.");
  const response = await fetch(new URL("/export", hub.server.url));
  expect(response.headers.get("content-disposition")).toContain("membr-memory.json");
  const value = await response.json();
  expect(value.messages).toContainEqual(saved.entry);
  expect(value.lines).toContainEqual(expect.objectContaining({ text: "user: Keep this in the export." }));
  expect(value).toMatchObject({ goal: null, pick: { model: "sonnet", effort: "high", fast: false } });
  expect(value.view).toContain("<chat>");
});

test("a non-loopback request needs a token and the sign-in link sets a reusable cookie", async () => {
  const address = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!address) throw new Error("This access test needs a non-loopback IPv4 interface");
  const hub = await startCLI(address);
  const url = hub.url;
  for (const route of ["/", "/main.js", "/main.css", "/ws"]) expect((await fetch(new URL(route, url))).status).toBe(401);
  const signIn = await fetch(hub.link, { redirect: "manual" });
  expect(signIn.status).toBe(303);
  expect(signIn.headers.get("location")).toBe("/");
  const cookie = signIn.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(signIn.headers.get("referrer-policy")).toBe("no-referrer");
  const headers = { Cookie: cookie.split(";")[0] };
  const page = await fetch(url, { headers });
  expect(page.status).toBe(200);
  const script = (await page.text()).match(/<script[^>]+src="([^"]+)"/)![1]!;
  expect((await fetch(new URL(script, url), { headers })).status).toBe(200);
  expect((await fetch(new URL(script, url))).status).toBe(401);
  const socket = new URL("/ws", url).href.replace("http:", "ws:");
  const client = await TestClient.connect(socket, { headers });
  clients.push(client);
  await client.wait("ready");
  const refused = await TestClient.connect(socket);
  clients.push(refused);
  expect((await refused.wait("refused")).reason).toContain("token");
  expect(refused.events.some((event) => event.type === "entry")).toBe(false);
  const hello = await TestClient.connect(socket, { token: hub.token });
  clients.push(hello);
  await hello.wait("ready");
});

test("a reconnect receives the current main text before the next delta", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "delta", text: "The first part" }));
  const hub = start("127.0.0.1", engine);
  const url = new URL("/ws", hub.server.url).href.replace("http:", "ws:");
  const first = await TestClient.connect(url);
  clients.push(first);
  await first.wait("ready");
  first.act({ type: "act", act: "say", id: "stream", text: "Go" });
  await first.wait("live");
  first.close();
  const second = await TestClient.connect(url);
  clients.push(second);
  await second.wait("ready");
  expect((await second.wait("live")).text).toBe("The first part");
  engine.epochs[0].emit({ kind: "text", text: "The first part" });
  await second.wait("entry", 0, (event) => event.entry.kind === "unii");
  const third = await TestClient.connect(url);
  clients.push(third);
  await third.wait("ready");
  expect(third.events.filter((event) => event.type === "live")).toEqual([]);
});

test("the view sends summary text at connect and after a new message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-web-memory-"));
  dirs.push(dir);
  await seedMemory(dir, 8);
  const hub = serveHub({ dir, port: 0, engine: new FakeEngine((epoch) => epoch.emit(END)) });
  hubs.push(hub);
  const client = await TestClient.connect(new URL("/ws", hub.server.url).href.replace("http:", "ws:"));
  clients.push(client);
  await client.wait("ready");
  const initial = await client.wait("view");
  expect(initial.parts).toEqual([{ l: 3, i: 0 }]);
  expect(initial.lines).toEqual(JSON.parse(fs.readFileSync(path.join(dir, "view.json"), "utf8")).lines);
  expect(initial.lines?.[0]?.text).toContain("A compacted message.");
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "new-memory", text: "A new memory" });
  const next = await client.wait("view", mark, (event) => event.parts.length === 2);
  expect(next.lines).toEqual([{ l: 0, i: 8, text: "user: A new memory" }]);
});

test("the current turn cutoff reaches every client and survives restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-web-turn-"));
  dirs.push(dir);
  await seedMemory(dir, 8);
  const text = "The final answer remains readable. ".repeat(80);
  const hub = serveHub({ dir, port: 0, engine: new FakeEngine((epoch) => epoch.emit({ kind: "text", text }, END)) });
  hubs.push(hub);
  const client = await TestClient.connect(new URL("/ws", hub.server.url).href.replace("http:", "ws:"));
  clients.push(client);
  await client.wait("ready");
  expect((await client.wait("view")).turn).toBe(8);
  const mark = client.events.length;
  client.act({ type: "act", act: "say", id: "long-answer", text: "Give a complete answer" });
  const final = await client.wait("view", mark, (event) => event.parts.length === 3);
  expect(final.turn).toBe(8);
  expect(final.lines).toEqual([{ l: 0, i: 9, text: "(not summarized yet: zoom it)" }]);
  expect((await client.wait("entry", mark, (event) => event.entry.kind === "unii")).entry.text).toBe(text);
  await client.wait("state", mark, (event) => !event.state.busy);
  const second = await TestClient.connect(new URL("/ws", hub.server.url).href.replace("http:", "ws:"));
  clients.push(second);
  await second.wait("ready");
  expect((await second.wait("view")).turn).toBe(8);
  await hub.close();
  hubs.splice(hubs.indexOf(hub), 1);
  const restarted = serveHub({ dir, port: 0, engine: new FakeEngine() });
  hubs.push(restarted);
  const third = await TestClient.connect(new URL("/ws", restarted.server.url).href.replace("http:", "ws:"));
  clients.push(third);
  await third.wait("ready");
  expect((await third.wait("view")).turn).toBe(8);
});
