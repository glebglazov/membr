// Daily JSON lines follow UniiChat Memory.ts
// at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import { parseEntry, parseEvent, parseFired, parsePick, parseSchedule, type Act, type Answer, type Entry, type Fired, type Pick, type ImportEstimate, type ImportMark, type Schedule, type ScheduleAct } from "@membr/protocol";
import { syncDirectory } from "./durable.ts";
import { Journal } from "./journal.ts";

type Turn = { id: number; phase: "running" | "done" };
type SavedPick = { revision: number; value: Pick };
type SavedGoal = { revision: number; value: string | null };
type SavedSchedule = { revision: number; value: Schedule };
export type FireRecord = { schedule: string; at: string; result: Fired["result"] };
export type AllowRule = { tool: string; input: Record<string, unknown> };
type ImportRun = { paused: boolean; estimate: ImportEstimate };
type ImportControl = { id: string; value: ImportRun };
type LogRecord = ({ act: string; ans: Answer } | { event: string }) & Partial<Entry> & { turn?: Turn; pick?: SavedPick; goal?: SavedGoal; allow?: AllowRule; importRun?: ImportControl; schedule?: SavedSchedule; fire?: FireRecord };

export function identity(dir: string, name: string): string {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value) throw new Error(`Empty ${name} file`);
    fs.chmodSync(file, 0o600);
    return value;
  }
  const value = crypto.randomUUID();
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, value + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(dir);
  return value;
}

export class Log {
  readonly importRuns = new Map<string, ImportRun>();
  private readonly imported = new Set<string>();
  private readonly importMarks: Array<ImportMark | undefined> = [];
  private readonly answers = new Map<string, Answer>();
  private readonly journal: Journal<number>;
  private readonly machine: string;
  private seq = 0;
  private readonly started = new Set<number>();
  private readonly finished = new Set<number>();
  private readonly events = new Set<string>();
  private readonly allowed: AllowRule[] = [];
  private savedPick: SavedPick | null = null;
  private savedGoal: SavedGoal = { revision: 0, value: null };
  private readonly revisions = new Map<string, number>();
  private readonly saved = new Map<string, Schedule>();
  private readonly fired = new Map<string, Fired>();

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.machine = identity(dir, "machine");
    this.journal = new Journal<number>(path.join(dir, "main"), (raw, file) => {
      if (raw === null || typeof raw !== "object") throw new Error(`Invalid log record in ${file}`);
      if ("act" in raw && typeof raw.act === "string" && "ans" in raw) {
        const ans = parseEvent(raw.ans);
        if (ans.type !== "answer" || ans.id !== raw.act || this.answers.has(raw.act)) throw new Error(`Invalid act record in ${file}`);
        this.answers.set(raw.act, ans);
        if ("allow" in raw) {
          const allow = raw.allow;
          if (!ans.ok || allow === null || typeof allow !== "object" || !("tool" in allow) || !("input" in allow)) throw new Error(`Invalid allow rule in ${file}`);
          const parsed = parseEvent({ type: "ask", id: raw.act, tool: allow.tool, input: allow.input });
          if (parsed.type === "ask") this.allowed.push({ tool: parsed.tool, input: parsed.input });
        }
        if ("pick" in raw) {
          const pick = raw.pick;
          if (!ans.ok || pick === null || typeof pick !== "object" || !("revision" in pick) || typeof pick.revision !== "number" || !Number.isSafeInteger(pick.revision) || pick.revision < 1 || !("value" in pick)) throw new Error(`Invalid pick in ${file}`);
          const saved = { revision: pick.revision, value: parsePick(pick.value) };
          if (saved.revision > (this.savedPick?.revision ?? 0)) this.savedPick = saved;
        }
      } else if ("event" in raw && typeof raw.event === "string" && !this.events.has(raw.event)) {
        this.events.add(raw.event);
      } else throw new Error(`Invalid log record in ${file}`);
      if ("goal" in raw) {
        const goal = raw.goal;
        if (goal === null || typeof goal !== "object" || !("revision" in goal) || typeof goal.revision !== "number" || !Number.isSafeInteger(goal.revision) || goal.revision < 1 || !("value" in goal) || (goal.value !== null && typeof goal.value !== "string")) throw new Error(`Invalid goal in ${file}`);
        if ("act" in raw && (!raw.ans || typeof raw.ans !== "object" || !("ok" in raw.ans) || raw.ans.ok !== true)) throw new Error(`Invalid goal in ${file}`);
        if (goal.revision > this.savedGoal.revision) this.savedGoal = { revision: goal.revision, value: goal.value };
      }
      if ("turn" in raw) {
        const turn = raw.turn;
        if (turn === null || typeof turn !== "object" || !("id" in turn) || typeof turn.id !== "number" || !Number.isSafeInteger(turn.id) || turn.id < 0 || !("phase" in turn) || (turn.phase !== "running" && turn.phase !== "done")) throw new Error(`Invalid turn in ${file}`);
        (turn.phase === "running" ? this.started : this.finished).add(turn.id);
      }
      if ("importRun" in raw) {
        const control = raw.importRun;
        if (!control || typeof control !== "object" || !("id" in control) || typeof control.id !== "string" || !("value" in control)) throw new Error("Invalid import control");
        const run = control.value;
        if (!run || typeof run !== "object" || !("paused" in run) || typeof run.paused !== "boolean" || !("estimate" in run)) throw new Error("Invalid import state");
        const parsed = parseEvent({ type: "import-estimate", id: control.id, estimate: run.estimate });
        if (parsed.type === "import-estimate") this.importRuns.set(control.id, { paused: run.paused, estimate: parsed.estimate });
      }
      if ("schedule" in raw) {
        const saved = raw.schedule;
        if (saved === null || typeof saved !== "object" || !("revision" in saved) || typeof saved.revision !== "number" || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || !("value" in saved)) throw new Error(`Invalid schedule in ${file}`);
        if ("act" in raw && (!raw.ans || typeof raw.ans !== "object" || !("ok" in raw.ans) || raw.ans.ok !== true)) throw new Error(`Invalid schedule in ${file}`);
        this.rememberSchedule({ revision: saved.revision, value: parseSchedule(saved.value) });
      }
      if ("fire" in raw) {
        const fire = raw.fire;
        if (!("act" in raw) || fire === null || typeof fire !== "object" || !("schedule" in fire) || typeof fire.schedule !== "string" || !fire.schedule || !("at" in fire) || !("result" in fire)) throw new Error(`Invalid fire in ${file}`);
        this.rememberFire(fire.schedule, parseFired({ at: fire.at, result: fire.result, entry: "i" in raw ? raw.i : null }));
      }
      if ("i" in raw) {
        const entry = parseEntry(raw);
        this.rememberImport(entry);
        if (entry.from.machine === this.machine) this.seq = Math.max(this.seq, entry.from.seq + 1);
        return entry.i;
      }
    });
    for (let i = 0; i < this.journal.size; i++) {
      if (!this.journal.has(i)) throw new Error(`Missing message ${i}`);
    }
  }

  hasImported(session: string, message: string): boolean { return this.imported.has(JSON.stringify([session, message])); }
  importAt(i: number): ImportMark | undefined { return this.importMarks[i]; }

  importEntry(run: string, input: { kind: "note" | "ai"; text: string; date: string; session: string; message: string }): Entry {
    const entry: Entry = { ...this.entry(input.kind, input.text), date: input.date, imported: { run, session: input.session, message: input.message } };
    this.write({ ...entry, event: crypto.randomUUID() });
    return entry;
  }

  beginImport(id: string, estimate: ImportEstimate): void {
    if (!this.importRuns.has(id)) this.write({ event: crypto.randomUUID(), importRun: { id, value: { paused: false, estimate } } });
  }

  acceptImport(act: Extract<Act, { act: "import" }>, estimate: ImportEstimate): Answer {
    const answer: Answer = { type: "answer", id: act.id, ok: true, entry: null };
    this.write({ act: act.id, ans: answer, importRun: { id: act.id, value: this.importRuns.get(act.id) ?? { paused: false, estimate } } });
    return answer;
  }

  controlImport(act: Extract<Act, { act: "go" }>): Answer {
    const run = this.importRuns.get(act.import);
    if (!run) throw new Error("No import " + act.import + ".");
    const answer: Answer = { type: "answer", id: act.id, ok: true, entry: null };
    this.write({ act: act.id, ans: answer, importRun: { id: act.import, value: { ...run, paused: act.paused } } });
    return answer;
  }

  private rememberSchedule({ revision, value }: SavedSchedule): void {
    if (revision <= (this.revisions.get(value.id) ?? 0)) return;
    this.revisions.set(value.id, revision);
    this.saved.set(value.id, value);
  }

  private rememberFire(schedule: string, fired: Fired): void {
    const last = this.fired.get(schedule);
    if (!last || Date.parse(fired.at) >= Date.parse(last.at)) this.fired.set(schedule, fired);
  }

  private rememberImport(entry: Entry): void {
    const mark = entry.imported;
    if (!mark) return;
    this.imported.add(JSON.stringify([mark.session, mark.message]));
    this.importMarks[entry.i] = mark;
    if (!this.importRuns.has(mark.run)) this.importRuns.set(mark.run, { paused: false, estimate: { sessions: 0, messages: 0, compactions: 0 } });
  }

  get count(): number { return this.journal.size; }
  get latestTurn(): number {
    let latest: number | null = null;
    for (const id of this.started) latest = latest === null ? id : Math.max(latest, id);
    return latest ?? this.count;
  }
  get allows(): readonly AllowRule[] { return this.allowed; }
  get pick(): Pick | null { return this.savedPick?.value ?? null; }
  get goal(): SavedGoal { return this.savedGoal; }
  get schedules(): ReadonlyMap<string, Schedule> { return this.saved; }
  lastFire(schedule: string): Fired | undefined { return this.fired.get(schedule); }

  read(i: number): Entry | null {
    const raw = this.journal.read(i);
    return raw === null ? null : parseEntry(raw);
  }

  get interrupted(): number[] { return [...this.started].filter((id) => !this.finished.has(id)); }

  answer(id: string): Answer | undefined {
    this.journal.check();
    return this.answers.get(id);
  }

  apply(act: Act, turn: number, refusal?: string, approval?: AllowRule): { answer: Answer; entry: Entry | null; fresh: boolean } {
    this.journal.check();
    const previous = this.answers.get(act.id);
    if (previous) return { answer: previous, entry: null, fresh: false };
    const entry = refusal ? null : act.act === "say"
      ? this.entry("user", act.text, act.images)
      : act.act === "stop" && act.subagent === null ? this.entry("note", "The user stopped the turn.")
      : act.act === "goal" && act.text === null && this.savedGoal.value !== null ? this.entry("note", "Goal halted by the user.") : null;
    const pick = !refusal && act.act === "pick" ? { revision: (this.savedPick?.revision ?? 0) + 1, value: act.pick } : undefined;
    const goal = !refusal && act.act === "goal" ? { revision: this.savedGoal.revision + 1, value: act.text } : undefined;
    const approved = !refusal && act.act === "answer" && approval !== undefined;
    const allow = approved && act.act === "answer" && act.choice === "always" ? approval : undefined;
    const answer: Answer = entry || pick || goal || approved || !refusal && (act.act === "stop" || act.act === "reload")
      ? { type: "answer", id: act.id, ok: true, entry: entry?.i ?? null }
      : { type: "answer", id: act.id, ok: false, reason: refusal ?? `Act ${act.act} is not available yet` };
    this.write({ ...entry, act: act.id, ans: answer, ...(pick ? { pick } : {}), ...(goal ? { goal } : {}), ...(allow ? { allow } : {}), ...(entry && act.act === "say" ? { turn: { id: turn, phase: "running" } } : {}) });
    return { answer, entry, fresh: true };
  }

  // value is the schedule after the change. A refused act records its refusal and saves nothing, so a retry gets the same answer.
  saveSchedule(value: Schedule | null, act: ScheduleAct | null, options: { refusal?: string; note?: string } = {}): { answer: Answer | null; entry: Entry | null; fresh: boolean } {
    this.journal.check();
    const previous = act && this.answers.get(act.id);
    if (previous) return { answer: previous, entry: null, fresh: false };
    const saved = value && !options.refusal ? { revision: (this.revisions.get(value.id) ?? 0) + 1, value } : undefined;
    const entry = saved && options.note !== undefined ? this.entry("note", options.note) : null;
    const answer: Answer | null = act === null ? null : saved
      ? { type: "answer", id: act.id, ok: true, entry: entry?.i ?? null }
      : { type: "answer", id: act.id, ok: false, reason: options.refusal ?? `Act ${act.act} saved no schedule` };
    this.write({ ...entry, ...(act && answer ? { act: act.id, ans: answer } : { event: crypto.randomUUID() }), ...(saved ? { schedule: saved } : {}) });
    return { answer, entry, fresh: true };
  }

  // The act id schedule-<id>-<at ms> makes a fire answer once, so answers dedupes it, also after a restart. A turn the entry opens is finished by the interrupted sweep.
  fire(record: FireRecord, entry: { kind: "user" | "note"; text: string } | null, opensTurn: boolean): Entry | null {
    this.journal.check();
    const id = `schedule-${record.schedule}-${Date.parse(record.at)}`;
    if (this.answers.has(id)) return null;
    const written = entry && { ...this.entry(entry.kind, entry.text), ...(opensTurn ? { scheduled: { schedule: record.schedule, late: record.result === "late" } } : {}) };
    const answer: Answer = { type: "answer", id, ok: true, entry: written?.i ?? null };
    this.write({ ...written, act: id, ans: answer, fire: record, ...(written && opensTurn ? { turn: { id: written.i, phase: "running" } } : {}) });
    return written;
  }

  append(kind: Entry["kind"], text: string): Entry {
    const entry = this.entry(kind, text);
    this.write({ ...entry, event: crypto.randomUUID() });
    return entry;
  }

  work(text: string, turn: number | null): Entry {
    const entry = this.entry("work", text);
    this.write({ ...entry, event: crypto.randomUUID(), ...(turn === null ? {} : { turn: { id: turn, phase: "running" as const } }) });
    return entry;
  }

  continueGoal(text: string): Entry {
    const entry = this.entry("note", text);
    this.write({ ...entry, event: crypto.randomUUID(), turn: { id: entry.i, phase: "running" } });
    return entry;
  }

  completeGoal(revision: number): Entry | null {
    if (this.savedGoal.revision !== revision || this.savedGoal.value === null) return null;
    const entry = this.entry("note", "Goal met.");
    this.write({ ...entry, event: crypto.randomUUID(), goal: { revision: revision + 1, value: null } });
    return entry;
  }

  finish(turn: number, note?: string): Entry | null {
    this.journal.check();
    if (this.finished.has(turn)) return null;
    const entry = note === undefined ? null : this.entry("note", note);
    this.write({ ...entry, event: `turn:${turn}:done`, turn: { id: turn, phase: "done" } });
    return entry;
  }

  get entries(): Entry[] { return Array.from({ length: this.count }, (_, i) => this.read(i)!); }

  private entry(kind: Entry["kind"], text: string, images?: string[]): Entry {
    return { i: this.count, kind, text, date: new Date().toISOString(), from: { machine: this.machine, seq: this.seq }, ...(images === undefined ? {} : { images }) };
  }

  private write(record: LogRecord): void {
    this.journal.check();
    const date = record.imported ? new Date().toISOString() : record.date ?? new Date().toISOString();
    const entry = record.i === undefined ? null : parseEntry(record);
    this.journal.append(record, entry?.i, date);
    if ("act" in record) this.answers.set(record.act, record.ans);
    else this.events.add(record.event);
    if (record.turn) (record.turn.phase === "running" ? this.started : this.finished).add(record.turn.id);
    if (record.allow) this.allowed.push(record.allow);
    if (record.pick) this.savedPick = record.pick;
    if (record.goal) this.savedGoal = record.goal;
    if (record.importRun) this.importRuns.set(record.importRun.id, record.importRun.value);
    if (record.schedule) this.rememberSchedule(record.schedule);
    if (record.fire) this.rememberFire(record.fire.schedule, { at: record.fire.at, result: record.fire.result, entry: entry?.i ?? null });
    if (entry) {
      this.rememberImport(entry);
      this.seq++;
    }
  }
}
