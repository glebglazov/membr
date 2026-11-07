import fs from "node:fs";
import path from "node:path";
import { VERSION, parseEvent, type Answer } from "@membr/protocol";
import { agentNameError, readConfig } from "./config.ts";
import { replaceFile } from "./durable.ts";
import { currentSpec } from "./service.ts";
import { holder, type Holder } from "./lock.ts";
import { removeService, serviceLabel, serviceStatus, startService, type ServiceHost, type ServiceSpec } from "./service.ts";

// The commands that act on the local server of a base directory. The lock file says which server runs and where;
// launchd starts and stops it. Each command returns the lines to print, and throws when it fails.

const START_TIMEOUT = 15_000;

function tail(file: string, lines = 20): string {
  if (!fs.existsSync(file)) return "(no log yet)";
  return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

// Converges on "a server runs for dir and listens". A running server is used as it is, even one that `make run` started.
export async function ensureServer(ctx: Readonly<{ dir: string; host: ServiceHost; spec: ServiceSpec; timeout?: number }>): Promise<Holder> {
  const running = holder(ctx.dir);
  if (running?.url) return running;
  if (!running) {
    // A config error would make launchd start a server that fails again every 10 seconds, so it stops here.
    readConfig(ctx.dir);
    fs.mkdirSync(ctx.dir, { recursive: true });
    startService(ctx.spec, ctx.host);
  }
  const timeout = ctx.timeout ?? START_TIMEOUT;
  for (const end = Date.now() + timeout; ; await Bun.sleep(100)) {
    const now = holder(ctx.dir);
    if (now?.url) return now;
    if (Date.now() > end) throw new Error(`the server did not start within ${timeout / 1000} seconds. The end of ${ctx.spec.logPath}:\n${tail(ctx.spec.logPath)}`);
  }
}

function token(dir: string): string {
  return fs.readFileSync(path.join(dir, "token"), "utf8").trim();
}

function socketAddress(url: string): string {
  const address = new URL("ws", url);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return address.href;
}

async function reloadAct(url: string, bearer: string): Promise<Answer> {
  const id = "reload-" + crypto.randomUUID();
  const socket = new WebSocket(socketAddress(url));
  try {
    return await new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${url} did not answer within 15 seconds`)), 15_000);
      const settle = (done: () => void) => { clearTimeout(timer); done(); };
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", version: VERSION, kind: "term", device: null, token: bearer }));
      socket.onmessage = (message) => {
        const event = parseEvent(JSON.parse(String(message.data)));
        if (event.type === "ready") socket.send(JSON.stringify({ type: "act", id, act: "reload" }));
        else if (event.type === "answer" && event.id === id) settle(() => resolve(event));
        else if (event.type === "refused") settle(() => reject(new Error(event.reason)));
      };
      socket.onclose = () => settle(() => reject(new Error(`${url} closed the connection before it answered`)));
    });
  } finally { socket.close(); }
}

export async function reloadServer(dir: string): Promise<string[]> {
  const before = holder(dir);
  if (!before?.url) return ["membr: no server runs. The next start reads config.json."];
  const answer = await reloadAct(before.url, token(dir));
  if (!answer.ok) throw new Error(answer.reason);
  const after = holder(dir);
  return [
    "membr: config reloaded",
    ...after && after.url !== before.url ? [`membr: the server now listens at ${after.url}`] : [],
    ...after && after.tailnet !== before.tailnet ? [after.tailnet ? `membr: on the tailnet at ${after.tailnet}` : "membr: no longer on the tailnet"] : [],
  ];
}

// host is null where there is no launchd.
export function serverStatus(dir: string, host: ServiceHost | null): string[] {
  const running = holder(dir);
  const lines = !running ? [`membr: no server runs for ${dir}`]
    : !running.url ? [`membr: the server starts (pid ${running.pid})`]
    : [
      `membr: the server runs (pid ${running.pid}) at ${running.url}`,
      ...running.tailnet ? [`membr: on the tailnet at ${running.tailnet}`] : [],
      `membr: sign in at ${running.url}membr/?token=${encodeURIComponent(token(dir))}`,
      ...agentUrls(dir, running),
    ];
  if (host) {
    const label = serviceLabel(dir);
    const service = serviceStatus(host, label);
    lines.push(`membr: launchd agent ${label} ${service.loaded ? "loaded" : "not loaded"}, plist ${service.plistPath}${service.installed ? "" : " (not installed)"}`);
  }
  lines.push(`membr: log ${path.join(dir, "serve.log")}`);
  return lines;
}

// Stops the server until the next membr, also one that `make run` started.
export async function stopServer(dir: string, host: ServiceHost | null): Promise<string[]> {
  const removed = host ? removeService(host, serviceLabel(dir)) : false;
  const running = holder(dir);
  if (running) process.kill(running.pid, "SIGTERM");
  for (let waited = 0; holder(dir); waited += 100) {
    if (waited >= 10_000) throw new Error(`the server (pid ${running?.pid}) did not stop within 10 seconds`);
    await Bun.sleep(100);
  }
  return [removed || running ? "membr: the server stopped" : "membr: no server runs"];
}

// Each agent's address on this machine, and on the tailnet when the server is there too.
function agentUrls(dir: string, running: Holder): string[] {
  let names: string[];
  try { names = [...readConfig(dir).agents.keys()]; } catch { return []; }
  return names.map((name) => `membr: agent ${name} at ${new URL(`membr/${name}/`, running.url).href}${running.tailnet ? ` and ${new URL(`${name}/`, running.tailnet).href}` : ""}`);
}

// Converges on "the server runs", with no chat: launchd starts it when it does not run.
export async function startServer(dir: string, host: ServiceHost | null): Promise<string[]> {
  if (!host) throw new Error("membr starts its server through launchd, which needs macOS. Run membr server run instead.");
  await ensureServer({ dir, host, spec: currentSpec(dir, process.env) });
  return serverStatus(dir, host);
}

type Listed = { name: string; busy: boolean };

// The agents of config.json; with a running server, also whether each one works on a turn now.
export async function agentList(dir: string): Promise<string[]> {
  const { agents } = readConfig(dir);
  const running = holder(dir);
  let live: Map<string, boolean> | null = null;
  if (running?.url) {
    try {
      const response = await fetch(new URL("membr/agents.json", running.url), { headers: { Authorization: `Bearer ${token(dir)}` } });
      if (response.ok) live = new Map(((await response.json()) as Listed[]).map((agent) => [agent.name, agent.busy]));
    } catch { live = null; }
  }
  return [...agents.values()].map((agent) => {
    const state = live === null ? "stopped" : live.get(agent.name) ? "working" : "idle";
    const about = agent.prompt.split("\n").find((line) => line.trim())?.trim() ?? "";
    return [agent.name, state, `home ${agent.home}`, ...about ? [about] : []].join("  ");
  });
}

// Adds an empty entry for the agent to config.json and opens the file in the editor, so the prompt goes in next.
// A running server reads the file again after that.
export async function agentNew(dir: string, name: string): Promise<string[]> {
  const error = agentNameError(name);
  if (error) throw new Error(error);
  const file = path.join(dir, "config.json");
  const raw: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must be an object");
  const values = raw as Record<string, unknown>;
  const entries = (values.agents ?? {}) as Record<string, unknown>;
  if (name in entries || name === "default") throw new Error(`the agent ${name} is in config.json already`);
  fs.mkdirSync(dir, { recursive: true });
  replaceFile(file, JSON.stringify({ ...values, agents: { ...entries, [name]: { prompt: "" } } }, null, 2) + "\n");
  const lines = [`membr: added the agent ${name} to ${file}`];
  if (process.stdin.isTTY) {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    Bun.spawnSync(["/bin/sh", "-c", `${editor} "$1"`, "sh", file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } else lines.push(`membr: write its prompt in agents.${name}.prompt`);
  readConfig(dir);
  if (holder(dir)?.url) lines.push(...await reloadServer(dir));
  lines.push(`membr: open it with membr ${name}`);
  return lines;
}
