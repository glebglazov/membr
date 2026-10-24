import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestClient } from "./test/client.ts";

const dirs: string[] = [];
const processes: Bun.Subprocess[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const proc of processes.splice(0)) { proc.kill("SIGKILL"); await proc.exited; }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-hub-"));
  dirs.push(dir);
  return dir;
}

async function serve(dir = directory()) {
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "test/serve.ts"), "serve", "--port", "0"], {
    env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe",
  });
  processes.push(proc);
  let output = "";
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    output += chunk;
    const match = /serving .* at (\S+)/.exec(output);
    if (match) {
      const url = new URL("ws", match[1]);
      url.protocol = "ws:";
      return { proc, dir, url: url.href, token: fs.readFileSync(path.join(dir, "token"), "utf8").trim() };
    }
  }
  throw new Error(await new Response(proc.stderr).text());
}

async function connect(server: Awaited<ReturnType<typeof serve>>, options: Parameters<typeof TestClient.connect>[1] = { token: server.token }) {
  const client = await TestClient.connect(server.url, options);
  clients.push(client);
  await client.wait("ready");
  return client;
}

function records(dir: string, all = false) {
  return fs.readdirSync(path.join(dir, "main")).flatMap((file) => fs.readFileSync(path.join(dir, "main", file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => all || "act" in record));
}

test("two clients see one durable entry and simultaneous resends get its first answer", async () => {
  const server = await serve();
  const a = await connect(server);
  const b = await connect(server);
  const say = { type: "act", id: "first", act: "say", text: "Hola 🌍\nsecond line" } as const;
  a.act(say);
  b.act(say);
  const first = await a.wait("entry");
  expect(await b.wait("entry")).toEqual(first);
  const answer = await a.wait("answer");
  expect(await b.wait("answer")).toEqual(answer);
  expect(answer).toEqual({ type: "answer", id: "first", ok: true, entry: 0 });
  expect(first.entry.text).toBe(say.text);
  expect(records(server.dir)).toHaveLength(1);
  expect(records(server.dir)[0].from).toEqual(first.entry.from);
  expect(first.entry.from.machine).toBe(fs.readFileSync(path.join(server.dir, "machine"), "utf8").trim());
  expect(first.entry.from.seq).toBe(0);
  expect(a.events.filter((event) => event.type === "entry")).toHaveLength(1);
  expect(b.events.filter((event) => event.type === "entry")).toHaveLength(1);
  const mark = a.events.length;
  a.act({ ...say, text: "This replacement must not be logged" });
  expect(await a.wait("answer", mark)).toEqual(answer);
  expect(records(server.dir)).toHaveLength(1);
  a.read({ type: "read", id: "roots", read: "roots" });
  expect(await a.wait("read")).toEqual({ type: "read", id: "roots", entries: [], parts: [{ l: 0, i: 0 }], lines: [{ l: 0, i: 0, text: "user: " + say.text }] });
  a.read({ type: "read", id: "zoom", read: "zoom", part: { l: 0, i: 0 } });
  expect((await a.wait("read", 0, (event) => event.id === "zoom")).entries).toEqual([first.entry]);
  const index = fs.readFileSync(path.join(server.dir, "main.index"));
  expect(index.length).toBe(16);
  expect(index.readDoubleLE(0)).toBe(0);
  expect(index.readUInt32LE(12)).toBe(Buffer.byteLength(JSON.stringify(records(server.dir)[0])));
});

test("a process restart rebuilds a missing index and preserves messages, answers and source sequence", async () => {
  const before = await serve();
  const a = await connect(before);
  a.act({ type: "act", id: "kept", act: "say", text: "Remember me" });
  const answer = await a.wait("answer");
  const entry = await a.wait("entry");
  before.proc.kill("SIGKILL");
  await before.proc.exited;
  fs.rmSync(path.join(before.dir, "main.index"));
  const after = await serve(before.dir);
  expect(after.token).toBe(before.token);
  const b = await connect(after);
  expect(await b.wait("entry")).toEqual(entry);
  b.act({ type: "act", id: "kept", act: "say", text: "Different content" });
  expect(await b.wait("answer")).toEqual(answer);
  b.act({ type: "act", id: "next", act: "say", text: "Next message" });
  await b.wait("answer", 0, (event) => event.id === "next");
  expect(records(after.dir).map((record) => record.from)).toEqual([
    entry.entry.from, { machine: entry.entry.from.machine, seq: entry.entry.from.seq + 1 },
  ]);
  expect(fs.statSync(path.join(after.dir, "main.index")).size).toBe(32);
  expect(fs.statSync(path.join(after.dir, "token")).mode & 0o777).toBe(0o600);
});

test("header, query and cookie bearer tokens authorize the same protocol", async () => {
  const server = await serve();
  const header = await connect(server, { headers: { Authorization: `Bearer ${server.token}` } });
  const cookie = await connect(server, { kind: "web", headers: { Cookie: `other=x; token=${server.token}` }, version: "1.20.3" });
  const query = await TestClient.connect(`${server.url}?token=${server.token}`);
  clients.push(query);
  await query.wait("ready");
  header.act({ type: "act", id: "auth", act: "say", text: "Same chat" });
  const entry = await header.wait("entry");
  expect(await cookie.wait("entry")).toEqual(entry);
  expect(await query.wait("entry")).toEqual(entry);
});

test("bad credentials and incompatible versions have reasons and reveal no log", async () => {
  const server = await serve();
  const good = await connect(server);
  good.act({ type: "act", id: "private", act: "say", text: "Private" });
  await good.wait("answer");
  for (const options of [{ token: "wrong" }, { token: server.token, version: "2.0" }, { token: "wrong", headers: { Authorization: `Bearer ${server.token}` } }]) {
    const client = await TestClient.connect(server.url, options);
    clients.push(client);
    const refused = await client.wait("refused");
    expect(refused.reason.length).toBeGreaterThan(0);
    expect((await client.closed).code).toBe(1008);
    expect(client.events.some((event) => event.type === "entry")).toBe(false);
  }
  const http = server.url.replace("ws:", "http:");
  for (const [url, headers] of [
    [http, { Authorization: "Bearer wrong" }],
    [`${http}?token=wrong`, {}],
    [http, { Cookie: "token=wrong" }],
    [`${http}?token=wrong`, { Authorization: `Bearer ${server.token}` }],
  ] as const) {
    const response = await fetch(url, { headers });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("token");
  }
});

test("malformed acts save error answers without chat entries, and resends keep their first answer", async () => {
  const server = await serve();
  const client = await connect(server);
  for (const bad of ["{", JSON.stringify({ type: "act", act: "say", id: "", text: 42 }), JSON.stringify({ type: "read", id: "bad", read: "zoom", part: { l: -1, i: 0 } })]) {
    const mark = client.events.length;
    client.socket.send(bad);
    expect((await client.wait("error", mark)).reason.length).toBeGreaterThan(0);
  }
  expect(records(server.dir)).toHaveLength(0);
  client.socket.send(JSON.stringify({ type: "act", act: "say", id: "bad", text: 42 }));
  const invalid = await client.wait("answer");
  expect(invalid).toMatchObject({ id: "bad", ok: false });
  const retry = client.events.length;
  client.act({ type: "act", act: "say", id: "bad", text: "Do not log" });
  expect(await client.wait("answer", retry)).toEqual(invalid);
  client.act({ type: "act", id: "goal", act: "goal", text: "Future work" });
  const answer = await client.wait("answer", 0, (event) => event.id === "goal");
  expect(answer.ok).toBe(true);
  const mark = client.events.length;
  client.act({ type: "act", id: "goal", act: "say", text: "Do not log" });
  expect(await client.wait("answer", mark)).toEqual(answer);
  expect(records(server.dir)).toHaveLength(2);
  expect(records(server.dir).every((record) => record.kind === undefined)).toBe(true);
});

test("an incomplete final line is removed before the next durable append", async () => {
  const before = await serve();
  const a = await connect(before);
  a.act({ type: "act", id: "complete", act: "say", text: "Complete" });
  await a.wait("answer");
  before.proc.kill("SIGKILL");
  await before.proc.exited;
  const file = path.join(before.dir, "main", fs.readdirSync(path.join(before.dir, "main"))[0]);
  fs.appendFileSync(file, '{"act":"torn');
  fs.writeFileSync(path.join(before.dir, "main.index"), "stale index");
  const after = await serve(before.dir);
  const b = await connect(after);
  b.act({ type: "act", id: "after", act: "say", text: "After recovery" });
  await b.wait("answer");
  expect(records(after.dir).map((record) => record.text)).toEqual(["Complete", "After recovery"]);
});

test("a committed entry survives an index write failure without a second append", async () => {
  const before = await serve();
  const client = await connect(before);
  const index = path.join(before.dir, "main.index");
  fs.rmSync(index);
  fs.mkdirSync(index);
  const act = { type: "act", id: "index-failure", act: "say", text: "Still durable" } as const;
  client.act(act);
  await client.wait("error");
  const mark = client.events.length;
  client.act(act);
  await client.wait("error", mark);
  expect(records(before.dir)).toHaveLength(1);
  before.proc.kill("SIGKILL");
  await before.proc.exited;
  fs.rmdirSync(index);
  const after = await serve(before.dir);
  const recovered = await connect(after);
  expect((await recovered.wait("entry")).entry.text).toBe(act.text);
  recovered.act(act);
  expect(await recovered.wait("answer")).toEqual({ type: "answer", id: act.id, ok: true, entry: 0 });
  expect(records(after.dir)).toHaveLength(1);
});

test("recovery uses message indexes when a clock change reverses daily file order", async () => {
  const before = await serve();
  const client = await connect(before);
  for (const id of ["first-day", "second-day"]) {
    client.act({ type: "act", id, act: "say", text: id });
    await client.wait("answer", 0, (event) => event.id === id);
  }
  before.proc.kill("SIGKILL");
  await before.proc.exited;
  const saved = records(before.dir, true);
  const main = path.join(before.dir, "main");
  for (const file of fs.readdirSync(main)) fs.rmSync(path.join(main, file));
  fs.writeFileSync(path.join(main, "2026-10-23.jsonl"), saved.filter((record) => record.turn?.id === 0).map((record) => JSON.stringify(record)).join("\n") + "\n");
  fs.writeFileSync(path.join(main, "2026-10-22.jsonl"), saved.filter((record) => record.turn?.id === 1).map((record) => JSON.stringify(record)).join("\n") + "\n");
  const after = await serve(before.dir);
  const recovered = await connect(after);
  expect(recovered.events.filter((event) => event.type === "entry").map((event) => event.entry.text)).toEqual(["first-day", "second-day"]);
  recovered.read({ type: "read", id: "both", read: "zoom", part: { l: 1, i: 0 } });
  const children = await recovered.wait("read");
  expect(children.parts).toEqual([{ l: 0, i: 0 }, { l: 0, i: 1 }]);
  const texts: string[] = [];
  for (const part of children.parts) {
    const id = `leaf-${part.i}`;
    recovered.read({ type: "read", id, read: "zoom", part });
    texts.push(...(await recovered.wait("read", 0, (event) => event.id === id)).entries.map((entry) => entry.text));
  }
  expect(texts).toEqual(["first-day", "second-day"]);
});
