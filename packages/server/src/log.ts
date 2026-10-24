// Daily JSON lines and the 16-byte index slots follow UniiChat Memory.ts
// at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import { parseEntry, parseEvent, type Act, type Answer, type Entry } from "@membr/protocol";

const SLOT = 16;
const DAY = 86_400_000;
type Record = { act: string; ans: Answer } & Partial<Entry>;
type Location = { day: number; at: number; length: number };

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

function syncDirectory(dir: string) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class Log {
  private readonly answers = new Map<string, Answer>();
  private readonly locations: Array<Location | undefined> = [];
  private readonly machine: string;
  private seq = 0;
  private failure: unknown;

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
          if (raw === null || typeof raw !== "object" || !("act" in raw) || typeof raw.act !== "string" || !("ans" in raw)) throw new Error(`Invalid log record in ${file}`);
          const ans = parseEvent(raw.ans);
          if (ans.type !== "answer" || ans.id !== raw.act || this.answers.has(raw.act)) throw new Error(`Invalid act record in ${file}`);
          this.answers.set(raw.act, ans);
          if ("i" in raw) {
            const entry = parseEntry(raw);
            if (this.locations[entry.i]) throw new Error(`Duplicate message index in ${file}`);
            this.place(index, entry.i, { day, at, length: end - at });
            if (entry.from.machine === this.machine) this.seq = Math.max(this.seq, entry.from.seq + 1);
          }
          at = end + 1;
        }
        if (at < data.length) {
          const fd = fs.openSync(full, "r+");
          try { fs.ftruncateSync(fd, at); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      }
      for (let i = 0; i < this.locations.length; i++) {
        if (!this.locations[i]) throw new Error(`Missing message ${i}`);
      }
      fs.fsyncSync(index);
    } finally { fs.closeSync(index); }
    syncDirectory(dir);
  }

  get count(): number { return this.locations.length; }

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

  apply(act: Act): { answer: Answer; entry: Entry | null } {
    if (this.failure) throw this.failure;
    const previous = this.answers.get(act.id);
    if (previous) return { answer: previous, entry: null };
    const date = new Date().toISOString();
    const entry: Entry | null = act.act === "say" ? {
      i: this.count, kind: "user", text: act.text, date,
      from: { machine: this.machine, seq: this.seq },
      ...(act.images === undefined ? {} : { images: act.images }),
    } : null;
    const answer: Answer = entry
      ? { type: "answer", id: act.id, ok: true, entry: entry.i }
      : { type: "answer", id: act.id, ok: false, reason: `Act ${act.act} is not available yet` };
    const record: Record = { ...entry, act: act.id, ans: answer };
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    const day = Date.parse(date.slice(0, 10)) / DAY;
    const file = this.file(day);
    try {
      const fd = fs.openSync(file, "a", 0o600);
      let at: number;
      try {
        at = fs.fstatSync(fd).size;
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      syncDirectory(path.join(this.dir, "main"));
      this.answers.set(act.id, answer);
      if (entry) {
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
    return { answer, entry };
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
