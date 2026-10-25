import fs from "node:fs";
import path from "node:path";
import { replaceFile } from "./durable.ts";

export type EpochRecord = { session: string; date: string };

export class Epochs {
  constructor(private readonly dir: string) {}

  record(epoch: string, session: string, date = new Date().toISOString()): void {
    const file = path.join(this.dir, "epochs.json");
    const previous: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    if (previous === null || typeof previous !== "object" || Array.isArray(previous) || Object.values(previous).some((value) => typeof value !== "string" && (!value || typeof value !== "object" || !("session" in value) || typeof value.session !== "string" || !("date" in value) || typeof value.date !== "string"))) throw new Error("Invalid epoch map");
    replaceFile(file, JSON.stringify({ ...previous, [epoch]: { session, date } }) + "\n");
  }

  get list(): Record<string, EpochRecord> {
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

  remove(epochs: string[]): void {
    const all = this.list;
    for (const epoch of epochs) delete all[epoch];
    const file = path.join(this.dir, "epochs.json");
    const previous: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const [epoch, record] of Object.entries(all)) if (record.date === "" && typeof previous[epoch] === "string") (all as Record<string, unknown>)[epoch] = previous[epoch];
    replaceFile(file, JSON.stringify(all) + "\n");
  }
}
