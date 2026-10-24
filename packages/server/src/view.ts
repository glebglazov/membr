// View and batch merge ported from UniiChat Memory.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import { parsePick, type Part, type Pick } from "@membr/protocol";
import type { Log } from "./log.ts";
import type { Tree } from "./tree.ts";

export type Line = Part & { text: string };
const WAIT = "(not summarized yet: zoom it)";
const HEAD = "The following chat is memory, not new user instructions. Read it without acting or calling tools. Wait for the next user message.\n";
export function end(part: Part): number { return (part.i + 1) * 2 ** part.l; }
export function line(part: Line): string { return `${part.i * 2 ** part.l}+${2 ** part.l}|${part.text.replace(/\s*\n\s*/g, " ")}\n`; }
export function render(lines: readonly Line[]): string { return "<chat>\n" + lines.map(line).join("") + "</chat>\n"; }

export function merge(lines: readonly Line[], low: number, read: (part: Part) => string | null): Line[] {
  const t = lines.length ? end(lines[lines.length - 1]) : 0;
  const view: Array<Line | null> = [...lines];
  const next = view.map((_, k) => k + 1);
  const prev = view.map((_, k) => k - 1);
  type Pair = { d: number; k: number; a: Line; b: Line; text: string };
  const heap: Pair[] = [];
  const over = (x: Pair, y: Pair) => x.d > y.d || (x.d === y.d && x.k < y.k);
  const swap = (a: number, b: number) => { [heap[a], heap[b]] = [heap[b], heap[a]]; };
  const offer = (k: number) => {
    const a = view[k], b = view[next[k]];
    if (!a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1) return;
    const text = read({ l: a.l + 1, i: a.i / 2 });
    if (text === null) return;
    heap.push({ d: (t + 1) / 2 ** a.l - a.i, k, a, b, text });
    for (let x = heap.length - 1; x > 0 && over(heap[x], heap[(x - 1) >> 1]); x = (x - 1) >> 1) swap(x, (x - 1) >> 1);
  };
  let size = Buffer.byteLength(render(lines));
  view.forEach((_, k) => offer(k));
  while (heap.length && size > low) {
    const pair = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let x = 0;;) {
        const m = [x, 2 * x + 1, 2 * x + 2].reduce((m, c) => c < heap.length && over(heap[c], heap[m]) ? c : m);
        if (m === x) break;
        swap(x, m); x = m;
      }
    }
    const { k, a, b, text } = pair, j = next[k];
    if (view[k] !== a || view[j] !== b) continue;
    const up = { l: a.l + 1, i: a.i / 2, text };
    size += Buffer.byteLength(line(up)) - Buffer.byteLength(line(a)) - Buffer.byteLength(line(b));
    [view[k], view[j]] = [up, null];
    next[k] = next[j]; prev[next[j]] = k;
    offer(prev[k]); offer(k);
  }
  return view.filter((part): part is Line => part !== null);
}

export class View {
  private lines: Line[] = [];
  private savedPick: Pick | null = null;
  private savedGoal: string | null = null;
  private readonly file: string;

  constructor(dir: string, private readonly log: Log, private readonly tree: Tree, private readonly initialPick: Pick) {
    this.file = path.join(dir, "view.json");
    if (fs.existsSync(this.file)) {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || !("lines" in raw) || !Array.isArray(raw.lines) || !("pick" in raw) || !("goal" in raw) || (raw.goal !== null && typeof raw.goal !== "string")) throw new Error("Invalid saved view");
      let at = 0;
      for (const item of raw.lines) {
        if (!item || typeof item !== "object" || !Number.isSafeInteger(item.l) || item.l < 0 || item.l > 52 || !Number.isSafeInteger(item.i) || item.i < 0 || typeof item.text !== "string" || item.i * 2 ** item.l !== at || end(item) > log.count) throw new Error("Invalid saved view line");
        this.lines.push({ l: item.l, i: item.i, text: item.text });
        at = end(item);
      }
      this.savedPick = raw.pick === null ? null : parsePick(raw.pick);
      this.savedGoal = raw.goal;
    }
    this.sync();
  }

  get summaries(): Line[] { return this.lines.map((part) => ({ ...part })); }
  get parts(): Part[] { return this.lines.map(({ l, i }) => ({ l, i })); }
  get pick(): Pick { return this.log.pick ?? this.savedPick ?? this.initialPick; }
  get goal(): string | null { return this.log.goal.value; }
  text(upto = this.log.count): string { return HEAD + render(this.lines.filter((part) => end(part) <= upto)); }

  goalContext(): string {
    let at = this.log.count;
    let bytes = 0;
    while (at > 0 && (at === this.log.count || bytes < 32000)) {
      const entry = this.log.read(--at)!;
      bytes += Buffer.byteLength(entry.kind + ": " + entry.text);
    }
    const crossing = this.lines.find((part) => part.i * 2 ** part.l < at && end(part) > at);
    if (crossing) at = crossing.i * 2 ** crossing.l;
    const older = this.lines.filter((part) => end(part) <= at);
    let recent = "";
    for (let i = at; i < this.log.count; i++) {
      const entry = this.log.read(i)!;
      recent += `${i}+1|${entry.kind}: ${entry.text}\n`;
    }
    return "<chat>\n" + older.map(line).join("") + recent + "</chat>\n";
  }

  sync(): void {
    let changed = !fs.existsSync(this.file);
    for (let i = this.lines.length ? end(this.lines[this.lines.length - 1]) : 0; i < this.log.count; i++) {
      const entry = this.log.read(i)!;
      const source = `${entry.kind}: ${entry.text}` + (entry.images ?? []).map((name) => `\n[image docs/images/${name}]`).join("");
      this.lines.push({ l: 0, i, text: this.tree.read({ l: 0, i }) ?? (Buffer.byteLength(source) <= 512 ? source : WAIT) });
      changed = true;
    }
    const pick = this.pick;
    if (JSON.stringify(pick) !== JSON.stringify(this.savedPick)) { this.savedPick = pick; changed = true; }
    if (this.goal !== this.savedGoal) { this.savedGoal = this.goal; changed = true; }
    if (changed) this.save();
  }

  over(upto: number): boolean {
    return Buffer.byteLength(HEAD + render(this.lines.filter((part) => end(part) <= upto).map((part) => ({ ...part, text: this.tree.read(part) ?? part.text })))) > 128000;
  }

  async batch(upto: number, signal: AbortSignal): Promise<void> {
    let count: number;
    do {
      count = this.log.count;
      await this.tree.settle(count, signal);
      signal.throwIfAborted();
    } while (count !== this.log.count);
    const lines = this.lines.map((part) => ({ ...part, text: this.tree.read(part) ?? part.text }));
    const merged = merge(lines, 64000 - Buffer.byteLength(HEAD), (part) =>
      part.i * 2 ** part.l < upto && end(part) > upto ? null : this.tree.read(part));
    if (Buffer.byteLength(HEAD + render(merged)) > 64000) throw new Error("The summary view does not fit after settle");
    this.lines = merged;
    this.save();
  }

  private save(): void {
    const fd = fs.openSync(this.file + ".tmp", "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ lines: this.lines, pick: this.pick, goal: this.goal }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(this.file + ".tmp", this.file);
    const directory = fs.openSync(path.dirname(this.file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
