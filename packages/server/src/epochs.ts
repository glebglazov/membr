import fs from "node:fs";
import path from "node:path";
import { replaceFile } from "./durable.ts";

// cwd is the directory the epoch ran in. Claude Code files its sessions by that directory.
export type EpochRecord = { session: string; date: string; cwd?: string };

// Older files hold a bare session id, or a record with no cwd. A missing cwd means the server's working directory.
function parse(value: unknown): EpochRecord | null {
  if (typeof value === "string") return { session: value, date: "" };
  if (!value || typeof value !== "object") return null;
  const { session, date, cwd } = value as Record<string, unknown>;
  if (typeof session !== "string" || typeof date !== "string" || (cwd !== undefined && typeof cwd !== "string")) return null;
  return { session, date, ...(cwd === undefined ? {} : { cwd }) };
}

export class Epochs {
  constructor(private readonly dir: string) {}

  private get file() { return path.join(this.dir, "epochs.json"); }

  private read(): Record<string, unknown> {
    if (!fs.existsSync(this.file)) return {};
    const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid epoch map");
    return raw as Record<string, unknown>;
  }

  record(epoch: string, session: string, cwd: string, date = new Date().toISOString()): void {
    const previous = this.read();
    if (Object.values(previous).some((value) => parse(value) === null)) throw new Error("Invalid epoch map");
    replaceFile(this.file, JSON.stringify({ ...previous, [epoch]: { session, date, cwd } }) + "\n");
  }

  get list(): Record<string, EpochRecord> {
    return Object.fromEntries(Object.entries(this.read()).flatMap(([epoch, value]) => {
      const record = parse(value);
      return record ? [[epoch, record]] : [];
    }));
  }

  remove(epochs: string[]): void {
    const kept = Object.entries(this.read()).filter(([epoch, value]) => !epochs.includes(epoch) && parse(value) !== null);
    replaceFile(this.file, JSON.stringify(Object.fromEntries(kept)) + "\n");
  }
}
