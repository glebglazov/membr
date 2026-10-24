// Memory browsing and paging ported from UniiChat Memory.ts and Clip.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import type { Entry, Part, MemoryLine } from "@membr/protocol";
import type { Log } from "./log.ts";
import type { Tree } from "./tree.ts";

export type ToolAnswer = { text: string; error: boolean; images: Array<{ data: string; mimeType: string }> };
export type MemoryTools = {
  zoom(id: number | string, n?: number, at?: number): ToolAnswer;
  date(id: number): string;
};
type Opened =
  | { kind: "lines"; lines: MemoryLine[] }
  | { kind: "message"; entry: Entry }
  | { kind: "missing"; reason: string; lines: MemoryLine[] };
const WAIT = "(not summarized yet: zoom it)";
const CAP = 30000;

function ref(part: Part): string { return `${part.i * 2 ** part.l}+${2 ** part.l}`; }
function line(part: MemoryLine): string { return ref(part) + "|" + part.text.replace(/\s*\n\s*/g, " "); }
function page(text: string, at: number): string {
  let end = text.length;
  if (text.length - at > CAP) {
    const nl = text.lastIndexOf("\n", at + CAP - 1);
    const low = text.charCodeAt(at + CAP) >> 10 === 0x37;
    end = nl >= at ? nl + 1 : at + CAP - (low ? 1 : 0);
  }
  const on = `\n[characters ${at + 1}-${end} of ${text.length}; go on with at ${end}]`;
  return text.slice(at, end) + (end < text.length ? on : "");
}

export class Memory implements MemoryTools {
  constructor(private readonly log: Log, private readonly tree: Tree, private readonly dir: string) {}

  roots(): MemoryLine[] {
    const roots: Part[] = [];
    for (let id = 0; id < this.log.count;) {
      const l = Math.floor(Math.log2(this.log.count - id));
      roots.push({ l, i: id / 2 ** l });
      id += 2 ** l;
    }
    return roots.map((part) => this.summary(part));
  }

  browse(part: Part): Opened { return this.open(part.i * 2 ** part.l, 2 ** part.l); }

  zoom(id: number | string, n = 1, at = 0): ToolAnswer {
    const opened = this.open(typeof id === "string" && id.trim() === "" ? NaN : Number(id), n);
    if (opened.kind === "missing") return { text: opened.reason, error: true, images: [] };
    if (!Number.isSafeInteger(at) || at < 0) return { text: "Invalid character offset " + at + ".", error: true, images: [] };
    if (opened.kind === "lines") return { text: opened.lines.map(line).join("\n"), error: false, images: [] };
    const entry = opened.entry;
    const names = at === 0 ? entry.images ?? [] : [];
    const images = names.map((name) => this.image(name));
    return { text: `${entry.i}+0|${entry.kind}: ${page(entry.text, at)}` + names.map((name) => `\n[image docs/images/${name}]`).join(""), error: false, images };
  }

  date(id: number): string {
    const entry = Number.isSafeInteger(id) && id >= 0 ? this.log.read(id) : null;
    return entry === null ? "No message " + id + "." : new Date(entry.date).toLocaleString("sv-SE");
  }

  private open(id: number, n: number): Opened {
    const l = Math.log2(n);
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || !Number.isInteger(l) || l < 0 || id % n !== 0 || !Number.isSafeInteger(id + n) || id + n > this.log.count) {
      const lines = this.roots();
      return { kind: "missing", reason: `No line ${id}+${n}: n is a power of 2, id a multiple of n. The tree's roots: ${lines.map(ref).join(", ")}.`, lines };
    }
    if (n === 1) {
      const entry = this.log.read(id);
      if (!entry) throw new Error(`Missing message ${id}`);
      return { kind: "message", entry };
    }
    return { kind: "lines", lines: [this.summary({ l: l - 1, i: id / (n / 2) }), this.summary({ l: l - 1, i: id / (n / 2) + 1 })] };
  }

  private summary(part: Part): MemoryLine { return { ...part, text: this.tree.read(part) ?? WAIT }; }

  private image(name: string): { data: string; mimeType: string } {
    if (!/^[A-Za-z0-9_-]+\.[a-z]+$/.test(name)) throw new Error("Invalid image name");
    const file = path.join(this.dir, "docs", "images", name);
    const fit = fs.existsSync(file + ".jpg");
    return { data: fs.readFileSync(file + (fit ? ".jpg" : "")).toString("base64"), mimeType: fit ? "image/jpeg" : "image/" + name.split(".")[1] };
  }
}
