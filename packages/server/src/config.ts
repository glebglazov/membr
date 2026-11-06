// Config adapted from UniiChat at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// home is the directory the Engine runs in, which decides the harness. null means the server's working directory.
export type ChatConfig = Readonly<{ home: string | null; afterCommand: string; rulesText: string }>;

export function dataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.MEMBR_DIR || path.join(os.homedir(), ".membr");
}

function expand(value: string): string { return value.startsWith("~/") ? os.homedir() + value.slice(1) : value; }

// The --home flag wins over MEMBR_HOME, which wins over the file. A relative path in the file is relative to the data
// directory, because a launchd service starts in /.
export function readConfig(dir: string, env: Readonly<Record<string, string | undefined>> = process.env, homeFlag?: string): ChatConfig {
  const file = path.join(dir, "config.json");
  const raw: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must be an object");
  const values = raw as Record<string, unknown>;
  function get(key: "after" | "rules" | "home"): string {
    const value = env["MEMBR_" + key.toUpperCase()] ?? values[key] ?? "";
    if (typeof value !== "string") throw new Error(`config.json: ${key} must be a string`);
    return value;
  }

  const [home, source, base] = homeFlag !== undefined ? [homeFlag, "--home", process.cwd()]
    : env.MEMBR_HOME !== undefined ? [env.MEMBR_HOME, "MEMBR_HOME", process.cwd()]
    : [get("home"), "config.json: home", dir];
  const homePath = home ? path.resolve(base, expand(home)) : null;
  if (homePath !== null && !fs.statSync(homePath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${source}: ${homePath} is not a directory`);
  const rules = get("rules");
  const rulesPath = rules ? path.resolve(env.MEMBR_RULES !== undefined ? process.cwd() : dir, expand(rules)) : "";
  return {
    home: homePath,
    afterCommand: get("after"),
    rulesText: rulesPath ? fs.readFileSync(rulesPath, "utf8") : "",
  };
}
