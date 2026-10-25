// Daily JSON lines follow UniiChat Memory.ts at commit 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import { appendFile, syncDirectory, truncateFile } from "./durable.ts";

type Location = { file: string; at: number; length: number };

export class Journal<K> {
  private readonly locations = new Map<K, Location>();
  private failure: { error: unknown } | undefined;

  constructor(private readonly dir: string, visit: (raw: unknown, file: string) => K | undefined) {
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
    for (const file of files) {
      const full = path.join(dir, file);
      const data = fs.readFileSync(full);
      let at = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, at)) {
        const raw: unknown = JSON.parse(data.subarray(at, end).toString("utf8"));
        const key = visit(raw, file);
        if (key !== undefined) {
          if (this.locations.has(key)) throw new Error(`Duplicate journal key in ${file}`);
          this.locations.set(key, { file: full, at, length: end - at });
        }
        at = end + 1;
      }
      if (at < data.length) {
        truncateFile(full, at);
        console.error(`journal: cut ${data.length - at} bytes from ${full}`);
      }
    }
    fs.rmSync(dir + ".index", { force: true });
    syncDirectory(path.dirname(dir));
  }

  get size(): number { return this.locations.size; }
  has(key: K): boolean { return this.locations.has(key); }

  check(): void {
    if (this.failure) throw this.failure.error;
  }

  read(key: K): unknown {
    this.check();
    const location = this.locations.get(key);
    if (!location) return null;
    const fd = fs.openSync(location.file, "r");
    try {
      const bytes = Buffer.alloc(location.length);
      if (fs.readSync(fd, bytes, 0, bytes.length, location.at) !== bytes.length) throw new Error("Incomplete journal record");
      return JSON.parse(bytes.toString("utf8"));
    } finally { fs.closeSync(fd); }
  }

  append(record: unknown, key: K | undefined, date: string): void {
    this.check();
    try {
      const day = new Date(Date.parse(date.slice(0, 10))).toISOString().slice(0, 10);
      const file = path.join(this.dir, day + ".jsonl");
      if (key !== undefined && this.locations.has(key)) throw new Error(`Duplicate journal key in ${file}`);
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      const at = appendFile(file, bytes);
      if (key !== undefined) this.locations.set(key, { file, at, length: bytes.length - 1 });
    } catch (error) {
      this.failure = { error };
      throw error;
    }
  }
}
