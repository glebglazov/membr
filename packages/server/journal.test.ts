import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Journal } from "./src/journal.ts";
import { Log } from "./src/log.ts";
import { Tree } from "./src/tree.ts";
import { FakeEngine } from "./test/engine.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-journal-"));
  dirs.push(dir);
  return dir;
}
function key(raw: unknown): number | undefined {
  if (raw !== null && typeof raw === "object" && "i" in raw && typeof raw.i === "number") return raw.i;
}
const date = "2026-10-25T00:00:00.000Z";

test("recovery cuts and reports a partial final line before the next append", () => {
  const dir = directory();
  const file = path.join(dir, "2026-10-25.jsonl");
  const complete = JSON.stringify({ i: 0, text: "Hola 🌍" }) + "\n";
  const tail = '{"i":1,"text":"半';
  fs.writeFileSync(file, complete + tail);
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    const journal = new Journal(dir, key);
    expect(fs.readFileSync(file, "utf8")).toBe(complete);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]!.join(" ")).toContain(file);
    expect(report.mock.calls[0]!.join(" ")).toContain(String(Buffer.byteLength(tail)));
    journal.append({ i: 1, text: "Recovered" }, 1, date);
    expect(new Journal(dir, key).read(1)).toEqual({ i: 1, text: "Recovered" });
    expect(journal.read(0)).toEqual({ i: 0, text: "Hola 🌍" });
  } finally { report.mockRestore(); }
});

test("opening refuses a duplicate key across day files", () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, "2026-10-24.jsonl"), '{"i":0}\n');
  fs.writeFileSync(path.join(dir, "2026-10-25.jsonl"), '{"i":0}\n');
  expect(() => new Journal(dir, key)).toThrow(/Duplicate.*2026-10-25/);
});

test("day files keep their names, bytes, and record order", () => {
  const dir = directory();
  const journal = new Journal(dir, key);
  journal.append({ i: 1 }, 1, date);
  journal.append({ event: "no key" }, undefined, date);
  journal.append({ i: 0 }, 0, "2026-10-24T23:59:59.000Z");
  expect(fs.readdirSync(dir).sort()).toEqual(["2026-10-24.jsonl", "2026-10-25.jsonl"]);
  expect(fs.readFileSync(path.join(dir, "2026-10-25.jsonl"), "utf8")).toBe('{"i":1}\n{"event":"no key"}\n');
  const records: Array<[unknown, string]> = [];
  const reopened = new Journal(dir, (raw, file) => { records.push([raw, file]); return key(raw); });
  expect(records).toEqual([[{ i: 0 }, "2026-10-24.jsonl"], [{ i: 1 }, "2026-10-25.jsonl"], [{ event: "no key" }, "2026-10-25.jsonl"]]);
  expect(reopened.size).toBe(2);
  expect(reopened.has(0)).toBe(true);
  expect(reopened.has(2)).toBe(false);
  expect(reopened.read(1)).toEqual({ i: 1 });
  expect(reopened.read(2)).toBeNull();
});

test("a failed file sync locks reads and appends until restart", () => {
  const dir = directory();
  const journal = new Journal(dir, key);
  journal.append({ i: 0 }, 0, date);
  const failure = new Error("File sync failed");
  const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw failure; });
  try { expect(() => journal.append({ i: 1 }, 1, date)).toThrow(failure); }
  finally { sync.mockRestore(); }
  for (const action of [() => journal.read(0), () => journal.read(9), () => journal.check(), () => journal.append({ i: 2 }, 2, date)]) {
    let error: unknown;
    try { action(); } catch (caught) { error = caught; }
    expect(error).toBe(failure);
  }
  const reopened = new Journal(dir, key);
  expect(reopened.size).toBe(2);
  expect(reopened.read(1)).toEqual({ i: 1 });
  reopened.append({ i: 2 }, 2, date);
  expect(reopened.size).toBe(3);
});

test("an append refuses an existing key without writing another record", () => {
  const dir = directory();
  const journal = new Journal(dir, key);
  journal.append({ i: 0 }, 0, date);
  expect(() => journal.append({ i: 0, text: "duplicate" }, 0, date)).toThrow(/Duplicate/);
  expect(fs.readFileSync(path.join(dir, "2026-10-25.jsonl"), "utf8")).toBe('{"i":0}\n');
});

test("the legacy fixture opens without changing its records", () => {
  const dir = directory();
  fs.cpSync(path.join(import.meta.dir, "fixtures", "journal-legacy"), dir, { recursive: true });
  const main = path.join(dir, "main", "2026-10-25.jsonl");
  const treeFile = path.join(dir, "tree", "2026-10-25.jsonl");
  const bytes = [fs.readFileSync(main, "utf8"), fs.readFileSync(treeFile, "utf8")];
  const journal = new Journal(path.join(dir, "main"), key);
  expect(journal.size).toBe(2);
  expect(journal.read(0)).toEqual(JSON.parse(bytes[0]!.split("\n")[0]!));
  expect(fs.existsSync(path.join(dir, "main.index"))).toBe(false);
  const log = new Log(dir);
  const tree = new Tree(dir, log, new FakeEngine());
  try {
    expect(log.entries.map((entry) => entry.text)).toEqual(["Keep this message.", "The turn ended."]);
    expect(log.answer("fixture-say")).toEqual({ type: "answer", id: "fixture-say", ok: true, entry: 0 });
    expect(log.interrupted).toEqual([]);
    expect(tree.dump()).toEqual([
      { l: 0, i: 0, text: "user: Keep this message." },
      { l: 0, i: 1, text: "note: The turn ended." },
      { l: 1, i: 0, text: "user: Keep this message.\nnote: The turn ended." },
    ]);
    expect([fs.readFileSync(main, "utf8"), fs.readFileSync(treeFile, "utf8")]).toEqual(bytes);
  } finally { tree.close(); }
});
