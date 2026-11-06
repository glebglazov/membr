// Config adapted from UniiChat at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// home is the directory the Engine runs in, which decides the harness. null means the server's working directory.
// approvalTimeout (ms) is how long an unattended approval waits before membr denies it.
export type ChatConfig = Readonly<{ home: string | null; afterCommand: string; rulesText: string; approvalTimeout: number }>;

// Where the hub listens. tailscale puts the loopback port on the tailnet, so it needs host 127.0.0.1.
export type Listen = Readonly<{ port: number; host: string; tailscale: boolean }>;

export type Config = ChatConfig & Readonly<{ listen: Listen }>;

export const APPROVAL_TIMEOUT = 10 * 60_000;
const DAY = 24 * 60 * 60_000;
const LOOPBACK = "127.0.0.1";

export function dataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.MEMBR_DIR || path.join(os.homedir(), ".membr");
}

function expand(value: string): string { return value.startsWith("~/") ? os.homedir() + value.slice(1) : value; }

function duration(value: unknown): number {
  if (value === undefined) return APPROVAL_TIMEOUT;
  const match = typeof value === "string" ? /^(\d+)(s|m|h)$/.exec(value) : null;
  if (!match) throw new Error('config.json: approvalTimeout must be a number and a unit, such as "90s", "10m" or "2h"');
  const ms = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"];
  if (ms === 0) throw new Error("config.json: approvalTimeout must be more than 0");
  if (ms > DAY) throw new Error("config.json: approvalTimeout must be 24h or less");
  return ms;
}

function listen(values: Record<string, unknown>): Listen {
  const { port = 8788, host = LOOPBACK, tailscale = false } = values;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("config.json: port must be a whole number from 0 to 65535");
  if (typeof host !== "string" || host === "") throw new Error("config.json: host must be an address, such as \"127.0.0.1\"");
  if (typeof tailscale !== "boolean") throw new Error("config.json: tailscale must be true or false");
  if (tailscale && host !== LOOPBACK) throw new Error("config.json: tailscale serves on 127.0.0.1 behind tailscale serve, so remove host or set it to 127.0.0.1");
  return { port, host, tailscale };
}

// Relative paths start at the data directory, because a launchd service starts there and not where the user typed membr.
export function readConfig(dir: string): Config {
  const file = path.join(dir, "config.json");
  const raw: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must be an object");
  const values = raw as Record<string, unknown>;
  function get(key: "after" | "rules" | "home"): string {
    const value = values[key] ?? "";
    if (typeof value !== "string") throw new Error(`config.json: ${key} must be a string`);
    return value;
  }

  const home = get("home");
  const homePath = home ? path.resolve(dir, expand(home)) : null;
  if (homePath !== null && !fs.statSync(homePath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`config.json: home: ${homePath} is not a directory`);
  const rules = get("rules");
  return {
    home: homePath,
    afterCommand: get("after"),
    rulesText: rules ? fs.readFileSync(path.resolve(dir, expand(rules)), "utf8") : "",
    approvalTimeout: duration(values.approvalTimeout),
    listen: listen(values),
  };
}
