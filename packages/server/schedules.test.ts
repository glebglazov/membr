import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, ScheduleSpec } from "@membr/protocol";
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
const at = (time: string) => Date.parse(`2026-11-09T${time}.000Z`);
const TEXT = "Read the inbox notes and write a summary.";
const DENIED = "Nobody answered the approval for Bash within 10m, so membr denied it.";
const hourly = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({ text: TEXT, when: { kind: "cron", expr: "0 * * * *", zone: "UTC" }, run: "turn", missed: "once", ...over });

async function serve(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-schedules-")), clock = new FakeClock(T0)) {
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

// Every event the server sent before the answer to this read has arrived.
async function settle(client: TestClient) {
  const id = crypto.randomUUID();
  client.read({ type: "read", id, read: "roots" });
  await client.wait("read", 0, (event) => event.id === id);
}

async function act(client: TestClient, body: Record<string, unknown>) {
  const id = crypto.randomUUID(), mark = client.events.length;
  client.socket.send(JSON.stringify({ type: "act", id, ...body }));
  return { answer: await client.wait("answer", mark, (event) => event.id === id), mark };
}

async function schedule(client: TestClient, spec: ScheduleSpec): Promise<string> {
  const { answer, mark } = await act(client, { act: "schedule", schedule: spec });
  expect(answer.ok).toBe(true);
  return (await client.wait("schedules", mark)).schedules.at(-1)!.id;
}

const entries = (client: TestClient): Entry[] => client.events.flatMap((event) => event.type === "entry" ? [event.entry] : []);
const fires = (client: TestClient): Entry[] => entries(client).filter((entry) => entry.scheduled);
const idle = (client: TestClient, mark: number) => client.wait("state", mark, (event) => !event.state.busy);

function settled(promise: Promise<boolean>) {
  const box: { value?: boolean } = {};
  void promise.then((value) => { box.value = value; });
  return box;
}

test("schedules arrives before ready, and a user's schedule is active with its next fires", async () => {
  const { client } = await serve();
  const types = client.events.map((event) => event.type);
  expect(types.indexOf("schedules")).toBeGreaterThan(-1);
  expect(types.indexOf("schedules")).toBeLessThan(types.indexOf("ready"));
  const id = await schedule(client, hourly());
  const view = client.events.findLast((event) => event.type === "schedules")!;
  expect(view.type === "schedules" && view.schedules).toEqual([{ ...hourly(), id, author: "user", phase: "active", since: new Date(T0).toISOString(), next: ["2026-11-09T09:00:00.000Z", "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z"], last: null }]);
});

test("a schedule with a bad cron, an unknown zone or a past time is refused", async () => {
  const { client } = await serve();
  for (const [when, reason] of [
    [{ kind: "cron", expr: "61 * * * *", zone: "UTC" }, 'Cron minute: "61" is not a value from 0 to 59'],
    [{ kind: "cron", expr: "0 * * * *", zone: "Mars/Olympus" }, 'Unknown time zone "Mars/Olympus"'],
    [{ kind: "once", at: "2026-11-09T08:00:00.000Z" }, "2026-11-09T08:00:00.000Z is not in the future."],
  ] as const) {
    const { answer } = await act(client, { act: "schedule", schedule: hourly({ when }) });
    expect(answer.ok === false && answer.reason).toStartWith(reason);
  }
  expect(client.events.findLast((event) => event.type === "schedules")).toEqual({ type: "schedules", schedules: [] });
});

test("a user schedule fires once, on time, as the user's own message, and later ticks do not fire it again", async () => {
  const { client, clock, main, dir } = await serve();
  const id = await schedule(client, hourly());
  clock.until(at("08:59:59"));
  await settle(client);
  expect(fires(client)).toEqual([]);
  clock.until(at("09:00:00"));
  const fired = (await client.wait("entry", 0, (event) => event.entry.scheduled !== undefined)).entry;
  expect(fired).toMatchObject({ kind: "user", text: TEXT, scheduled: { schedule: id, late: false } });
  expect(main.messages.at(-1)).toEqual({ text: TEXT, priority: "now", from: "user" });
  const mark = client.events.length;
  main.emit(END);
  await idle(client, mark);
  clock.advance(5 * 60_000);
  await settle(client);
  expect(fires(client)).toHaveLength(1);
  expect(entries(client).some((entry) => entry.text.includes("late"))).toBe(false);
  expect(new Log(defaultStore(dir)).lastFire(id)).toEqual({ at: "2026-11-09T09:00:00.000Z", result: "ran", entry: fired.i });
});

test("a chat busy for three slots fires once at the newest slot, and not late", async () => {
  const { client, clock, main, dir } = await serve();
  const id = await schedule(client, hourly({ when: { kind: "cron", expr: "*/10 * * * *", zone: "UTC" } }));
  await act(client, { act: "say", text: "Work" });
  clock.until(at("08:35:00"));
  await settle(client);
  expect(fires(client)).toEqual([]);
  main.emit(END);
  const fired = (await client.wait("entry", 0, (event) => event.entry.scheduled !== undefined)).entry;
  expect(fired.scheduled).toEqual({ schedule: id, late: false });
  await settle(client);
  expect(fires(client)).toHaveLength(1);
  expect(new Log(defaultStore(dir)).lastFire(id)?.at).toBe("2026-11-09T08:30:00.000Z");
});

test("after a gap, a reopened log gives one late fire for missed once and one skipped record for skip", async () => {
  const first = await serve();
  const late = await schedule(first.client, hourly());
  const skipped = await schedule(first.client, hourly({ text: "Check the CI.", missed: "skip" }));
  await first.hub.close();
  first.clock.time = at("11:10:00");
  const { client, dir } = await serve(first.dir, first.clock);
  await settle(client);
  const texts = entries(client).map((entry) => [entry.kind, entry.text, entry.scheduled]);
  expect(texts).toEqual([
    ["note", `Schedule ${late} was due at 2026-11-09T11:00:00.000Z and runs late.`, undefined],
    ["user", TEXT, { schedule: late, late: true }],
    ["note", `Schedule ${skipped} was due at 2026-11-09T11:00:00.000Z, but membr was not running then, so it was skipped.`, undefined],
  ]);
  const log = new Log(defaultStore(dir));
  expect(log.lastFire(late)?.result).toBe("late");
  expect(log.lastFire(skipped)).toEqual({ at: "2026-11-09T11:00:00.000Z", result: "skipped", entry: 2 });
});

test("paused and proposed schedules never fire, and a resume does not fire the slots it missed while paused", async () => {
  const { client, clock, tools, main } = await serve();
  const paused = await schedule(client, hourly());
  expect((await act(client, { act: "pause", schedule: paused, paused: true })).answer.ok).toBe(true);
  tools.create(hourly({ text: "Proposed work." }));
  clock.until(at("11:00:30"));
  await settle(client);
  expect(fires(client)).toEqual([]);
  expect((await act(client, { act: "pause", schedule: paused, paused: false })).answer.ok).toBe(true);
  await settle(client);
  expect(fires(client)).toEqual([]);
  clock.until(at("12:00:00"));
  const fired = (await client.wait("entry", 0, (event) => event.entry.scheduled !== undefined)).entry;
  expect(fired.scheduled).toEqual({ schedule: paused, late: false });
  main.emit(END);
  await settle(client);
  expect(fires(client)).toHaveLength(1);
});

test("a schedule the agent creates is proposed with a note and its next fires, and fires as membr only after the user accepts it", async () => {
  const { client, clock, tools, main } = await serve();
  const mark = client.events.length;
  const reply = tools.create(hourly());
  const id = /^Proposed schedule (\w+)\. Next: 2026-11-09T09:00:00\.000Z, /.exec(reply)?.[1];
  expect(reply).toEndWith("It runs only after the user accepts it in a client.");
  const note = await client.wait("entry", mark, (event) => event.entry.kind === "note");
  expect(note.entry.text).toBe(`membr proposed schedule ${id}: cron "0 * * * *" UTC, as a turn. It runs only after you accept it.`);
  expect((await client.wait("schedules", mark)).schedules).toMatchObject([{ id, author: "membr", phase: "proposed", next: ["2026-11-09T09:00:00.000Z", "2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z"] }]);
  clock.until(at("09:00:30"));
  await settle(client);
  expect(fires(client)).toEqual([]);
  expect((await act(client, { act: "accept", schedule: id })).answer.ok).toBe(true);
  await settle(client);
  expect(fires(client)).toEqual([]);
  clock.until(at("10:00:00"));
  const fired = (await client.wait("entry", 0, (event) => event.entry.scheduled !== undefined)).entry;
  expect(fired).toMatchObject({ kind: "note", text: TEXT, scheduled: { schedule: id, late: false } });
  expect(main.messages.at(-1)).toEqual({ text: TEXT, priority: "now", from: "membr" });
});

test("the agent cannot cancel the user's schedule, and can cancel its own", async () => {
  const { client, tools } = await serve();
  const user = await schedule(client, hourly());
  expect(tools.cancel(user)).toBe(`Ask the user to run /unschedule ${user}.`);
  const own = /^Proposed schedule (\w+)/.exec(tools.create(hourly({ text: "Own work." })))![1]!;
  expect(tools.cancel(own)).toBe(`Cancelled schedule ${own}.`);
  expect(tools.cancel(own)).toBe(`No schedule ${own}.`);
  expect(tools.list()).toBe(`${user} active by user, cron "0 * * * *" UTC, next 2026-11-09T09:00:00.000Z: ${TEXT}`);
  await settle(client);
  expect(entries(client).map((entry) => entry.text).at(-1)).toBe(`membr cancelled schedule ${own}.`);
});

test("a run subagent schedule spawns schedule-<id> in the author's voice, its asks have the limit, and its report starts a scheduled membr turn", async () => {
  const { client, clock, engine, main } = await serve();
  const id = await schedule(client, hourly({ run: "subagent" }));
  clock.until(at("09:00:00"));
  await client.wait("entry", 0, (event) => event.entry.text === `Schedule ${id} started a subagent.`);
  const child = engine.epochs[1]!;
  expect(child.messages[0]).toEqual({ text: TEXT, priority: "now", from: "user" });
  expect(child.options.schedules).toBeUndefined();
  expect(child.options.subagents).toBeUndefined();
  await client.wait("state", 0, (event) => event.state.subagents.includes(`schedule-${id}`));

  const childAsk = settled(child.options.ask!("Bash", { command: "child" }));
  clock.advance(600_000);
  await client.wait("entry", 0, (event) => event.entry.text === DENIED);
  expect(childAsk.value).toBe(false);

  const mark = client.events.length;
  child.emit({ ...END, reply: "The inbox is read." });
  const report = await client.wait("entry", mark, (event) => event.entry.kind === "work");
  expect(report.entry.text).toBe(`[schedule-${id}] report\nSchedule ${id} started this subagent at its time, with the task the user scheduled: ${TEXT}\nTell the user what it found.\n\nThe inbox is read.\nFull chat: zoom("schedule-${id}")`);
  await client.wait("state", mark, (event) => event.state.busy);
  expect(main.messages.at(-1)).toEqual({ text: report.entry.text, priority: "now", from: "membr" });
  const mainAsk = settled(main.options.ask!("Bash", { command: "main" }));
  clock.advance(600_000);
  await settle(client);
  expect(mainAsk.value).toBe(false);
  expect(entries(client).filter((entry) => entry.text === DENIED)).toHaveLength(2);
});

test("an approval in a scheduled turn is denied at the limit, and one asked after the user joined the turn waits", async () => {
  const { client, clock, main } = await serve();
  await schedule(client, hourly());
  clock.until(at("09:00:00"));
  await client.wait("entry", 0, (event) => event.entry.scheduled !== undefined);
  const unattended = settled(main.options.ask!("Bash", { command: "first" }));
  clock.advance(600_000);
  await client.wait("entry", 0, (event) => event.entry.text === DENIED);
  expect(unattended.value).toBe(false);

  await act(client, { act: "say", text: "I am here now." });
  const attended = settled(main.options.ask!("Bash", { command: "second" }));
  clock.advance(10 * 3_600_000);
  await settle(client);
  expect(attended.value).toBeUndefined();
  const ask = client.events.findLast((event) => event.type === "ask")!;
  expect(ask).toMatchObject({ tool: "Bash", input: { command: "second" } });
  expect(client.events.some((event) => event.type === "ask-closed" && ask.type === "ask" && event.id === ask.id)).toBe(false);
  expect(entries(client).filter((entry) => entry.text === DENIED)).toHaveLength(1);
});

async function preview(client: TestClient, text: string, zone = "Europe/London") {
  const id = crypto.randomUUID(), mark = client.events.length;
  client.read({ type: "read", id, read: "when", text, zone });
  const event = await Promise.race([client.wait("when", mark, (event) => event.id === id), client.wait("error", mark, (event) => event.id === id)]);
  return { id, event };
}

test("a preview gives the user's own words without the time phrase, and the next three fires", async () => {
  const { client, engine } = await serve();
  engine.onWhen = async () => ({ when: { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" }, phrase: "every weekday 8:30" });
  const { id, event } = await preview(client, "every weekday 8:30, read the inbox notes");
  expect(event).toEqual({ type: "when", id, when: { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" }, text: "read the inbox notes", next: ["2026-11-09T08:30:00.000Z", "2026-11-10T08:30:00.000Z", "2026-11-11T08:30:00.000Z"] });
  expect(engine.whens).toEqual([{ text: "every weekday 8:30, read the inbox notes", zone: "Europe/London", now: new Date(T0) }]);
});

test("a preview joins the words around a phrase from the middle of the text", async () => {
  const { client, engine } = await serve();
  engine.onWhen = async () => ({ when: { kind: "once", at: "2026-11-09T17:00:00.000Z" }, phrase: "tomorrow at 5pm" });
  const { event } = await preview(client, "Read the notes, tomorrow at 5pm, and summarise them");
  expect(event).toMatchObject({ type: "when", text: "Read the notes and summarise them", next: ["2026-11-09T17:00:00.000Z"] });
});

test("a preview answers with an error event carrying the read id for a phrase not in the text, a bad zone, a past time and a text of only a time", async () => {
  const { client, engine } = await serve();
  const cron = { kind: "cron", expr: "0 * * * *", zone: "UTC" } as const;
  for (const [guess, text, zone, reason] of [
    [{ when: cron, phrase: "every hour" }, "read the notes daily", "UTC", '"every hour" is not in the text.'],
    [{ when: { ...cron, zone: "Mars/Olympus" }, phrase: "daily" }, "read the notes daily", "UTC", 'Unknown time zone "Mars/Olympus"'],
    [{ when: cron, phrase: "daily" }, "read the notes daily", "Mars/Olympus", 'Unknown time zone "Mars/Olympus"'],
    [{ when: { kind: "once", at: "2026-11-09T08:00:00.000Z" }, phrase: "at 8" }, "read the notes at 8", "UTC", "2026-11-09T08:00:00.000Z is not in the future."],
    [{ when: { ...cron, expr: "99 * * * *" }, phrase: "daily" }, "read the notes daily", "UTC", "Cron minute"],
    [{ when: cron, phrase: "every hour" }, "every hour", "UTC", "The text holds only a time"],
  ] as const) {
    engine.onWhen = async () => guess;
    const { id, event } = await preview(client, text, zone);
    expect(event).toMatchObject({ type: "error", id });
    expect(event.type === "error" && event.reason).toStartWith(reason);
  }
  engine.onWhen = async () => { throw new Error("The model did not answer with JSON: nope"); };
  const { id, event } = await preview(client, "read the notes daily");
  expect(event).toEqual({ type: "error", id, reason: "The model did not answer with JSON: nope" });
});
