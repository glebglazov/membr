import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, ScheduleSpec, ScheduleView, Watch } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { TestClient } from "./test/client.ts";
import { FakeClock } from "./test/clock.ts";
import { END, FakeEngine } from "./test/engine.ts";
import { defaultStore, testConfig } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [], dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const T0 = Date.parse("2026-11-09T08:00:30.000Z");
const TASK = "Tell the user that CI on PR 412 is done.";
const spec = (when: Partial<Watch> & { command: string }, over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({ text: TASK, when: { kind: "watch", on: "exit", quiet: 60, ...when }, run: "turn", missed: "once", ...over });

async function serve(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-watches-")), clock = new FakeClock(T0)) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const engine = new FakeEngine();
  const hub = serveHub({ dir, port: 0, engine, clock, config: () => testConfig(dir) });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  const main = engine.epochs[0]!;
  return { dir, hub, client, engine, clock, main, tools: main.options.schedules! };
}

async function act(client: TestClient, body: Record<string, unknown>) {
  const id = crypto.randomUUID(), mark = client.events.length;
  client.socket.send(JSON.stringify({ type: "act", id, ...body }));
  return await client.wait("answer", mark, (event) => event.id === id);
}

// The agent proposes the watch with its tool, and the user accepts it in a client.
async function watch(client: TestClient, tools: { create(spec: ScheduleSpec): string }, value: ScheduleSpec): Promise<string> {
  const id = /Proposed schedule (\w+)\./.exec(tools.create(value))![1]!;
  expect((await act(client, { act: "accept", schedule: id })).ok).toBe(true);
  return id;
}

// Waits in real time for what a real process does, moving the fake clock by tick on each try.
async function until<T>(check: () => T | undefined | false, tick = () => {}): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    tick();
    await Bun.sleep(20);
  }
  throw new Error("Timed out");
}

const view = (client: TestClient, id: string): ScheduleView | undefined => client.events.findLast((event) => event.type === "schedules")?.schedules.find((s) => s.id === id);
const entries = (client: TestClient): Entry[] => client.events.flatMap((event) => event.type === "entry" ? [event.entry] : []);
const fires = (client: TestClient) => entries(client).filter((entry) => entry.kind === "work" && entry.text.startsWith("Watch "));
const notes = (client: TestClient) => entries(client).filter((entry) => entry.kind === "note").map((entry) => entry.text);

test("a proposed watch runs nothing until the user accepts it, then its exit starts a membr turn with its output and task, and it is done", async () => {
  const { dir, client, main, tools } = await serve();
  const flag = path.join(dir, "ci-green");
  const command = `until [ -f '${flag}' ]; do sleep 0.05; done; echo 'checks: 14 passed'; echo ok >&2`;
  const id = /Proposed schedule (\w+)\./.exec(tools.create(spec({ command })))![1]!;
  await Bun.sleep(100);
  expect(view(client, id)).toMatchObject({ phase: "proposed", running: false });
  expect((await act(client, { act: "accept", schedule: id })).ok).toBe(true);
  expect(await until(() => view(client, id)?.running)).toBe(true);
  expect(fires(client)).toEqual([]);
  fs.writeFileSync(flag, "");
  const fired = await until(() => fires(client)[0]);
  expect(fired.text).toMatch(new RegExp(`^Watch ${id} ended: the command exited with code 0 after \\d+s\\.\\nLast output:\\n  checks: 14 passed\\nTask: ${TASK}\\nThe watch is done\\.$`));
  expect(fired.scheduled).toEqual({ schedule: id, late: false });
  expect(main.messages.at(-1)).toEqual({ text: fired.text, priority: "now", from: "membr" });
  expect(await until(() => view(client, id)?.phase === "done" && view(client, id))).toMatchObject({ phase: "done", running: false, last: { result: "ended", entry: fired.i } });
  expect(new Log(defaultStore(dir)).lastFire(id)).toMatchObject({ result: "ended", entry: fired.i });
});

test("a command that fails shows its last errors, and a watch fire joins the turn that runs as a next input", async () => {
  const { client, main, tools } = await serve();
  expect((await act(client, { act: "say", text: "Work on the release" })).ok).toBe(true);
  const id = await watch(client, tools, spec({ command: "echo building; echo 'no checks reported' >&2; exit 3" }));
  const fired = await until(() => fires(client)[0]);
  expect(fired.text).toContain(`Watch ${id} ended: the command exited with code 3`);
  expect(fired.text).toContain("Last output:\n  building\nLast errors:\n  no checks reported\n");
  expect(main.messages.map((message) => message.priority)).toEqual(["now", "next"]);
  expect(main.messages.at(-1)).toMatchObject({ from: "membr", text: fired.text });
  expect(client.events.findLast((event) => event.type === "state")).toMatchObject({ state: { busy: true } });
});

test("a lines watch batches a burst into one fire of its newest 50 lines, waits quiet between fires, and pauses after 10 fires in an hour", async () => {
  const { client, clock, main, tools } = await serve();
  const command = "i=0; while [ $i -lt 120 ]; do i=$((i+1)); echo \"line $i\"; done; while true; do echo tick; sleep 0.02; done";
  const id = await watch(client, tools, spec({ command, on: "lines", quiet: 60 }));
  const first = await until(() => fires(client)[0], () => clock.advance(1_000));
  expect(first.text).toStartWith(`Watch ${id} printed `);
  expect(first.text).toContain("earlier lines dropped)");
  expect(first.text.split("\n").filter((line) => line.startsWith("  ") && !line.includes("dropped"))).toHaveLength(50);
  expect(first.text).toContain(`Task: ${TASK}\nThe watch goes on; its next fire comes no sooner than 1m from now.`);
  const at = clock.now();
  await until(() => fires(client).length === 2, () => clock.advance(5_000));
  expect(clock.now() - at).toBeGreaterThanOrEqual(60_000);
  main.emit(END);
  await until(() => notes(client).find((text) => text.startsWith(`Watch ${id} fired more than 10 times in an hour`)), () => clock.advance(60_000));
  expect(fires(client)).toHaveLength(10);
  expect(await until(() => view(client, id)?.phase === "paused" && view(client, id))).toMatchObject({ phase: "paused", running: false });
});

test("pause stops the command, resume starts it again, and delete stops it for good", async () => {
  const { client, tools } = await serve();
  const id = await watch(client, tools, spec({ command: "sleep 30" }));
  await until(() => view(client, id)?.running);
  expect((await act(client, { act: "pause", schedule: id, paused: true })).ok).toBe(true);
  expect(view(client, id)).toMatchObject({ phase: "paused", running: false });
  expect((await act(client, { act: "pause", schedule: id, paused: false })).ok).toBe(true);
  expect(view(client, id)).toMatchObject({ phase: "active", running: true });
  expect((await act(client, { act: "unschedule", schedule: id })).ok).toBe(true);
  expect(view(client, id)).toMatchObject({ phase: "cancelled", running: false });
  expect(fires(client)).toEqual([]);
});

test("after a server restart an active watch runs again with a note, a missed skip watch is paused, and an ended one stays done", async () => {
  const first = await serve();
  const again = await watch(first.client, first.tools, spec({ command: "sleep 30" }));
  const skip = await watch(first.client, first.tools, spec({ command: "sleep 30" }, { missed: "skip" }));
  const ended = await watch(first.client, first.tools, spec({ command: "true" }));
  await until(() => fires(first.client).length === 1);
  await until(() => view(first.client, again)?.running && view(first.client, skip)?.running);
  first.client.close();
  await first.hub.close();
  hubs.splice(hubs.indexOf(first.hub), 1);
  const second = await serve(first.dir);
  expect(notes(second.client)).toContain(`Watch ${again} started again after membr restarted. What its command printed while membr was down was not seen.`);
  expect(notes(second.client)).toContain(`Watch ${skip} was active when membr stopped, so it is paused.`);
  expect(view(second.client, again)).toMatchObject({ phase: "active", running: true });
  expect(view(second.client, skip)).toMatchObject({ phase: "paused", running: false });
  expect(view(second.client, ended)).toMatchObject({ phase: "done", running: false });
  expect(fires(second.client)).toHaveLength(1);
});

test("a watch needs a command, and the tool refuses quiet out of range", async () => {
  const { tools } = await serve();
  expect(() => tools.create(spec({ command: "  " }))).toThrow("A watch needs a command.");
  expect(() => tools.create(spec({ command: "true", quiet: 2 }))).toThrow("A watch's quiet is 5 to 86400 seconds.");
});

test("a watch ends when its shell exits, even when a child it left in the background holds its output open", async () => {
  const { client, tools } = await serve();
  const id = await watch(client, tools, spec({ command: "(sleep 30 &); echo started the deploy" }));
  const fired = await until(() => fires(client)[0]);
  expect(fired.text).toContain(`Watch ${id} ended: the command exited with code 0`);
  expect(fired.text).toContain("Last output:\n  started the deploy\n");
});

test("a new server ends the watch commands that a server which died without close left running, and only those", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-watches-"));
  dirs.push(dir);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const orphan = spawn("/bin/sh", ["-c", "sleep 31"], { detached: true, stdio: "ignore" });
  const other = spawn("/bin/sh", ["-c", "sleep 32"], { detached: true, stdio: "ignore" });
  try {
    fs.mkdirSync(defaultStore(dir), { recursive: true });
    fs.writeFileSync(path.join(defaultStore(dir), "watches.pids"), [{ pgid: orphan.pid, command: "sleep 31" }, { pgid: other.pid, command: "sleep 99" }].map((group) => JSON.stringify(group)).join("\n") + "\n");
    await serve(dir);
    expect(await until(() => !alive(orphan.pid!))).toBe(true);
    expect(alive(other.pid!)).toBe(true);
    expect(fs.existsSync(path.join(defaultStore(dir), "watches.pids"))).toBe(false);
  } finally {
    for (const proc of [orphan, other]) try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
  }
});
