import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lock } from "./lock.ts";
import { replaceFile } from "./durable.ts";

// The data directory before membr held many agents. Its chat becomes the agent "default".
export const LEGACY_DIR = path.join(os.homedir(), ".membr");

// Files of the server, not of the chat: they stay out of the default agent's store.
const SERVER_FILES = new Set(["config.json", "token", "lock", "lock.guard", "serve.log"]);
// The chat's log. It moves last, so while it is in the legacy directory the move is not done, and a move that
// stopped halfway runs again and skips what is already in place.
const LOG = "main";

// Moves a legacy data directory into `base` one time. A config.json that is in `base` already, for example one that
// chezmoi wrote, stays as it is; else the legacy config.json is changed to the new form.
export async function migrate(base: string, legacy = LEGACY_DIR, store = path.join(base, "agents", "default")): Promise<string[]> {
  if (!fs.statSync(path.join(legacy, LOG), { throwIfNoEntry: false })?.isDirectory()) return [];
  if (fs.existsSync(path.join(store, LOG))) throw new Error(`the agent "default" has a chat in ${store} and ${legacy} has one too. Move one of them away, then start membr again.`);
  const taken = await lock(legacy, () => ({ pid: process.pid, url: "" }));
  if ("heldBy" in taken) throw new Error(`${legacy} is in use by an old membr server (pid ${taken.heldBy.pid}). Stop it, then start membr again.`);
  try {
    const notes: string[] = [];
    const ownConfig = !fs.existsSync(path.join(base, "config.json"));
    const config = ownConfig ? legacyConfig(legacy, notes) : null;
    fs.mkdirSync(store, { recursive: true });
    const names = fs.readdirSync(legacy).filter((name) => !SERVER_FILES.has(name) && name !== config?.rulesFile && name !== LOG);
    for (const name of [...names, LOG]) fs.renameSync(path.join(legacy, name), path.join(store, name));
    for (const name of ["token", "serve.log"]) {
      const from = path.join(legacy, name);
      if (fs.existsSync(from) && !fs.existsSync(path.join(base, name))) fs.renameSync(from, path.join(base, name));
    }
    if (config) replaceFile(path.join(base, "config.json"), JSON.stringify(config.next, null, 2) + "\n");
    else notes.push(`kept ${path.join(base, "config.json")}; ${path.join(legacy, "config.json")} was not used`);
    notes.unshift(`moved ${legacy} to ${base}; its chat is now the agent "default"`);
    return notes;
  } finally { taken.lock.release(); }
}

// The legacy keys map to the new file: listen keys stay at the top, home and approvalTimeout go to agents.default, the rules
// file's text becomes its prompt, and after is dropped. Relative paths started at the legacy directory, so they become absolute.
function legacyConfig(legacy: string, notes: string[]): { next: Record<string, unknown>; rulesFile: string | null } {
  const file = path.join(legacy, "config.json");
  const raw: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} must be an object`);
  const { home, rules, after, approvalTimeout, ...top } = raw as Record<string, unknown>;
  const expand = (value: string) => path.resolve(legacy, value.startsWith("~/") ? os.homedir() + value.slice(1) : value);
  const agent: Record<string, unknown> = {};
  if (typeof home === "string" && home) agent.home = expand(home);
  if (approvalTimeout !== undefined) agent.approvalTimeout = approvalTimeout;
  let rulesFile: string | null = null;
  if (typeof rules === "string" && rules) {
    const rulesPath = expand(rules);
    agent.prompt = fs.readFileSync(rulesPath, "utf8").trimEnd();
    if (path.dirname(rulesPath) === path.resolve(legacy)) rulesFile = path.basename(rulesPath);
  }
  if (after !== undefined) notes.push(`dropped the after command ${JSON.stringify(after)}: membr no longer runs a command after each turn`);
  return { next: { ...top, agents: { default: agent } }, rulesFile };
}
