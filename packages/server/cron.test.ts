import { expect, test } from "bun:test";
import { checkZone, fires, latestDue, parseCron, type Cron } from "./src/cron.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = Date.parse;
const iso = (times: readonly number[]) => times.map((t) => new Date(t).toISOString());
const cron = (expr: string, zone: string, after: string, count: number) => iso(fires({ kind: "cron", expr, zone }, at(after), count));

test("weekday 08:30 in Madrid keeps its wall time across both DST days", () => {
  expect(cron("30 8 * * 1-5", "Europe/Madrid", "2026-03-27T00:00:00Z", 2)).toEqual(["2026-03-27T07:30:00.000Z", "2026-03-30T06:30:00.000Z"]);
  expect(cron("30 8 * * 1-5", "Europe/Madrid", "2026-10-23T00:00:00Z", 2)).toEqual(["2026-10-23T06:30:00.000Z", "2026-10-26T07:30:00.000Z"]);
});

test("a fixed time in a gap fires when the gap ends, and in an overlap fires once at the earlier instant", () => {
  expect(cron("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z", 2)).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"]);
  expect(cron("30 2 * * *", "America/New_York", "2026-10-31T12:00:00Z", 2)).toEqual(["2026-11-01T07:30:00.000Z", "2026-11-02T07:30:00.000Z"]);
  expect(cron("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z", 2)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
});

test("hour * skips the gap and fires at both instants of the overlap", () => {
  expect(cron("*/15 * * * *", "America/New_York", "2026-03-08T06:30:00Z", 3)).toEqual(["2026-03-08T06:45:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:15:00.000Z"]);
  expect(cron("*/15 * * * *", "America/New_York", "2026-11-01T05:00:00Z", 6)).toEqual(
    ["2026-11-01T05:15:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T05:45:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T06:15:00.000Z", "2026-11-01T06:30:00.000Z"]);
});

test("Lord Howe's 30-minute shift follows the same rules", () => {
  expect(cron("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T12:00:00Z", 2)).toEqual(["2026-04-04T14:45:00.000Z", "2026-04-05T15:15:00.000Z"]);
  expect(cron("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z", 2)).toEqual(["2026-10-03T15:30:00.000Z", "2026-10-04T15:15:00.000Z"]);
  expect(cron("*/15 * * * *", "Australia/Lord_Howe", "2026-10-03T15:00:00Z", 3)).toEqual(["2026-10-03T15:15:00.000Z", "2026-10-03T15:30:00.000Z", "2026-10-03T15:45:00.000Z"]);
});

test("February 29 fires only in leap years", () => {
  expect(cron("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z", 2)).toEqual(["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
  expect(cron("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z", 1)).toEqual([]);
});

test("day of month and day of week match either one when both are set, and both when one starts with *", () => {
  const after = "2026-11-07T00:00:00Z";
  expect(cron("0 12 13 * 5", "UTC", after, 6)).toEqual(["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04", "2026-12-11", "2026-12-13"].map((d) => `${d}T12:00:00.000Z`));
  expect(cron("0 12 13 * *", "UTC", after, 2)).toEqual(["2026-11-13T12:00:00.000Z", "2026-12-13T12:00:00.000Z"]);
  expect(cron("0 12 * * 5", "UTC", after, 2)).toEqual(["2026-11-13T12:00:00.000Z", "2026-11-20T12:00:00.000Z"]);
  expect(cron("0 12 */2 * 5", "UTC", after, 2)).toEqual(["2026-11-13T12:00:00.000Z", "2026-11-27T12:00:00.000Z"]);
});

test("names, lists, steps and 7 for Sunday parse", () => {
  const parsed = parseCron("5/20 9 * jan,JUL sun-tue,7");
  const set = (field: readonly boolean[]) => field.flatMap((on, n) => on ? [n] : []);
  expect([set(parsed.minute), set(parsed.month), set(parsed.dow)]).toEqual([[5, 25, 45], [1, 7], [0, 1, 2, 7]]);
});

test("a bad field and an unknown zone give errors that name them", () => {
  expect(() => parseCron("61 * * * *")).toThrow("Cron minute");
  expect(() => parseCron("* 24 * * *")).toThrow("Cron hour");
  expect(() => parseCron("* * 0 * *")).toThrow("Cron day of month");
  expect(() => parseCron("* * * 13 *")).toThrow("Cron month");
  expect(() => parseCron("* * * * MON-FOO")).toThrow("Cron day of week");
  expect(() => parseCron("*/0 * * * *")).toThrow("Cron minute");
  expect(() => parseCron("5-1 * * * *")).toThrow("Cron minute");
  expect(() => parseCron("* * * *")).toThrow("5 fields");
  expect(() => checkZone("Mars/Base")).toThrow("Mars/Base");
  expect(() => checkZone("+02:00")).toThrow("+02:00");
  expect(checkZone("europe/madrid")).toBe("Europe/Madrid");
});

test("once fires at its time, strictly after", () => {
  const when = { kind: "once", at: "2026-11-06T15:00:00.000Z" } as const;
  expect(iso(fires(when, at("2026-11-06T14:00:00Z"), 3))).toEqual([when.at]);
  expect(fires(when, at(when.at), 3)).toEqual([]);
  expect(latestDue(when, at("2026-11-06T14:00:00Z"), at(when.at))).toBe(at(when.at));
  expect(latestDue(when, at(when.at), at("2026-11-07T00:00:00Z"))).toBeNull();
});

test("latestDue after a 7-day gap gives only the newest fire, fast", () => {
  const after = at("2026-10-20T10:07:00Z"), upto = after + 7 * DAY;
  const started = performance.now();
  expect(latestDue({ kind: "cron", expr: "*/15 * * * *", zone: "Europe/London" }, after, upto)).toBe(at("2026-10-27T10:00:00Z"));
  expect(latestDue({ kind: "cron", expr: "* * * * *", zone: "Europe/London" }, after, upto)).toBe(upto);
  expect(latestDue({ kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" }, after, upto)).toBe(at("2026-10-27T08:30:00Z"));
  expect(performance.now() - started).toBeLessThan(100);
  expect(latestDue({ kind: "cron", expr: "0 9 * * *", zone: "Europe/London" }, upto - 5 * MINUTE, upto)).toBeNull();
});

// The oracle walks every minute and reads the wall clock with Intl, then applies ISC cron(8) to what it sees:
// a wall time seen again is an overlap, and wall times jumped over are a gap that fires at the first minute after it.
function clock(zone: string): (t: number) => number {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  return (t) => {
    const p = Object.fromEntries(format.formatToParts(t).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
}
function matches(c: Cron, local: number): boolean {
  const d = new Date(local);
  const dom = c.dom[d.getUTCDate()], dow = c.dow[d.getUTCDay()];
  return c.minute[d.getUTCMinutes()] && c.hour[d.getUTCHours()] && c.month[d.getUTCMonth() + 1] && (c.anyDom || c.anyDow ? dom && dow : dom || dow);
}
function oracle(c: Cron, local: (t: number) => number, from: number, to: number): number[] {
  const out: number[] = [], seen = new Set<number>();
  let previous = local(from - MINUTE);
  for (let t = from; t < to; t += MINUTE) {
    const now = local(t);
    let fire = matches(c, now) && (c.anyHour || !seen.has(now));
    if (!c.anyHour) for (let skipped = previous + MINUTE; skipped < now; skipped += MINUTE) fire ||= matches(c, skipped);
    if (fire) out.push(t);
    seen.add(now);
    previous = now;
  }
  return out;
}

const ZONES = { "Europe/London": 2, "America/New_York": 2, "Australia/Lord_Howe": 2, "Asia/Kolkata": 0 };
const EXPRESSIONS = ["30 2 * * *", "*/15 * * * *", "30 8 * * 1-5", "45 1 * * *", "0 * * * *", "15,45 1-3 * * 0"];

test("fires agrees with a minute-by-minute Intl walk across the 2026 DST changes", () => {
  for (const [zone, changes] of Object.entries(ZONES)) {
    const local = clock(zone);
    const windows: [number, number][] = [];
    for (let t = at("2026-01-01T00:00:00Z"); t < at("2027-01-01T00:00:00Z"); t += 60 * MINUTE)
      if (local(t + 60 * MINUTE) - local(t) !== 60 * MINUTE) windows.push([t - 2 * DAY, t + 2 * DAY]);
    expect(windows.length).toBe(changes);
    windows.push([at("2026-06-01T00:00:00Z"), at("2026-06-03T00:00:00Z")], [at("2028-02-27T00:00:00Z"), at("2028-03-02T00:00:00Z")]);
    for (const expr of [...EXPRESSIONS, "0 0 29 2 *"]) for (const [from, to] of windows) {
      const expected = oracle(parseCron(expr), local, from, to);
      const actual = fires({ kind: "cron", expr, zone }, from - MINUTE, expected.length + 1);
      expect({ zone, expr, fires: iso(actual.slice(0, expected.length)) }).toEqual({ zone, expr, fires: iso(expected) });
      expect(actual[expected.length]).toBeGreaterThanOrEqual(to);
    }
  }
});
