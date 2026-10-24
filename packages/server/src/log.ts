// Daily JSON lines and the 16-byte index slots follow UniiChat Memory.ts
// at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import { parseEntry, parseEvent, parsePick, type Act, type Answer, type Entry, type Pick, type ImportEstimate, type ImportMark } from "@membr/protocol";
import { appendFile, replaceFile, syncDirectory, truncateFile } from "./durable.ts";

const SLOT = 16;
const DAY = 86_400_000;
type Turn = { id: number; phase: "running" | "done" };
type SavedPick = { revision: number; value: Pick };
type SavedGoal = { revision: number; value: string | null };
export type AllowRule = { tool: string; input: Record<string, unknown> };
type ImportRun = { paused: boolean; estimate: ImportEstimate };
type ImportControl = { id: string; value: ImportRun };
type LogRecord = ({ act: string; ans: Answer } | { event: string }) & Partial<Entry> & { turn?: Turn; pick?: SavedPick; goal?: SavedGoal; allow?: AllowRule; importRun?: ImportControl };
type Location = { day: number; at: number; length: number };
export type EpochRecord = { session: string; date: string };

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
  private readonly locations: Array<Location | undefined> = [];
  private readonly machine: string;
  private seq = 0;
  private readonly started = new Set<number>();
  private readonly finished = new Set<number>();
  private readonly events = new Set<string>();
  private failure: unknown;
  private readonly allowed: AllowRule[] = [];
  private savedPick: SavedPick | null = null;
  private savedGoal: SavedGoal = { revision: 0, value: null };

  constructor(private readonly dir: string) {
    fs.mkdirSync(path.join(dir, "main"), { recursive: true });
    this.machine = identity(dir, "machine");
    const index = fs.openSync(path.join(dir, "main.index"), "w", 0o600);
    try {
      const files = fs.readdirSync(path.join(dir, "main")).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
      for (const file of files) {
        const full = path.join(dir, "main", file);
        const day = Date.parse(file.slice(0, 10)) / DAY;
        const data = fs.readFileSync(full);
        let at = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, at)) {
          const raw: unknown = JSON.parse(data.subarray(at, end).toString("utf8"));
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
          if ("i" in raw) {
            const entry = parseEntry(raw);
            this.rememberImport(entry);
            if (this.locations[entry.i]) throw new Error(`Duplicate message index in ${file}`);
            this.place(index, entry.i, { day, at, length: end - at });
            if (entry.from.machine === this.machine) this.seq = Math.max(this.seq, entry.from.seq + 1);
          }
          at = end + 1;
        }
        if (at < data.length) truncateFile(full, at);
      }
      for (let i = 0; i < this.locations.length; i++) {
        if (!this.locations[i]) throw new Error(`Missing message ${i}`);
      }
      fs.fsyncSync(index);
    } finally { fs.closeSync(index); }
    syncDirectory(dir);
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

  private rememberImport(entry: Entry): void {
    const mark = entry.imported;
    if (!mark) return;
    this.imported.add(JSON.stringify([mark.session, mark.message]));
    this.importMarks[entry.i] = mark;
    if (!this.importRuns.has(mark.run)) this.importRuns.set(mark.run, { paused: false, estimate: { sessions: 0, messages: 0, compactions: 0 } });
  }

  get count(): number { return this.locations.length; }
  get latestTurn(): number {
    let latest: number | null = null;
    for (const id of this.started) latest = latest === null ? id : Math.max(latest, id);
    return latest ?? this.count;
  }
  get allows(): readonly AllowRule[] { return this.allowed; }
  get pick(): Pick | null { return this.savedPick?.value ?? null; }
  get goal(): SavedGoal { return this.savedGoal; }

  read(i: number): Entry | null {
    const location = this.locations[i];
    if (!location) return null;
    const fd = fs.openSync(this.file(location.day), "r");
    try {
      const bytes = Buffer.alloc(location.length);
      if (fs.readSync(fd, bytes, 0, bytes.length, location.at) !== bytes.length) throw new Error("Incomplete log record");
      return parseEntry(JSON.parse(bytes.toString("utf8")));
    } finally { fs.closeSync(fd); }
  }

  get interrupted(): number[] { return [...this.started].filter((id) => !this.finished.has(id)); }

  answer(id: string): Answer | undefined {
    if (this.failure) throw this.failure;
    return this.answers.get(id);
  }

  apply(act: Act, turn: number, refusal?: string, approval?: AllowRule): { answer: Answer; entry: Entry | null; fresh: boolean } {
    if (this.failure) throw this.failure;
    const previous = this.answers.get(act.id);
    if (previous) return { answer: previous, entry: null, fresh: false };
    const entry = refusal ? null : act.act === "say"
      ? this.entry("user", act.text, act.images)
      : act.act === "stop" && act.agent === null ? this.entry("note", "The user stopped the turn.")
      : act.act === "goal" && act.text === null ? this.entry("note", "Goal halted by the user.") : null;
    const pick = !refusal && act.act === "pick" ? { revision: (this.savedPick?.revision ?? 0) + 1, value: act.pick } : undefined;
    const goal = !refusal && act.act === "goal" ? { revision: this.savedGoal.revision + 1, value: act.text } : undefined;
    const approved = !refusal && act.act === "answer" && approval !== undefined;
    const allow = approved && act.act === "answer" && act.choice === "always" ? approval : undefined;
    const answer: Answer = entry || pick || goal || approved || !refusal && act.act === "stop"
      ? { type: "answer", id: act.id, ok: true, entry: entry?.i ?? null }
      : { type: "answer", id: act.id, ok: false, reason: refusal ?? `Act ${act.act} is not available yet` };
    this.write({ ...entry, act: act.id, ans: answer, ...(pick ? { pick } : {}), ...(goal ? { goal } : {}), ...(allow ? { allow } : {}), ...(entry && act.act === "say" ? { turn: { id: turn, phase: "running" } } : {}) });
    return { answer, entry, fresh: true };
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
    if (this.failure) throw this.failure;
    if (this.finished.has(turn)) return null;
    const entry = note === undefined ? null : this.entry("note", note);
    this.write({ ...entry, event: `turn:${turn}:done`, turn: { id: turn, phase: "done" } });
    return entry;
  }

  epoch(epoch: string, session: string, date = new Date().toISOString()): void {
    const file = path.join(this.dir, "epochs.json");
    const previous: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    if (previous === null || typeof previous !== "object" || Array.isArray(previous) || Object.values(previous).some((value) => typeof value !== "string" && (!value || typeof value !== "object" || !("session" in value) || typeof value.session !== "string" || !("date" in value) || typeof value.date !== "string"))) throw new Error("Invalid epoch map");
    replaceFile(file, JSON.stringify({ ...previous, [epoch]: { session, date } }) + "\n");
  }

  get epochs(): Record<string, EpochRecord> {
    const file = path.join(this.dir, "epochs.json");
    if (!fs.existsSync(file)) return {};
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid epoch map");
    return Object.fromEntries(Object.entries(raw).flatMap(([epoch, value]) => {
      if (typeof value === "string") return [[epoch, { session: value, date: "" }]];
      if (value && typeof value === "object" && "session" in value && typeof value.session === "string" && "date" in value && typeof value.date === "string") return [[epoch, { session: value.session, date: value.date }]];
      return [];
    }));
  }

  removeEpochs(epochs: string[]): void {
    const all = this.epochs;
    for (const epoch of epochs) delete all[epoch];
    const file = path.join(this.dir, "epochs.json");
    const previous: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const [epoch, record] of Object.entries(all)) if (record.date === "" && typeof previous[epoch] === "string") (all as Record<string, unknown>)[epoch] = previous[epoch];
    replaceFile(file, JSON.stringify(all) + "\n");
  }

  get entries(): Entry[] { return Array.from({ length: this.count }, (_, i) => this.read(i)!); }

  private entry(kind: Entry["kind"], text: string, images?: string[]): Entry {
    return { i: this.count, kind, text, date: new Date().toISOString(), from: { machine: this.machine, seq: this.seq }, ...(images === undefined ? {} : { images }) };
  }

  private write(record: LogRecord): void {
    if (this.failure) throw this.failure;
    const date = record.imported ? new Date().toISOString() : record.date ?? new Date().toISOString();
    const entry = record.i === undefined ? null : parseEntry(record);
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    const day = Date.parse(date.slice(0, 10)) / DAY;
    const file = this.file(day);
    try {
      const at = appendFile(file, bytes);
      if ("act" in record) this.answers.set(record.act, record.ans);
      else this.events.add(record.event);
      if (record.turn) (record.turn.phase === "running" ? this.started : this.finished).add(record.turn.id);
      if (record.allow) this.allowed.push(record.allow);
      if (record.pick) this.savedPick = record.pick;
      if (record.goal) this.savedGoal = record.goal;
      if (record.importRun) this.importRuns.set(record.importRun.id, record.importRun.value);
      if (entry) {
        this.rememberImport(entry);
        const index = fs.openSync(path.join(this.dir, "main.index"), "r+");
        try { this.place(index, entry.i, { day, at, length: bytes.length - 1 }); } finally { fs.closeSync(index); }
        this.seq++;
      }
    } catch (error) {
      // A failed write can still have reached disk. Restart must recover it
      // before another act can append to this log.
      this.failure = error;
      throw error;
    }
  }

  private file(day: number): string {
    return path.join(this.dir, "main", new Date(day * DAY).toISOString().slice(0, 10) + ".jsonl");
  }

  private place(fd: number, i: number, location: Location) {
    const slot = Buffer.alloc(SLOT);
    slot.writeDoubleLE(location.at, 0);
    slot.writeUInt32LE(location.day, 8);
    slot.writeUInt32LE(location.length, 12);
    fs.writeSync(fd, slot, 0, SLOT, i * SLOT);
    this.locations[i] = location;
  }
}
