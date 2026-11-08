import type { Time } from "@membr/protocol";

type Field = readonly boolean[];
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; anyDom: boolean; anyDow: boolean; anyHour: boolean };
type Spec = { name: string; min: number; max: number; names?: readonly string[] };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAYS = 8 * 366;
const FIELDS: readonly Spec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

function parseField(text: string, { name, min, max, names }: Spec): boolean[] {
  const set = new Array<boolean>(max + 1).fill(false);
  const value = (raw: string): number => {
    const index = names?.indexOf(raw.toUpperCase()) ?? -1;
    const n = index >= 0 ? index + min : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= min && n <= max)) throw new Error(`Cron ${name}: "${raw}" is not a value from ${min} to ${max}`);
    return n;
  };
  for (const item of text.split(",")) {
    const [range = "", step, extra] = item.split("/");
    const by = step === undefined ? 1 : /^\d+$/.test(step) ? Number(step) : 0;
    if (extra !== undefined || by < 1) throw new Error(`Cron ${name}: "${item}" has a bad step`);
    const bounds = range === "*" ? [min, max] : range.split("-").map(value);
    // "5/10" is cronie's short form of "5-max/10".
    const [from, to = step === undefined ? from : max] = bounds;
    if (bounds.length > 2 || from > to) throw new Error(`Cron ${name}: "${item}" is not a range`);
    for (let n = from; n <= to; n += by) set[n] = true;
  }
  return set;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron "${expr}" needs 5 fields: minute, hour, day of month, month, day of week`);
  const [minute, hour, dom, month, dow] = parts.map((part, i) => parseField(part, FIELDS[i]));
  dow[0] ||= dow[7];
  // Vixie cron counts a field as * when it starts with *, so "*/2" is * too.
  return { minute, hour, dom, month, dow, anyDom: parts[2].startsWith("*"), anyDow: parts[4].startsWith("*"), anyHour: parts[1].startsWith("*") };
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let found = formats.get(zone);
  if (!found) formats.set(zone, found = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }));
  return found;
}

// Intl accepts "+02:00" too, but a fixed offset does not move with DST, so only a name is a zone here.
export function checkZone(zone: string): string {
  try { if (!/^[+-]/.test(zone)) return format(zone).resolvedOptions().timeZone; } catch {}
  throw new Error(`Unknown time zone "${zone}": give an IANA name such as Europe/Madrid`);
}

// The wall clock in zone at instant t, written as if it were UTC.
function wall(t: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const { type, value } of format(zone).formatToParts(t)) parts[type] = Number(value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
function offset(t: number, zone: string): number { const second = Math.floor(t / 1000) * 1000; return wall(second, zone) - second; }
function localDay(t: number, zone: string): number { return Math.floor(wall(t, zone) / DAY) * DAY; }

// The first instant with the new offset, between lo (old offset) and hi (new offset).
function shift(lo: number, hi: number, zone: string): number {
  const old = offset(lo, zone);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offset(mid, zone) === old) lo = mid; else hi = mid;
  }
  return hi;
}

// ISC cron(8): a wall time in a DST gap fires when the gap ends, and one in an overlap fires once, at the earlier
// instant. A job with hour * runs every hour anyway, so it skips the gap and fires at both instants of the overlap.
function instants(local: number, zone: string, before: number, after: number, anyHour: boolean): number[] {
  const found = [...new Set([local - before, local - after])].filter((t) => t + offset(t, zone) === local).sort((a, b) => a - b);
  if (found.length === 0) return anyHour ? [] : [shift(local - after, local - before, zone)];
  return anyHour ? found : found.slice(0, 1);
}

// The fires of one local day, ascending; start is its midnight written as UTC. Gap times can share an instant.
function day(cron: Cron, zone: string, start: number): number[] {
  const date = new Date(start);
  const dom = cron.dom[date.getUTCDate()], dow = cron.dow[date.getUTCDay()];
  if (!cron.month[date.getUTCMonth() + 1] || !(cron.anyDom || cron.anyDow ? dom && dow : dom || dow)) return [];
  // Offsets span -12h to +14h, so these two instants bound every instant of the day.
  const before = offset(start - 15 * HOUR, zone), after = offset(start + 39 * HOUR, zone);
  const out: number[] = [];
  for (let h = 0; h < 24; h++) if (cron.hour[h]) for (let m = 0; m < 60; m++) if (cron.minute[m]) {
    const local = start + h * HOUR + m * MINUTE;
    if (before === after) out.push(local - before); else out.push(...instants(local, zone, before, after, cron.anyHour));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Fires strictly after `after`, ascending, at most count. A cron with no fire in 8 years has none.
export function fires(when: Time, after: number, count: number): number[] {
  if (when.kind === "once") { const at = Date.parse(when.at); return at > after && count > 0 ? [at] : []; }
  const cron = parseCron(when.expr), out: number[] = [];
  const first = localDay(after, when.zone) - DAY;
  for (let start = first; out.length < count && start < first + DAYS * DAY; start += DAY)
    for (const t of day(cron, when.zone, start)) if (t > (out.at(-1) ?? after) && out.length < count) out.push(t);
  return out;
}

// The latest fire t with after < t <= upto, or null. It walks back from upto, so a week of downtime costs days, not fires.
export function latestDue(when: Time, after: number, upto: number): number | null {
  if (when.kind === "once") { const at = Date.parse(when.at); return after < at && at <= upto ? at : null; }
  const cron = parseCron(when.expr), top = localDay(upto, when.zone) + DAY;
  const last = Math.max(localDay(after, when.zone) - DAY, top - DAYS * DAY);
  for (let start = top; start >= last; start -= DAY) {
    const due = day(cron, when.zone, start).filter((t) => t > after && t <= upto);
    if (due.length > 0) return due[due.length - 1];
  }
  return null;
}
