import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatStatus } from "@membr/protocol";

// open and close are this terminal client's own start and end. The others are the chat statuses that the server sends.
export type HookEvent = "open" | ChatStatus | "close";
export type Hooks = Partial<Record<HookEvent, string>>;

const EVENTS: readonly HookEvent[] = ["open", "working", "blocked", "done", "failed", "close"];
// A hook that hangs must not keep the terminal from closing.
const TIMEOUT = 10_000;

export function hooksFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "membr", "hooks.json");
}

// No file means no hooks. A file with an error stops membr before it takes the terminal, so the error stays readable.
export function readHooks(file: string): Hooks {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let values: unknown;
  try { values = JSON.parse(text); } catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
  if (typeof values !== "object" || values === null || Array.isArray(values)) throw new Error(`${file}: must be an object from event to command`);
  const hooks: Hooks = {};
  for (const [event, command] of Object.entries(values)) {
    if (!EVENTS.includes(event as HookEvent)) throw new Error(`${file}: ${event} is not an event. The events are ${EVENTS.join(", ")}`);
    if (typeof command !== "string") throw new Error(`${file}: ${event} must be a shell command`);
    hooks[event as HookEvent] = command;
  }
  return hooks;
}

export type HookRunner = {
  // Runs the hook of the status when it differs from the last status. null is no status, and runs nothing.
  status(status: ChatStatus | null): void;
  // Runs the close hook and resolves when every hook has finished.
  close(): Promise<void>;
};

// Runs the open hook at once. Each hook runs with sh in this process's environment, which keeps TMUX_PANE and the like, plus MEMBR_EVENT and MEMBR_AGENT.
// Hooks run one after another in event order. The screen belongs to ink, so their output and their failures are dropped.
export function startHooks({ hooks, agent, env = process.env }: { hooks: Hooks; agent: string; env?: Readonly<Record<string, string | undefined>> }): HookRunner {
  let last: ChatStatus | null | undefined;
  let queue = Promise.resolve();
  const run = (event: HookEvent) => {
    const command = hooks[event];
    if (command === undefined) return;
    queue = queue.then(async () => {
      try {
        const child = Bun.spawn(["sh", "-c", command], { env: { ...env, MEMBR_EVENT: event, MEMBR_AGENT: agent }, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: TIMEOUT });
        await child.exited;
      } catch {}
    });
  };
  run("open");
  return {
    status(status) {
      if (status === last) return;
      last = status;
      if (status !== null) run(status);
    },
    close() {
      run("close");
      return queue;
    },
  };
}
