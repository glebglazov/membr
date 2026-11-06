import type { Answer, Entry, Event, Read, Schedule, ScheduleAct, ScheduleSpec, ScheduleView, When } from "@membr/protocol";
import { type Clock, systemClock } from "./clock.ts";
import { checkZone, fires, latestDue, parseCron } from "./cron.ts";
import type { Engine } from "./engine.ts";
import type { Log } from "./log.ts";

export type Fire = { schedule: Schedule; at: number; late: boolean };
// fire: Chat answers "wait" when it cannot start this run now, and a later tick tries again.
// record: the notes Schedules writes reach the view and the clients through Chat, like every entry.
export type ChatPort = { fire(fire: Fire): "started" | "wait"; record(entry: Entry): void };
export type ScheduleTools = { create(spec: ScheduleSpec): string; list(): string; cancel(id: string): string };

// After a Mac sleeps, ticks resume within a minute of the wake.
const CAP = 60_000;
// A due fire noticed later than this, and not already waiting for a busy chat, was missed.
const GRACE = 120_000;

const iso = (t: number) => new Date(t).toISOString();
const describe = (when: When) => when.kind === "once" ? `once at ${when.at}` : `cron "${when.expr}" ${when.zone}`;

// A schedule must name a task and fire at least once after now. A bad cron field or zone throws with its name.
function check(spec: ScheduleSpec, now: number): void {
  if (!spec.text.trim()) throw new Error("A schedule needs a task.");
  if (spec.when.kind === "cron") { parseCron(spec.when.expr); checkZone(spec.when.zone); }
  if (!fires(spec.when, now, 1).length) throw new Error(spec.when.kind === "once" ? `${spec.when.at} is not in the future.` : `Cron "${spec.when.expr}" never fires.`);
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
  private stopWake: (() => void) | null = null;
  private poked = false;
  private closed = false;

  constructor(private readonly log: Log, private readonly engine: Engine, private readonly chat: ChatPort, private readonly emit: (event: Event) => void, private readonly clock: Clock = systemClock) {
    this.tools = {
      create: (spec) => {
        const now = this.clock.now();
        check(spec, now);
        const value: Schedule = { ...spec, id: this.newId(), author: "membr", phase: "proposed", since: iso(now) };
        this.save(value, `membr proposed schedule ${value.id}: ${describe(value.when)}, as a ${value.run === "turn" ? "turn" : "subagent"}. It runs only after you accept it.`);
        return `Proposed schedule ${value.id}. Next: ${fires(value.when, now, 3).map(iso).join(", ")}. It runs only after the user accepts it in a client.`;
      },
      list: () => {
        const lines = [...this.event.schedules].filter((s) => s.phase !== "cancelled").map((s) => `${s.id} ${s.phase} by ${s.author}, ${describe(s.when)}, next ${s.next[0] ?? "none"}: ${s.text}`);
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
    this.poke();
  }

  get event(): Extract<Event, { type: "schedules" }> {
    const now = this.clock.now();
    return { type: "schedules", schedules: [...this.log.schedules.values()].map((s): ScheduleView => {
      const last = this.log.lastFire(s.id) ?? null;
      const done = s.when.kind === "once" && last !== null;
      return { ...s, phase: done ? "done" : s.phase, next: (s.phase === "active" || s.phase === "proposed") && !done ? fires(s.when, now, 3).map(iso) : [], last };
    }) };
  }

  act(act: ScheduleAct): Answer {
    const previous = this.log.answer(act.id);
    if (previous) return previous;
    let value: Schedule | null = null, refusal: string | undefined;
    try { value = this.change(act, this.clock.now()); }
    catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    const { answer } = this.log.saveSchedule(value, act, refusal === undefined ? {} : { refusal });
    if (refusal === undefined) { this.emit(this.event); this.poke(); }
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
    queueMicrotask(() => { this.poked = false; this.tick(); });
  }

  close(): void {
    this.closed = true;
    this.stopWake?.();
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

  private save(value: Schedule, note: string): void {
    const { entry } = this.log.saveSchedule(value, null, { note });
    if (entry) this.chat.record(entry);
    this.emit(this.event);
    this.poke();
  }

  // Only the newest due fire counts: older ones coalesce into it, so nothing queues while the chat is busy.
  private tick(): void {
    if (this.closed) return;
    const now = this.clock.now();
    let changed = false;
    for (const s of this.log.schedules.values()) {
      if (s.phase !== "active") continue;
      try {
        const due = latestDue(s.when, Math.max(Date.parse(s.since), Date.parse(this.log.lastFire(s.id)?.at ?? s.since)), now);
        if (due === null) { this.waiting.delete(s.id); continue; }
        const waiting = this.waiting.get(s.id);
        const late = waiting?.due === due ? waiting.late : !waiting && now - due > GRACE;
        if (late && s.missed === "skip") {
          const entry = this.log.fire({ schedule: s.id, at: iso(due), result: "skipped" }, { kind: "note", text: `Schedule ${s.id} was due at ${iso(due)}, but membr was not running then, so it was skipped.` }, false);
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
    const next = [...this.log.schedules.values()].filter((s) => s.phase === "active").flatMap((s) => fires(s.when, now, 1));
    if (next.length) this.stopWake = this.clock.wake(Math.min(CAP, Math.min(...next) - now), () => this.tick());
  }

  private newId(): string {
    for (;;) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join("");
      if (!this.log.schedules.has(id)) return id;
    }
  }
}
