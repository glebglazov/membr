import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("the protocol has no runtime dependencies", async () => {
  const pkg = await Bun.file(path.join(import.meta.dir, "package.json")).json();
  expect(pkg.dependencies ?? {}).toEqual({});
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(import.meta.dir)) {
    const source = fs.readFileSync(path.join(import.meta.dir, file), "utf8");
    for (const { path: spec } of transpiler.scanImports(source)) {
      expect(spec).toStartWith(".");
    }
  }
});

test("state events parse optional epoch usage and reject invalid counts", async () => {
  const { parseEvent } = await import("./src/index.ts");
  const state = { busy: false, wait: "", goal: null, pick: null, agents: [], usage: null };
  const usage = { input: 100, cacheRead: 700, cacheWrite: 200, output: 50 };
  expect(parseEvent({ type: "state", state })).toEqual({ type: "state", state });
  expect(parseEvent({ type: "state", state: { ...state, epoch: usage } })).toEqual({ type: "state", state: { ...state, epoch: usage } });
  expect(() => parseEvent({ type: "state", state: { ...state, epoch: { ...usage, input: -1 } } })).toThrow("Expected a nonnegative integer");
});

test("skills events parse each skill and reject a nameless one", async () => {
  const { parseEvent } = await import("./src/index.ts");
  const skills = [{ name: "pdf", description: "Read a PDF.", argumentHint: "<file>" }];
  expect(parseEvent({ type: "skills", skills })).toEqual({ type: "skills", skills });
  expect(() => parseEvent({ type: "skills", skills: [{ ...skills[0], name: "" }] })).toThrow();
});

const spec = { text: "Read the inbox.", when: { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/Madrid" }, run: "agent", missed: "once" } as const;

test("schedule acts and the when read round trip, and isScheduleAct agrees with SCHEDULE_ACTS", async () => {
  const { parseClientMessage, isScheduleAct, SCHEDULE_ACTS } = await import("./src/index.ts");
  const acts = [
    { type: "act", id: "a", act: "schedule", schedule: spec },
    { type: "act", id: "b", act: "schedule", schedule: { ...spec, when: { kind: "once", at: "2026-11-09T07:30:00.000Z" } } },
    { type: "act", id: "c", act: "unschedule", schedule: "k3x9q2" },
    { type: "act", id: "d", act: "pause", schedule: "k3x9q2", paused: true },
    { type: "act", id: "e", act: "accept", schedule: "k3x9q2" },
  ] as const;
  for (const act of acts) {
    expect(parseClientMessage(act)).toEqual(act);
    expect(isScheduleAct(parseClientMessage(act))).toBe(true);
  }
  expect(SCHEDULE_ACTS).toEqual(["schedule", "unschedule", "pause", "accept"]);
  const read = { type: "read", id: "r", read: "when", text: "every weekday 8:30", zone: "Europe/Madrid" } as const;
  expect(parseClientMessage(read)).toEqual(read);
  expect(isScheduleAct(parseClientMessage(read))).toBe(false);
  expect(isScheduleAct(parseClientMessage({ type: "act", id: "s", act: "say", text: "hi" }))).toBe(false);
});

test("schedule messages refuse a bad shape", async () => {
  const { parseClientMessage } = await import("./src/index.ts");
  const act = (schedule: unknown) => ({ type: "act", id: "a", act: "schedule", schedule });
  expect(() => parseClientMessage(act({ ...spec, when: { kind: "daily", at: "08:30" } }))).toThrow("Unknown when");
  expect(() => parseClientMessage(act({ ...spec, when: { kind: "once", at: "tomorrow" } }))).toThrow("Expected a date");
  expect(() => parseClientMessage(act({ ...spec, when: { kind: "cron", expr: "* * * * *" } }))).toThrow("Expected a string");
  expect(() => parseClientMessage(act({ ...spec, run: "now" }))).toThrow("Expected one of turn, agent");
  expect(() => parseClientMessage(act({ ...spec, missed: undefined }))).toThrow("Expected a string");
  expect(() => parseClientMessage({ type: "act", id: "a", act: "pause", schedule: "k" })).toThrow("Expected a boolean");
  expect(() => parseClientMessage({ type: "act", id: "a", act: "accept", schedule: "" })).toThrow("Expected an id");
  expect(() => parseClientMessage({ type: "read", id: "r", read: "when", text: "x" })).toThrow("Expected a string");
});

test("schedules and when events round trip, and a view refuses an unknown phase", async () => {
  const { parseEvent } = await import("./src/index.ts");
  const view = { ...spec, id: "k3x9q2", author: "user", phase: "active", since: "2026-11-06T10:00:00.000Z", next: ["2026-11-09T07:30:00.000Z"], last: { at: "2026-11-06T07:30:00.000Z", result: "late", entry: 4 } } as const;
  const schedules = { type: "schedules", schedules: [view, { ...view, id: "p7a01c", author: "membr", phase: "done", last: null, next: [] }] } as const;
  expect<unknown>(parseEvent(schedules)).toEqual(schedules);
  expect(() => parseEvent({ ...schedules, schedules: [{ ...view, phase: "gone" }] })).toThrow("Expected one of");
  expect(() => parseEvent({ ...schedules, schedules: [{ ...view, last: { ...view.last, result: "fired" } }] })).toThrow("Expected one of ran, late, skipped");
  const when = { type: "when", id: "r", when: spec.when, text: "read the inbox", next: ["2026-11-09T07:30:00.000Z"] } as const;
  expect<unknown>(parseEvent(when)).toEqual(when);
  expect(() => parseEvent({ ...when, when: { kind: "cron", zone: "UTC" } })).toThrow("Expected a string");
});

test("parseSchedule keeps a stored schedule and entries keep their scheduled mark", async () => {
  const { parseSchedule, parseEntry } = await import("./src/index.ts");
  const schedule = { ...spec, id: "k3x9q2", author: "membr", phase: "proposed", since: "2026-11-06T10:00:00.000Z" } as const;
  expect(parseSchedule(schedule)).toEqual(schedule);
  expect(() => parseSchedule({ ...schedule, phase: "done" })).toThrow("Expected one of");
  expect(() => parseSchedule({ ...schedule, author: "agent" })).toThrow("Expected one of user, membr");
  const entry = { i: 3, kind: "user", text: "Read the inbox.", date: "2026-11-06T07:30:00.000Z", from: { machine: "m", seq: 3 } } as const;
  expect(parseEntry({ ...entry, scheduled: { schedule: "k3x9q2", late: true } })).toEqual({ ...entry, scheduled: { schedule: "k3x9q2", late: true } });
  expect(parseEntry(entry)).toEqual(entry);
  expect(() => parseEntry({ ...entry, scheduled: { schedule: "k3x9q2" } })).toThrow("Expected a boolean");
});
