// Config adapted from UniiChat at commit 0500bf6. Copyright 2026 Higher Order Company.
// Licensed under Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One agent: an endless chat with its own store. home is the directory the Engine runs in, which decides its harness.
// prompt is the agent's own system prompt text. common is the top-level prompt that every agent gets before membr's own.
// approvalTimeout (ms) is how long an unattended approval waits.
export type AgentConfig = Readonly<{ name: string; home: string; prompt: string; common: string; approvalTimeout: number }>;

// Where the hub listens. tailscale puts the loopback port on the tailnet, so it needs host 127.0.0.1.
export type Listen = Readonly<{ port: number; host: string; tailscale: boolean }>;

export type Config = Readonly<{ listen: Listen; agents: ReadonlyMap<string, AgentConfig> }>;

export const DEFAULT_AGENT = "default";
export const APPROVAL_TIMEOUT = 10 * 60_000;
// Who the agents are and how they work. membr's own prompt, which explains the view, zoom and the notebook, stays in code,
// because it must change with the tools it describes.
export const COMMON_PROMPT = "You are Unii, an AI agent that works for one user.\n\nDo the user's tasks yourself, with your tools, following the user's instructions. Use the latest information in the chat.";
const DAY = 24 * 60 * 60_000;
const LOOPBACK = "127.0.0.1";
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// The CLI reads its first word as an agent name unless it is one of its commands.
const RESERVED = new Set(["server", "agent", "help"]);
const AGENT_KEYS = new Set(["prompt", "home", "approvalTimeout"]);
const MOVED: Record<string, string> = {
  home: "home is now a key of each agent: move it to agents.default.home",
  rules: "rules was removed: put the text of the rules file in agents.default.prompt",
  after: "after was removed: membr no longer runs a command after each turn",
};

export function dataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.MEMBR_DIR || path.join(os.homedir(), ".local", "share", "membr");
}

// The agent directory: it holds the agent's store, and its default home in home/.
export function storeDir(dir: string, name: string): string {
  return path.join(dir, "agents", name);
}

export function agentNameError(name: string): string | null {
  if (!NAME.test(name)) return `agent name ${JSON.stringify(name)} must start with a letter and have only letters, digits, - and _ (64 at most)`;
  if (RESERVED.has(name)) return `${name} is a membr command, so it cannot be an agent name`;
  return null;
}

function expand(value: string): string { return value.startsWith("~/") ? os.homedir() + value.slice(1) : value; }

function duration(value: unknown, key: string): number {
  if (value === undefined) return APPROVAL_TIMEOUT;
  const match = typeof value === "string" ? /^(\d+)(s|m|h)$/.exec(value) : null;
  if (!match) throw new Error(`config.json: ${key} must be a number and a unit, such as "90s", "10m" or "2h"`);
  const ms = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"];
  if (ms === 0) throw new Error(`config.json: ${key} must be more than 0`);
  if (ms > DAY) throw new Error(`config.json: ${key} must be 24h or less`);
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

function object(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`config.json: ${key} must be an object`);
  return value as Record<string, unknown>;
}

// A relative home starts at the base directory, because a launchd service starts there and not where the user typed membr.
function promptText(value: unknown, key: string): string {
  if (typeof value !== "string" && !(Array.isArray(value) && value.every((line) => typeof line === "string"))) throw new Error(`config.json: ${key} must be a string or a list of strings`);
  return Array.isArray(value) ? value.join("\n") : value;
}

function agent(dir: string, name: string, raw: unknown, common: string): AgentConfig {
  const key = `agents.${name}`;
  const values = object(raw, key);
  for (const unknown of Object.keys(values).filter((k) => !AGENT_KEYS.has(k))) throw new Error(`config.json: ${key}.${unknown} is not a key of an agent (use prompt, home or approvalTimeout)`);
  const { prompt = "", home } = values;
  if (home !== undefined && (typeof home !== "string" || home === "")) throw new Error(`config.json: ${key}.home must be a path`);
  const homePath = home === undefined ? path.join(storeDir(dir, name), "home") : path.resolve(dir, expand(home));
  if (home !== undefined && !fs.statSync(homePath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`config.json: ${key}.home: ${homePath} is not a directory`);
  return { name, home: homePath, prompt: promptText(prompt, `${key}.prompt`), common, approvalTimeout: duration(values.approvalTimeout, `${key}.approvalTimeout`) };
}

export function readConfig(dir: string): Config {
  const file = path.join(dir, "config.json");
  const values = object(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}, "the file");
  for (const key of Object.keys(MOVED)) if (key in values) throw new Error(`config.json: ${MOVED[key]}`);
  const entries = object(values.agents ?? {}, "agents");
  const agents = new Map<string, AgentConfig>();
  const common = values.prompt === undefined ? COMMON_PROMPT : promptText(values.prompt, "prompt");
  for (const [name, raw] of Object.entries({ [DEFAULT_AGENT]: {}, ...entries })) {
    const error = agentNameError(name);
    if (error) throw new Error(`config.json: agents: ${error}`);
    agents.set(name, agent(dir, name, raw, common));
  }
  return { listen: listen(values), agents };
}
