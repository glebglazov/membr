import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Schedule, ScheduleAct } from "@membr/protocol";
import { Log } from "./src/log.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-schedules-")); dirs.push(dir); return dir; };

const schedule = (id: string, over: Partial<Schedule> = {}): Schedule => ({ id, text: "Read the inbox.", when: { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/Madrid" }, run: "turn", missed: "once", author: "user", phase: "active", since: "2026-11-06T10:00:00.000Z", ...over });
const act = (id: string, spec: Schedule): ScheduleAct => ({ type: "act", id, act: "schedule", schedule: spec });
const AT = "2026-11-09T07:30:00.000Z";

test("reopening keeps the highest revision of each schedule", () => {
  const dir = directory();
  const log = new Log(dir);
  log.saveSchedule(schedule("a"), act("1", schedule("a")));
  log.saveSchedule(schedule("b", { author: "membr", phase: "proposed" }), null);
  log.saveSchedule(schedule("a", { phase: "paused" }), { type: "act", id: "2", act: "pause", schedule: "a", paused: true });
  const reopened = new Log(dir);
  expect([...reopened.schedules.keys()].sort()).toEqual(["a", "b"]);
  expect(reopened.schedules.get("a")?.phase).toBe("paused");
  expect(reopened.schedules.get("b")?.phase).toBe("proposed");
  reopened.saveSchedule(schedule("a", { phase: "cancelled" }), null);
  expect(new Log(dir).schedules.get("a")?.phase).toBe("cancelled");
});

test("a saved act answers a retry with the same answer, and a note shows in the chat", () => {
  const dir = directory();
  const log = new Log(dir);
  const first = log.saveSchedule(schedule("a"), act("1", schedule("a")), { note: "membr proposed schedule a." });
  expect(first.answer).toEqual({ type: "answer", id: "1", ok: true, entry: 0 });
  expect(log.entries.map((entry) => [entry.kind, entry.text])).toEqual([["note", "membr proposed schedule a."]]);
  const retry = new Log(dir).saveSchedule(schedule("a", { phase: "cancelled" }), act("1", schedule("a")));
  expect(retry).toEqual({ answer: first.answer, entry: null, fresh: false });
  expect(new Log(dir).schedules.get("a")?.phase).toBe("active");
});

test("a refused act records its refusal, saves nothing, and a retry after reopen gets the same refusal", () => {
  const dir = directory();
  const log = new Log(dir);
  const refused = log.saveSchedule(null, { type: "act", id: "1", act: "accept", schedule: "gone" }, { refusal: "No schedule gone." });
  expect(refused.answer).toEqual({ type: "answer", id: "1", ok: false, reason: "No schedule gone." });
  const reopened = new Log(dir);
  expect(reopened.schedules.size).toBe(0);
  expect(reopened.answer("1")).toEqual(refused.answer!);
  expect(reopened.saveSchedule(schedule("a"), { type: "act", id: "1", act: "accept", schedule: "gone" }).answer).toEqual(refused.answer!);
  expect(reopened.schedules.size).toBe(0);
});

test("lastFire survives reopen and holds the latest fire of each schedule", () => {
  const dir = directory();
  const log = new Log(dir);
  expect(log.lastFire("a")).toBeUndefined();
  log.fire({ schedule: "a", at: "2026-11-09T07:30:00.000Z", result: "ran" }, { kind: "user", text: "Read the inbox." }, "own");
  log.fire({ schedule: "a", at: "2026-11-10T07:30:00.000Z", result: "late" }, { kind: "user", text: "Read the inbox." }, "own");
  log.fire({ schedule: "a", at: "2026-11-08T07:30:00.000Z", result: "skipped" }, { kind: "note", text: "skipped" }, null);
  log.fire({ schedule: "b", at: AT, result: "ran" }, null, null);
  for (const open of [log, new Log(dir)]) {
    expect(open.lastFire("a")).toEqual({ at: "2026-11-10T07:30:00.000Z", result: "late", entry: 1 });
    expect(open.lastFire("b")).toEqual({ at: AT, result: "ran", entry: null });
  }
});

test("a second fire with the same id returns null before and after reopen", () => {
  const dir = directory();
  const log = new Log(dir);
  const record = { schedule: "a", at: AT, result: "ran" } as const;
  const entry = log.fire(record, { kind: "user", text: "Read the inbox." }, "own");
  expect(entry).toMatchObject({ i: 0, kind: "user", text: "Read the inbox.", scheduled: { schedule: "a", late: false } });
  expect(log.answer(`schedule-a-${Date.parse(AT)}`)).toEqual({ type: "answer", id: `schedule-a-${Date.parse(AT)}`, ok: true, entry: 0 });
  expect(log.fire(record, { kind: "user", text: "Read the inbox." }, "own")).toBeNull();
  const reopened = new Log(dir);
  expect(reopened.fire(record, { kind: "user", text: "Read the inbox." }, "own")).toBeNull();
  expect(reopened.count).toBe(1);
  expect(reopened.read(0)?.scheduled).toEqual({ schedule: "a", late: false });
});

test("a turn a fire opened and a restart cut off is finished by the interrupted sweep", () => {
  const dir = directory();
  const log = new Log(dir);
  log.fire({ schedule: "a", at: AT, result: "late" }, { kind: "note", text: "Read the inbox." }, "own");
  log.fire({ schedule: "b", at: AT, result: "ran" }, { kind: "note", text: "A subagent started." }, null);
  const reopened = new Log(dir);
  expect(reopened.interrupted).toEqual([0]);
  expect(reopened.read(0)?.scheduled).toEqual({ schedule: "a", late: true });
  for (const turn of reopened.interrupted) reopened.finish(turn, "The server restarted before the turn ended.");
  expect(new Log(dir).interrupted).toEqual([]);
});
