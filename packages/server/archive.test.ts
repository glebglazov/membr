import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, ScheduleSpec } from "@membr/protocol";
import { exportArchive, importArchive } from "./src/archive.ts";
import { agentNameError } from "./src/config.ts";
import { holder } from "./src/lock.ts";
import { Log } from "./src/log.ts";
import { TestClient } from "./test/client.ts";
import { defaultStore } from "./test/config.ts";

const MAIN = path.join(import.meta.dir, "test/serve.ts");
const dirs: string[] = [];
const running: Bun.Subprocess[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  for (const proc of running.splice(0)) { proc.kill("SIGKILL"); await proc.exited; }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MEMBR_DIR;
});

function directory() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "membr-archive-test-")));
  dirs.push(dir);
  return dir;
}

async function serve(dir: string) {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 0, agents: { second: { prompt: "Second." } } }));
  const proc = Bun.spawn(["bun", MAIN, "server", "run"], { env: { ...process.env, MEMBR_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  let output = "";
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    output += chunk;
    const match = /serving .* at (\S+)/.exec(output);
    if (match) return { proc, url: match[1]! };
  }
  throw new Error(await new Response(proc.stderr).text());
}

async function connect(url: string, dir: string, agent = "default") {
  const address = new URL(`membr/${agent}/ws`, url);
  address.protocol = "ws:";
  const client = await TestClient.connect(address.href, { token: fs.readFileSync(path.join(dir, "token"), "utf8").trim() });
  clients.push(client);
  await client.wait("ready");
  return client;
}

async function act(client: TestClient, body: Record<string, unknown>) {
  const id = crypto.randomUUID(), mark = client.events.length;
  client.socket.send(JSON.stringify({ type: "act", id, ...body }));
  const answer = await client.wait("answer", mark, (event) => event.id === id);
  expect(answer.ok).toBe(true);
}

const SPEC: ScheduleSpec = { text: "Read the inbox.", when: { kind: "cron", expr: "0 9 * * *", zone: "UTC" }, run: "turn", missed: "once" };

// A base directory that a real server wrote through its API, and that no server holds any more.
async function seeded(): Promise<string> {
  const dir = directory();
  const server = await serve(dir);
  const client = await connect(server.url, dir);
  await act(client, { act: "say", text: "first message" });
  await act(client, { act: "say", text: "second message" });
  await act(client, { act: "notebook", text: "- Editor: helix", base: 0 });
  await act(client, { act: "schedule", schedule: SPEC });
  const other = await connect(server.url, dir, "second");
  await act(other, { act: "say", text: "hello second" });
  client.close();
  other.close();
  server.proc.kill("SIGTERM");
  await server.proc.exited;
  fs.writeFileSync(path.join(defaultStore(dir), "epochs.json"), "{}\n");
  fs.mkdirSync(path.join(defaultStore(dir), "home"), { recursive: true });
  fs.writeFileSync(path.join(defaultStore(dir), "home", "notes.txt"), "kept\n");
  return dir;
}

const listing = async (file: string) => (await Bun.$`tar -tzf ${file}`.text()).split("\n").filter(Boolean);

function observed(dir: string, agent = "default") {
  const log = new Log(path.join(dir, "agents", agent));
  return { entries: log.entries.map((entry: Entry) => [entry.kind, entry.text]), notebook: log.notebook.text, schedules: [...log.schedules.values()].map((schedule) => schedule.text) };
}

async function imported(file: string) {
  const target = path.join(directory(), "membr");
  process.env.MEMBR_DIR = target;
  await importArchive(target, file);
  return target;
}

test("an archive made with no server restores the same installation, and leaves out what belongs to one computer", async () => {
  const dir = await seeded();
  const file = path.join(directory(), "membr.tar.gz");
  await exportArchive(dir, file);

  const names = await listing(file);
  expect(names).toContain("config.json");
  expect(names.some((name) => name.startsWith("agents/default/main/"))).toBe(true);
  expect(names).toContain("agents/default/home/notes.txt");
  for (const left of ["token", "lock", "lock.guard", "serve.log"]) expect(names).not.toContain(left);
  expect(names.filter((name) => /(^|\/)(machine|epochs\.json)$|\.tmp$|\.index$/.test(name))).toEqual([]);

  const target = await imported(file);
  expect(observed(target)).toEqual(observed(dir));
  expect(observed(target).entries.length).toBeGreaterThan(2);
  expect(observed(target).notebook).toBe("- Editor: helix");
  expect(observed(target).schedules).toEqual([SPEC.text]);
  expect(observed(target, "second")).toEqual(observed(dir, "second"));
  expect(fs.existsSync(path.join(target, "token"))).toBe(false);
  expect(fs.readFileSync(path.join(defaultStore(target), "machine"), "utf8")).not.toBe(fs.readFileSync(path.join(defaultStore(dir), "machine"), "utf8"));

  const server = await serve(target);
  const client = await connect(server.url, target);
  await client.wait("history");
  expect(client.entries.map((entry) => entry.text)).toContain("second message");
});

test("an export while the server runs leaves the server answering, and its archive imports the same", async () => {
  const dir = await seeded();
  const server = await serve(dir);
  expect(holder(dir)?.url).toBeTruthy();
  const file = path.join(directory(), "live.tar.gz");
  const lines = await exportArchive(dir, file);
  expect(lines[0]).toContain(file);
  expect(fs.existsSync(file + ".tmp")).toBe(false);
  expect(server.proc.exitCode).toBeNull();
  expect((await fetch(server.url)).ok).toBe(true);
  expect(await listing(file)).not.toContain("token");

  server.proc.kill("SIGTERM");
  await server.proc.exited;
  const target = await imported(file);
  expect(observed(target)).toEqual(observed(dir));
  expect(observed(target, "second")).toEqual(observed(dir, "second"));
});

test("an export never overwrites a file", async () => {
  const dir = await seeded();
  const file = path.join(directory(), "taken.tar.gz");
  fs.writeFileSync(file, "mine");
  await expect(exportArchive(dir, file)).rejects.toThrow("exists already");
  expect(fs.readFileSync(file, "utf8")).toBe("mine");
});

test("an import refuses a target that has files or a server, and a corrupt archive leaves nothing", async () => {
  const dir = await seeded();
  const file = path.join(directory(), "membr.tar.gz");
  await exportArchive(dir, file);

  const full = directory();
  fs.writeFileSync(path.join(full, "keep.txt"), "mine");
  await expect(importArchive(full, file)).rejects.toThrow("is not empty");
  expect(fs.readdirSync(full)).toEqual(["keep.txt"]);

  const held = directory();
  const server = await serve(held);
  await expect(importArchive(held, file)).rejects.toThrow("server holds");
  expect(server.proc.exitCode).toBeNull();

  const parent = directory();
  const corrupt = path.join(parent, "corrupt.tar.gz");
  fs.writeFileSync(corrupt, "this is not an archive");
  await expect(importArchive(path.join(parent, "membr"), corrupt)).rejects.toThrow("not a membr archive");
  expect(fs.readdirSync(parent)).toEqual(["corrupt.tar.gz"]);
});

test("an import with an agent home that does not exist here works and says what to fix", async () => {
  const source = directory();
  fs.mkdirSync(path.join(source, "agents", "work", "main"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({ port: 0, agents: { work: { home: "/nowhere/on/this/computer" } } }));
  const file = path.join(directory(), "membr.tar.gz");
  await exportArchive(source, file);

  const target = path.join(directory(), "membr");
  const lines = await importArchive(target, file);
  expect(lines.join("\n")).toContain("/nowhere/on/this/computer is not a directory");
  expect(lines.join("\n")).toContain("fix config.json before membr starts the server");
  expect(fs.existsSync(path.join(target, "agents", "work"))).toBe(true);
});

test("export and import are not agent names", () => {
  expect(agentNameError("export")).toContain("membr command");
  expect(agentNameError("import")).toContain("membr command");
});
