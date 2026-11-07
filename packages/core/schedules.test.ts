import { expect, test } from "bun:test";
import type { ScheduleView, When } from "@membr/protocol";
import { act, clientZone, complete, createModel, fireTime, hear } from "./src/index.ts";

const cron: When = { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" };
const view = (id: string, phase: ScheduleView["phase"], extra: Partial<ScheduleView> = {}): ScheduleView => ({
  id, text: "read the inbox notes", when: cron, run: "subagent", missed: "once", author: "user", phase, since: "2026-11-06T09:00:00.000Z", next: [], last: null, ...extra,
});
const ready = () => hear(createModel(), { type: "ready", version: "1.0" });

test("S5 /schedule reads the time with the client's zone, then accept sends the proposal with the defaults", () => {
  const asked = act(ready(), { type: "send", id: "w1", text: "/schedule every weekday 8:30 read the inbox notes" });
  expect(asked.reads).toEqual([{ type: "read", read: "when", id: "w1", text: "every weekday 8:30 read the inbox notes", zone: clientZone() }]);
  expect(asked.model.preview).toEqual({ id: "w1", text: "every weekday 8:30 read the inbox notes", proposal: null });
  expect(act(asked.model, { type: "schedule-accept", id: "s1" }).acts).toEqual([]);

  const heard = hear(asked.model, { type: "when", id: "w1", when: cron, text: "read the inbox notes", next: ["2026-11-09T08:30:00.000Z"] });
  expect(heard.reads.size).toBe(0);
  expect(heard.preview?.proposal).toEqual({ when: cron, text: "read the inbox notes", next: ["2026-11-09T08:30:00.000Z"] });

  const accepted = act(heard, { type: "schedule-accept", id: "s1" });
  expect(accepted.acts).toEqual([{ type: "act", act: "schedule", id: "s1", schedule: { text: "read the inbox notes", when: cron, run: "subagent", missed: "once" } }]);
  expect(accepted.model.preview).not.toBeNull();
  expect(hear(accepted.model, { type: "answer", id: "s1", ok: true, entry: null }).preview).toBeNull();
});

test("S5 accept sends the chosen run and missed, and a refused schedule keeps the preview", () => {
  let model = act(ready(), { type: "schedule-preview", id: "w1", text: "x", zone: "UTC" }).model;
  model = hear(model, { type: "when", id: "w1", when: cron, text: "x", next: [] });
  const accepted = act(model, { type: "schedule-accept", id: "s1", run: "turn", missed: "skip" });
  expect(accepted.acts[0]).toMatchObject({ act: "schedule", schedule: { run: "turn", missed: "skip" } });
  const refused = hear(accepted.model, { type: "answer", id: "s1", ok: false, reason: "No." });
  expect(refused.preview?.proposal).not.toBeNull();
  expect(refused.error).toBe("No.");
});

test("S5 a time the model cannot read clears the preview and shows the reason; discard drops the read", () => {
  const asked = act(ready(), { type: "send", id: "w1", text: "/schedule sometime" });
  const failed = hear(asked.model, { type: "error", id: "w1", reason: "The model did not answer with JSON." });
  expect(failed.preview).toBeNull();
  expect(failed.error).toBe("The model did not answer with JSON.");
  const dropped = act(asked.model, { type: "schedule-discard" }).model;
  expect(dropped.preview).toBeNull();
  expect(dropped.reads.size).toBe(0);
});

test("S5 the schedules event replaces the list, and the id commands act on a schedule by id or number", () => {
  let model = hear(ready(), { type: "schedules", schedules: [view("aaa111", "proposed", { author: "membr" }), view("bbb222", "active"), view("ccc333", "cancelled")] });
  expect(model.schedules.map((s) => s.id)).toEqual(["aaa111", "bbb222", "ccc333"]);
  const sent = (text: string) => act(model, { type: "send", id: "c1", text }).acts;
  expect(sent("/accept aaa111")).toEqual([{ type: "act", act: "accept", id: "c1", schedule: "aaa111" }]);
  expect(sent("/pause 2")).toEqual([{ type: "act", act: "pause", id: "c1", schedule: "bbb222", paused: true }]);
  expect(sent("/resume bbb222")).toEqual([{ type: "act", act: "pause", id: "c1", schedule: "bbb222", paused: false }]);
  expect(sent("/unschedule bbb222")).toEqual([{ type: "act", act: "unschedule", id: "c1", schedule: "bbb222" }]);
  expect(sent("/unschedule nope")).toEqual([]);
  expect(act(model, { type: "send", id: "c1", text: "/unschedule nope" }).model.error).toContain("/schedules");
  expect(act(model, { type: "schedule-act", id: "c2", schedule: "bbb222", change: "pause" }).acts).toEqual([{ type: "act", act: "pause", id: "c2", schedule: "bbb222", paused: true }]);
  model = act(model, { type: "send", id: "c3", text: "/schedules" }).model;
  expect(model.info).toContain('1. aaa111  cron "30 8 * * 1-5" Europe/London  proposed, subagent, by membr');
  expect(model.info).toContain("2. bbb222");
  expect(model.info).not.toContain("ccc333");
});

test("S5 / offers the schedule commands, and a time shows in the zone of its schedule", () => {
  const names = complete(createModel(), "/sch").commands.map((command) => command.name);
  expect(names).toEqual(["/schedule", "/schedules", "/unschedule"]);
  expect(complete(createModel(), "/un").commands.map((command) => command.name)).toContain("/unschedule");
  expect(fireTime("2026-11-09T08:30:00.000Z", "Europe/London", Date.parse("2026-11-06T12:00:00Z"))).toBe("Mon 08:30");
  expect(fireTime("2026-07-09T07:30:00.000Z", "Europe/London", Date.parse("2026-07-06T12:00:00Z"))).toBe("Thu 08:30");
  expect(fireTime("2027-01-09T08:30:00.000Z", "Europe/London", Date.parse("2026-11-06T12:00:00Z"))).toBe("9 Jan 08:30");
});
