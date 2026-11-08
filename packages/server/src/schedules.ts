import { WATCH_QUIET, type Answer, type Entry, type Event, type Read, type Schedule, type ScheduleAct, type ScheduleSpec, type ScheduleView, type When } from "@membr/protocol";
import { type Clock, systemClock } from "./clock.ts";
import { checkZone, fires, latestDue, parseCron } from "./cron.ts";
import type { Engine } from "./engine.ts";
import type { Log } from "./log.ts";
import { BURST, Watcher, type WatchEvent } from "./watcher.ts";

// event is set for a watch fire: what its command printed, or how it ended.
export type Fire = { schedule: Schedule; at: number; late: boolean; event?: Exclude<WatchEvent, { kind: "burst" }> };
// fire: Chat answers "wait" when it cannot start this run now, and a later tick tries again.
// record: the notes Schedules writes reach the view and the clients through Chat, like every entry.
// home: the directory a watch's command runs in. store: the agent's store, which holds the watches' process ids.
export type ChatPort = { fire(fire: Fire): "started" | "wait"; record(entry: Entry): void; home(): string; store: string };
export type ScheduleTools = { create(spec: ScheduleSpec): string; list(): string; cancel(id: string): string };

// After a Mac sleeps, ticks resume within a minute of the wake.
const CAP = 60_000;
// A due fire noticed later than this, and not already waiting for a busy chat, was missed.
const GRACE = 120_000;

const iso = (t: number) => new Date(t).toISOString();
const describe = (when: When) => when.kind === "once" ? `once at ${when.at}` : when.kind === "cron" ? `cron "${when.expr}" ${when.zone}` : `watch on ${when.on}: ${when.command}`;
// A watch has no times: it fires when its command prints or exits.
const next = (when: When, now: number, count: number) => when.kind === "watch" ? [] : fires(when, now, count);

// A schedule must name a task and fire at least once after now. A bad cron field or zone throws with its name.
function check(spec: ScheduleSpec, now: number): void {
  if (!spec.text.trim()) throw new Error("A schedule needs a task.");
  if (spec.when.kind === "watch") {
    if (!spec.when.command.trim()) throw new Error("A watch needs a command.");
    if (spec.when.quiet < WATCH_QUIET.min || spec.when.quiet > WATCH_QUIET.max) throw new Error(`A watch's quiet is ${WATCH_QUIET.min} to ${WATCH_QUIET.max} seconds.`);
    return;
  }
  if (spec.when.kind === "cron") { parseCron(spec.when.expr); checkZone(spec.when.zone); }
  if (!fires(spec.when, now, 1).length) throw new Error(spec.when.kind === "once" ? `${spec.when.at} is not in the future.` : `Cron "${spec.when.expr}" never fires.`);
}

const span = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const block = (lines: string[], dropped: number) => (dropped ? [`(${dropped} earlier lines dropped)`] : []).concat(lines).map((line) => "  " + line).join("\n");

// The message a watch fire sends: what happened, the output, then the task the watch was made for.
export function tell(s: Schedule, event: Exclude<WatchEvent, { kind: "burst" }>): string {
  if (event.kind === "lines") {
    const quiet = s.when.kind === "watch" ? s.when.quiet : 0;
    return `Watch ${s.id} printed ${event.lines.length + event.dropped} new lines:\n${block(event.lines, event.dropped)}\nTask: ${s.text}\nThe watch goes on; its next fire comes no sooner than ${span(quiet * 1000)} from now.`;
  }
  const { code, signal, after, stderr } = event.exit;
  const how = code !== null ? `exited with code ${code}` : signal ? `was ended by ${signal}` : "could not start";
  const output = event.lines.length ? `\nLast output:\n${block(event.lines, event.dropped)}` : "\nIt printed nothing.";
  const errors = code !== 0 && stderr.length ? `\nLast errors:\n${block(stderr, 0)}` : "";
  return `Watch ${s.id} ended: the command ${how} after ${span(after)}.${output}${errors}\nTask: ${s.text}\nThe watch is done.`;
}

// The text without the time phrase, with the words on both sides joined by one space.
function cut(text: string, phrase: string): string {
  const at = phrase ? text.indexOf(phrase) : -1;
  if (at < 0) throw new Error(`"${phrase}" is not in the text.`);
  const task = [text.slice(0, at).replace(/[\s,]+$/, ""), text.slice(at + phrase.length).replace(/^[\s,]+/, "")].filter(Boolean).join(" ");
  if (!task) throw new Error("The text holds only a time, with no task.");
  return task;
}

export class Schedules {
  readonly tools: ScheduleTools;
  // The schedules whose due fire the chat could not take yet. late is decided once, when the fire is first noticed.
  private readonly waiting = new Map<string, { due: number; late: boolean }>();
  private readonly watcher: Watcher;
  private stopWake: (() => void) | null = null;
  private poked = false;
  private closed = false;

  constructor(private readonly log: Log, private readonly engine: Engine, private readonly chat: ChatPort, private readonly emit: (event: Event) => void, private readonly clock: Clock = systemClock) {
    this.watcher = new Watcher(chat.store, () => this.chat.home(), (id, event) => this.deliver(id, event), () => this.emit(this.event), clock);
    this.tools = {
      create: (spec) => {
        const now = this.clock.now();
        check(spec, now);
        const value: Schedule = { ...spec, id: this.newId(), author: "membr", phase: "proposed", since: iso(now) };
        this.save(value, `membr proposed schedule ${value.id}: ${describe(value.when)}, as a ${value.run === "turn" ? "turn" : "subagent"}. It runs only after you accept it.`);
        const when = value.when.kind === "watch" ? `Its command: ${value.when.command}` : `Next: ${fires(value.when, now, 3).map(iso).join(", ")}.`;
        return `Proposed schedule ${value.id}. ${when}\nIt runs only after the user accepts it in a client.`;
      },
      list: () => {
        const lines = [...this.event.schedules].filter((s) => s.phase !== "cancelled").map((s) => `${s.id} ${s.phase} by ${s.author}, ${describe(s.when)}, ${s.when.kind === "watch" ? (s.running ? "running" : "not running") : `next ${s.next[0] ?? "none"}`}: ${s.text}`);
        return lines.length ? lines.join("\n") : "No schedules.";
      },
      cancel: (id) => {
        const s = this.log.schedules.get(id);
        if (!s || s.phase === "cancelled") return `No schedule ${id}.`;
        if (s.author === "user") return `Ask the user to run /unschedule ${id}.`;
        this.save({ ...s, phase: "cancelled" }, `membr cancelled schedule ${id}.`);
        return `Cancelled schedule ${id}.`;
      },
    };
    this.restart();
    this.poke();
  }

  get event(): Extract<Event, { type: "schedules" }> {
    const now = this.clock.now();
    return { type: "schedules", schedules: [...this.log.schedules.values()].map((s): ScheduleView => {
      const last = this.log.lastFire(s.id) ?? null;
      const done = s.when.kind === "once" && last !== null || last?.result === "ended";
      return { ...s, phase: done ? "done" : s.phase, next: (s.phase === "active" || s.phase === "proposed") && !done ? next(s.when, now, 3).map(iso) : [], last, running: this.watcher.running(s.id) };
    }) };
  }

  act(act: ScheduleAct): Answer {
    const previous = this.log.answer(act.id);
    if (previous) return previous;
    let value: Schedule | null = null, refusal: string | undefined;
    try { value = this.change(act, this.clock.now()); }
    catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    const { answer } = this.log.saveSchedule(value, act, refusal === undefined ? {} : { refusal });
    if (refusal === undefined) { this.watcher.sync(this.wanted()); this.emit(this.event); this.poke(); }
    return answer!;
  }

  // The user's words as a proposal: the model names the time phrase, and the task is the text without it, so the
  // task stays the user's own words. Any failure goes back as an error event with the read's id.
  async preview({ id, text, zone }: Extract<Read, { read: "when" }>): Promise<Extract<Event, { type: "when" | "error" }>> {
    try {
      const now = this.clock.now();
      const guess = await this.engine.when(text, checkZone(zone), new Date(now));
      const { when } = guess;
      if (when.kind === "cron") { parseCron(when.expr); checkZone(when.zone); }
      const next = fires(when, now, 3);
      if (!next.length) throw new Error(when.kind === "once" ? `${when.at} is not in the future.` : `Cron "${when.expr}" never fires.`);
      return { type: "when", id, when, text: cut(text, guess.phrase), next: next.map(iso) };
    } catch (error) {
      return { type: "error", id, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // A microtask, not a direct tick: Chat pokes from inside its own transitions, and a fire starts a new one.
  poke(): void {
    if (this.poked || this.closed) return;
    this.poked = true;
    queueMicrotask(() => { this.poked = false; this.tick(); this.watcher.poke(); });
  }

  close(): void {
    this.closed = true;
    this.stopWake?.();
    this.watcher.close();
  }

  // The active watches whose command has not ended. Every change of a schedule converges the Watcher on them.
  private wanted(): Schedule[] {
    return [...this.log.schedules.values()].filter((s) => s.when.kind === "watch" && s.phase === "active" && this.log.lastFire(s.id)?.result !== "ended");
  }

  // membr was down while these watches were active, so their commands stopped and their output then is lost.
  private restart(): void {
    for (const s of this.wanted()) {
      if (s.missed === "skip") this.save({ ...s, phase: "paused" }, `Watch ${s.id} was active when membr stopped, so it is paused.`, false);
      else this.chat.record(this.log.append("note", `Watch ${s.id} started again after membr restarted. What its command printed while membr was down was not seen.`));
    }
    this.watcher.sync(this.wanted());
  }

  // A burst pauses the watch with one note. A fire's record and entry are written by Chat, in one log line.
  private deliver(id: string, event: WatchEvent): "started" | "wait" {
    const s = this.log.schedules.get(id);
    if (!s || this.closed) return "wait";
    if (event.kind === "burst") {
      this.save({ ...s, phase: "paused" }, `Watch ${s.id} fired more than ${BURST} times in an hour, so membr paused it. ${event.dropped} lines were not sent. Resume it in a client, or ask for a quieter command.`);
      return "started";
    }
    // Each fire of a watch gets its own millisecond, because the time is in the fire's act id.
    const last = Date.parse(this.log.lastFire(id)?.at ?? "");
    const answer = this.chat.fire({ schedule: s, at: Number.isNaN(last) ? this.clock.now() : Math.max(this.clock.now(), last + 1), late: false, event });
    if (answer === "started") {
      if (event.kind === "ended") this.watcher.sync(this.wanted());
      this.emit(this.event);
    }
    return answer;
  }

  // The schedule after a user's act, or a throw with the refusal. since moves on accept and resume, so the slots
  // before them never count as missed.
  private change(act: ScheduleAct, now: number): Schedule {
    if (act.act === "schedule") {
      check(act.schedule, now);
      return { ...act.schedule, id: this.newId(), author: "user", phase: "active", since: iso(now) };
    }
    const s = this.log.schedules.get(act.schedule);
    if (!s || s.phase === "cancelled") throw new Error(`No schedule ${act.schedule}.`);
    switch (act.act) {
      case "unschedule": return { ...s, phase: "cancelled" };
      case "accept":
        if (s.phase !== "proposed") throw new Error(`Schedule ${s.id} is ${s.phase}, not proposed.`);
        check(s, now);
        return { ...s, phase: "active", since: iso(now) };
      case "pause":
        if (s.phase === "proposed") throw new Error(`Schedule ${s.id} is proposed: accept it first.`);
        if (act.paused) return { ...s, phase: "paused" };
        check(s, now);
        return { ...s, phase: "active", since: iso(now) };
    }
  }

  private save(value: Schedule, note: string, sync = true): void {
    const { entry } = this.log.saveSchedule(value, null, { note });
    if (entry) this.chat.record(entry);
    if (sync) this.watcher.sync(this.wanted());
    this.emit(this.event);
    this.poke();
  }

  // Only the newest due fire counts: older ones coalesce into it, so nothing queues while the chat is busy.
  private tick(): void {
    if (this.closed) return;
    const now = this.clock.now();
    let changed = false;
    for (const s of this.log.schedules.values()) {
      if (s.phase !== "active" || s.when.kind === "watch") continue;
      try {
        const due = latestDue(s.when, Math.max(Date.parse(s.since), Date.parse(this.log.lastFire(s.id)?.at ?? s.since)), now);
        if (due === null) { this.waiting.delete(s.id); continue; }
        const waiting = this.waiting.get(s.id);
        const late = waiting?.due === due ? waiting.late : !waiting && now - due > GRACE;
        if (late && s.missed === "skip") {
          const entry = this.log.fire({ schedule: s.id, at: iso(due), result: "skipped" }, { kind: "note", text: `Schedule ${s.id} was due at ${iso(due)}, but membr was not running then, so it was skipped.` }, null);
          if (entry) this.chat.record(entry);
          this.waiting.delete(s.id);
          changed = true;
        } else if (this.chat.fire({ schedule: s, at: due, late }) === "started") {
          this.waiting.delete(s.id);
          changed = true;
        } else this.waiting.set(s.id, { due, late });
      } catch (error) {
        this.emit({ type: "error", id: null, reason: `Schedule ${s.id} failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (changed) this.emit(this.event);
    this.arm(now);
  }

  private arm(now: number): void {
    this.stopWake?.();
    this.stopWake = null;
    const due = [...this.log.schedules.values()].filter((s) => s.phase === "active").flatMap((s) => next(s.when, now, 1));
    if (due.length) this.stopWake = this.clock.wake(Math.min(CAP, Math.min(...due) - now), () => this.tick());
  }

  private newId(): string {
    for (;;) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join("");
      if (!this.log.schedules.has(id)) return id;
    }
  }
}
