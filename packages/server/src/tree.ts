// Tree layout and compaction prompts ported from UniiChat Memory.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import type { MemoryLine, Part } from "@membr/protocol";
import type { Engine } from "./engine.ts";
import type { Log } from "./log.ts";
import { end, flat, merge, render } from "./view.ts";
import { imageMarks } from "./images.ts";
import { appendFile, syncDirectory, truncateFile } from "./durable.ts";

const NODE = 512;
const JOBS = 4;
const TRIES = 5;
const SEEN = 32000;
const SLOT = 16;
const DAY = 86_400_000;
const SCALE = "-".repeat(NODE);
const LEAF = `Compaction: compress message {id} into one line of at most ${NODE} bytes
(about 70 words), the length of this ruler:
${SCALE}
<input>
`;
const MERGE = `Compaction: merge lines {a} and {b}, adjacent, into one line of at most
${NODE} bytes (about 70 words), the length of this ruler:
${SCALE}
<chat> may hold their messages, {id} to {end}, in more detail: take details
of them from there too.
<input>
`;
type Node = Part & { text: string; size: number };
type Location = { day: number; at: number; length: number };

function key({ l, i }: Part): number { return (2 * i + 1) * 2 ** l - 1; }
function context(part: Part): number { return part.l === 0 ? part.i : end(part); }
function cut(text: string): string {
  const bytes = Buffer.from(text);
  let length = Math.min(bytes.length, NODE);
  if (length < bytes.length) while (length > 0 && (bytes[length] & 0xc0) === 0x80) length--;
  return bytes.subarray(0, length).toString("utf8");
}

export class Tree {
  private readonly locations = new Map<number, Location>();
  private readonly ready = new Map<number, Part>();
  private readonly busy = new Set<number>();
  private readonly delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly waiting = new Set<() => void>();
  private seen: MemoryLine[] = [];
  private readonly importCounts: number[] = [0];
  onChange: () => void = () => {};
  private failure: unknown;
  private count = 0;
  private scheduled = false;
  private stopped = false;

  constructor(private readonly dir: string, private readonly log: Log, private readonly engine: Engine) {
    fs.mkdirSync(path.join(dir, "tree"), { recursive: true });
    this.load();
    this.sync();
  }

  sync(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.stopped) return;
      try {
        while (this.count < this.log.count) {
          const part = { l: 0, i: this.count++ };
          const imported = this.log.importAt(part.i) !== undefined;
          this.importCounts.push(this.importCounts[part.i] + Number(imported));
          if (!this.locations.has(key(part))) this.ready.set(key(part), part);
          else this.parent(part);
        }
        this.pump();
        this.waiting.forEach((check) => check());
        this.onChange();
      } catch (error) { this.fail(error); }
    });
  }

  pendingImport(run: string): boolean {
    for (let i = 0; i < this.log.count; i++) {
      if (this.log.importAt(i)?.run !== run) continue;
      for (let l = 0; (i + 1) % 2 ** l === 0; l++) {
        if (!this.locations.has(key({ l, i: (i + 1) / 2 ** l - 1 }))) return true;
      }
    }
    return false;
  }

  private run(part: Part): string | undefined {
    return this.log.importAt(end(part) - 1)?.run;
  }

  private held(part: Part): boolean {
    const run = this.run(part);
    return run !== undefined && this.log.importRuns.get(run)?.paused === true;
  }

  roots(): Part[] { return this.cover(this.log.count); }

  private cover(count: number): Part[] {
    const parts: Part[] = [];
    const down = (part: Part): void => {
      if (part.l === 0 || this.locations.has(key(part))) parts.push(part);
      else {
        down({ l: part.l - 1, i: part.i * 2 });
        down({ l: part.l - 1, i: part.i * 2 + 1 });
      }
    };
    for (let i = 0; i < count;) {
      const l = Math.floor(Math.log2(count - i));
      down({ l, i: i / 2 ** l });
      i += 2 ** l;
    }
    return parts;
  }

  close(): void {
    this.stopped = true;
    this.waiting.forEach((check) => check());
    for (const [timer, resolve] of this.delays) { clearTimeout(timer); resolve(); }
    this.delays.clear();
  }

  private fail(error: unknown): void {
    this.failure = error;
    this.close();
    console.error("compactor: " + (error instanceof Error ? error.message : String(error)));
  }

  settle(upto: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const reason = signal.aborted ? signal.reason : this.failure ?? (this.stopped ? new Error("The compactor is closed") : null);
        const built = (part: Part): boolean => {
          if (this.locations.has(key(part))) return true;
          const a = part.i * 2 ** part.l, b = end(part);
          const imports = (this.importCounts[b] ?? 0) - (this.importCounts[a] ?? 0);
          if (imports === b - a) return true;
          if (!imports || part.l === 0) return false;
          return built({ l: part.l - 1, i: part.i * 2 }) && built({ l: part.l - 1, i: part.i * 2 + 1 });
        };
        let ready = this.count >= upto;
        for (let i = 0; ready && i < upto;) {
          const l = Math.floor(Math.log2(upto - i));
          ready = built({ l, i: i / 2 ** l });
          i += 2 ** l;
        }
        if (reason || ready) {
          this.waiting.delete(check);
          signal.removeEventListener("abort", check);
          if (reason) reject(reason); else resolve();
        }
      };
      this.waiting.add(check);
      signal.addEventListener("abort", check);
      check();
    });
  }

  private file(day: number): string {
    return path.join(this.dir, "tree", new Date(day * DAY).toISOString().slice(0, 10) + ".jsonl");
  }

  private load(): void {
    const index = fs.openSync(path.join(this.dir, "tree.index"), "w", 0o600);
    const nodes: Part[] = [];
    try {
      for (const file of fs.readdirSync(path.join(this.dir, "tree")).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
        const full = path.join(this.dir, "tree", file);
        const day = Date.parse(file.slice(0, 10)) / DAY;
        const data = fs.readFileSync(full);
        let at = 0;
        for (let stop = data.indexOf(10); stop !== -1; stop = data.indexOf(10, at)) {
          const raw: unknown = JSON.parse(data.subarray(at, stop).toString("utf8"));
          if (raw === null || typeof raw !== "object" || !("l" in raw) || !("i" in raw) || !("text" in raw) || !("size" in raw)
            || typeof raw.l !== "number" || !Number.isSafeInteger(raw.l) || raw.l < 0 || raw.l > 52
            || typeof raw.i !== "number" || !Number.isSafeInteger(raw.i) || raw.i < 0
            || typeof raw.text !== "string" || raw.text !== Buffer.from(raw.text).toString("utf8")
            || raw.size !== Buffer.byteLength(raw.text) || raw.size > NODE) throw new Error(`Invalid tree record in ${file}`);
          const part = { l: raw.l, i: raw.i };
          if (end(part) > this.log.count || !Number.isSafeInteger(key(part)) || this.locations.has(key(part))) throw new Error(`Invalid tree node in ${file}`);
          this.place(index, part, { day, at, length: stop - at });
          nodes.push(part);
          at = stop + 1;
        }
        if (at < data.length) truncateFile(full, at);
      }
      for (const part of nodes) {
        if (part.l > 0 && (!this.locations.has(key({ l: part.l - 1, i: part.i * 2 })) || !this.locations.has(key({ l: part.l - 1, i: part.i * 2 + 1 })))) throw new Error("Tree parent has a missing child");
        this.parent(part);
      }
      fs.fsyncSync(index);
    } finally { fs.closeSync(index); }
    syncDirectory(this.dir);
  }

  private place(fd: number, part: Part, location: Location): void {
    const slot = Buffer.alloc(SLOT);
    slot.writeDoubleLE(location.at, 0);
    slot.writeUInt32LE(location.day, 8);
    slot.writeUInt32LE(location.length, 12);
    fs.writeSync(fd, slot, 0, SLOT, key(part) * SLOT);
    this.locations.set(key(part), location);
  }

  read(part: Part): string | null {
    const location = this.locations.get(key(part));
    if (!location) return null;
    const fd = fs.openSync(this.file(location.day), "r");
    try {
      const bytes = Buffer.alloc(location.length);
      if (fs.readSync(fd, bytes, 0, bytes.length, location.at) !== bytes.length) throw new Error("Incomplete tree record");
      return (JSON.parse(bytes.toString("utf8")) as Node).text;
    } finally { fs.closeSync(fd); }
  }

  private parent(part: Part): void {
    const sibling = { l: part.l, i: part.i % 2 === 0 ? part.i + 1 : part.i - 1 };
    const parent = { l: part.l + 1, i: Math.floor(part.i / 2) };
    if (this.locations.has(key(sibling)) && !this.locations.has(key(parent))) this.ready.set(key(parent), parent);
  }

  private source(part: Part): string {
    if (part.l === 0) {
      const entry = this.log.read(part.i);
      if (!entry) throw new Error(`Missing message ${part.i}`);
      return `${entry.kind}: ${Buffer.from(entry.text).toString("utf8")}` + imageMarks(entry.images ?? []);
    }
    const a = this.read({ l: part.l - 1, i: part.i * 2 });
    const b = this.read({ l: part.l - 1, i: part.i * 2 + 1 });
    if (a === null || b === null) throw new Error("Tree parent has a missing child");
    return flat(a) + "\n" + flat(b);
  }

  private store(part: Part, text: string): void {
    const day = Math.floor(Date.now() / DAY);
    const record: Node = { ...part, text, size: Buffer.byteLength(text) };
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    const at = appendFile(this.file(day), bytes);
    const index = fs.openSync(path.join(this.dir, "tree.index"), "r+");
    try { this.place(index, part, { day, at, length: bytes.length - 1 }); fs.fsyncSync(index); } finally { fs.closeSync(index); }
    this.ready.delete(key(part));
    this.parent(part);
    this.waiting.forEach((check) => check());
    this.onChange();
  }

  private pump(): void {
    while (!this.stopped && this.busy.size < JOBS) {
      const candidates = [...this.ready.values()];
      const importsBusy = [...this.busy].filter((id) => { const part = this.ready.get(id); return part && this.run(part) !== undefined; }).length;
      const choose = (imported: boolean) => {
        if (imported && importsBusy >= JOBS - 1) return undefined;
        const lane = candidates.filter((part) => (this.run(part) !== undefined) === imported && !this.held(part));
        const leaves = lane.filter((part) => part.l === 0).sort((a, b) => a.i - b.i);
        const limit = leaves[JOBS - 1]?.i ?? this.count;
        return lane.filter((part) => !this.busy.has(key(part)) && context(part) <= limit)
          .sort((a, b) => context(a) - context(b) || b.l - a.l)[0];
      };
      const part = choose(false) ?? choose(true);
      if (!part) return;
      const source = this.source(part);
      if (Buffer.byteLength(source) <= NODE) this.store(part, source);
      else {
        const first = candidates.filter((node) => node.l === 0 && (this.run(node) !== undefined) === (this.run(part) !== undefined)).reduce((first, node) => Math.min(first, node.i), this.count);
        const prompt = this.prompt(part, source, first);
        this.busy.add(key(part));
        void this.build(part, source, prompt).catch((error) => this.fail(error)).finally(() => {
          this.busy.delete(key(part));
          this.sync();
        });
      }
    }
  }

  private prompt(part: Part, source: string, first: number): string {
    const upto = Math.min(context(part), first);
    for (let i = this.seen.length ? end(this.seen[this.seen.length - 1]) : 0; i < upto; i++) {
      const text = this.read({ l: 0, i });
      if (text === null) break;
      this.seen.push({ l: 0, i, text });
    }
    if (Buffer.byteLength(render(this.seen)) > SEEN) {
      const merged = merge(this.seen, SEEN / 2, (node) => this.read(node));
      if (Buffer.byteLength(render(merged)) <= SEEN / 2) this.seen = merged;
    }
    const visible = this.seen.filter((node) => end(node) <= upto);
    const a = part.i * 2 ** part.l;
    const n = 2 ** part.l / 2;
    const task = (part.l === 0 ? LEAF : MERGE).replace("{a}", `${a}+${n}`).replace("{b}", `${a + n}+${n}`).replace("{id}", String(a)).replace("{end}", String(end(part) - 1));
    return render(visible) + task + source + "\n</input>";
  }

  private async build(part: Part, source: string, prompt: string): Promise<void> {
    let best: string | null = null;
    let note = "";
    let tries = 0;
    let delay = 1000;
    while (!this.stopped && tries < TRIES) {
      if (this.held(part)) return;
      let answer: string | null;
      try { answer = await this.engine.compact(prompt + note); } catch {
        if (this.stopped) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { this.delays.delete(timer); resolve(); }, delay);
          timer.unref();
          this.delays.set(timer, resolve);
        });
        delay = Math.min(delay * 2, 60000);
        continue;
      }
      if (this.stopped) return;
      const line = answer?.trim();
      if (!line) { best = null; break; }
      tries++;
      delay = 1000;
      if (best === null || Buffer.byteLength(line) < Buffer.byteLength(best)) best = line;
      if (Buffer.byteLength(line) <= NODE) break;
      note = `\nToo long: your last line for this <input> was ${Buffer.byteLength(line)} bytes,
over the ${NODE}-byte limit. Write the whole line again, cutting just
enough of the least valuable items to fit before this cut:
${cut(line)}| ← LIMIT`;
    }
    if (!this.stopped) this.store(part, cut(best ?? flat(source)));
  }
}
