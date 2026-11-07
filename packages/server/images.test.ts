import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { TestClient } from "./test/client.ts";
import { defaultStore } from "./test/config.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");
const dirs: string[] = [];
const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) await hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function start(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-images-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const engine = new FakeEngine((epoch) => epoch.emit(END));
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  return { ...hub, engine, dir };
}
function form(bytes: Uint8Array = PNG, type = "image/png", text = "Look at this.") {
  const body = new FormData();
  body.set("text", text);
  body.append("images", new Blob([Uint8Array.from(bytes)], { type }), type === "image/jpeg" ? "../../untrusted-name.jpeg" : "../../untrusted-name.png");
  return body;
}
function post(hub: ReturnType<typeof start>, id: string, body = form(), headers: Record<string, string> = {}) {
  return fetch(new URL(`/act/say?id=${id}`, hub.server.url), { method: "POST", body, headers });
}
async function connect(hub: ReturnType<typeof start>) {
  const client = await TestClient.connect(new URL("/ws", hub.server.url).href.replace("http:", "ws:"));
  clients.push(client);
  await client.wait("ready");
  return client;
}

test("S1 an uploaded image reaches the Engine, zoom and the browser image route, exactly once across restart", async () => {
  const hub = start();
  const client = await connect(hub);
  const [result, concurrent] = await Promise.all([post(hub, "picture"), post(hub, "picture")]);
  expect(result.status).toBe(200);
  const answer = await result.json();
  expect(concurrent.status).toBe(200);
  expect(await concurrent.json()).toEqual(answer);
  expect(answer).toMatchObject({ type: "answer", id: "picture", ok: true, entry: 0 });
  const entry = (await client.wait("entry", 0, (event) => event.entry.kind === "user")).entry;
  expect(entry.images).toHaveLength(1);
  const name = entry.images![0];
  expect(name).toMatch(/^[0-9a-f]{16}\.png$/);
  const sent = hub.engine.epochs[0].messages[0];
  expect(sent.text).toBe("Look at this.");
  expect(sent.from).toBe("user");
  expect(sent.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  const zoom = hub.engine.epochs[0].options.memory!.zoom(0, 1);
  expect(zoom.images).toEqual(sent.images!);
  expect(zoom.text).toContain(`docs/images/${name}`);
  const image = await fetch(new URL(`/docs/images/${name}`, hub.server.url));
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
  const changed = await new Bun.Image(PNG).resize(2, 2).png().bytes();
  const second = await post(hub, "picture", form(changed, "image/png", "Changed on retry"));
  expect(await second.json()).toEqual(answer);
  expect(hub.engine.epochs[0].messages).toHaveLength(1);
  expect(fs.readdirSync(path.join(defaultStore(hub.dir), "docs/images"))).toEqual([name]);
  await hub.close();
  const restarted = start(hub.dir);
  expect(await (await post(restarted, "picture", form(Buffer.from("invalid")))).json()).toEqual(answer);
  expect(restarted.engine.epochs[0].messages).toHaveLength(0);
  expect(restarted.engine.epochs[0].options.memory!.zoom(0, 1).images).toEqual(zoom.images);
});

test("S1 image-only inputs work, and large originals keep a fitted JPEG for Engine and zoom", async () => {
  const hub = start();
  const bytes = await new Bun.Image(PNG).resize(2000, 1000).png().bytes();
  const answer = await (await post(hub, "large", form(bytes, "image/png", ""))).json();
  expect(answer.ok).toBe(true);
  const sent = hub.engine.epochs[0].messages[0];
  expect(sent.text).toBe("");
  expect(sent.images?.[0].mimeType).toBe("image/jpeg");
  const zoom = hub.engine.epochs[0].options.memory!.zoom(answer.entry, 1);
  expect(zoom.images).toEqual(sent.images!);
  const modelImage = Buffer.from(zoom.images[0].data, "base64");
  expect(await new Bun.Image(modelImage).metadata()).toMatchObject({ width: 1568, height: 784, format: "jpeg" });
  const files = fs.readdirSync(path.join(defaultStore(hub.dir), "docs/images"));
  expect(files).toHaveLength(2);
  expect(files.some((name) => name.endsWith(".png.jpg"))).toBe(true);
  expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("S1 upload access and image validation run before a successful say is saved", async () => {
  const hub = start();
  const client = await connect(hub);
  expect((await post(hub, "no-token", form(), { Host: "remote.example" })).status).toBe(401);
  expect((await post(hub, "wrong-token", form(), { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await post(hub, "wrong-origin", form(), { Origin: "https://other.example" })).status).toBe(403);
  for (const body of [form(Buffer.from("not an image")), form(PNG, "image/jpeg")]) {
    const response = await post(hub, crypto.randomUUID(), body);
    expect(response.status).toBe(400);
    expect((await response.json()).ok).toBe(false);
  }
  const many = form();
  for (let i = 0; i < 20; i++) many.append("images", new Blob([PNG], { type: "image/png" }), "file.png");
  expect((await post(hub, "too-many", many)).status).toBe(400);
  const truncated = await post(hub, "truncated", form(PNG.subarray(0, 33)));
  expect(truncated.status).toBe(400);
  const rejected = await truncated.json();
  expect(rejected.ok).toBe(false);
  expect(await (await post(hub, "truncated", form())).json()).toEqual(rejected);
  expect(hub.engine.epochs[0].messages).toHaveLength(0);
  for (const images of [["../../token"], ["missing.png"]]) {
    const id = crypto.randomUUID();
    client.act({ type: "act", act: "say", id, text: "Unsafe image", images });
    const answer = await client.wait("answer", 0, (event) => event.id === id);
    expect(answer.ok).toBe(false);
  }
  expect(hub.engine.epochs[0].messages).toHaveLength(0);
  const accepted = await post(hub, "remote-picture", form(), { Host: "remote.example", Authorization: `Bearer ${hub.token}` });
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).entry).toBe(0);
  const route = new URL("/docs/images/%2e%2e%2ftoken", hub.server.url);
  expect((await fetch(route)).status).toBe(404);
  expect((await fetch(new URL("/docs/images/unknown.png", hub.server.url))).status).toBe(404);
  await hub.close();
  const restarted = start(hub.dir);
  expect(await (await post(restarted, "truncated", form())).json()).toEqual(rejected);
  expect(restarted.engine.epochs[0].messages).toHaveLength(0);
});
