// Config adapted from UniiChat at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ChatConfig = Readonly<{ afterCommand: string; rulesText: string }>;

export function readConfig(dir: string, env: Readonly<Record<string, string | undefined>> = process.env): ChatConfig {
  const file = path.join(dir, "config.json");
  const raw: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must be an object");
  const values = raw as Record<string, unknown>;
  function get(key: "after" | "rules"): string {
    const value = env["MEMBR_" + key.toUpperCase()] ?? values[key] ?? "";
    if (typeof value !== "string") throw new Error(`config.json: ${key} must be a string`);
    return value;
  }

  const rules = get("rules");
  const rulesPath = rules.startsWith("~/") ? os.homedir() + rules.slice(1) : rules;
  return {
    afterCommand: get("after"),
    rulesText: rulesPath ? fs.readFileSync(rulesPath, "utf8") : "",
  };
}
