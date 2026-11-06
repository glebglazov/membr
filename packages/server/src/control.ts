import fs from "node:fs";
import path from "node:path";
import { VERSION, parseEvent, type Answer } from "@membr/protocol";
import { readConfig } from "./config.ts";
import { holder, type Holder } from "./lock.ts";
import { removeService, serviceLabel, serviceStatus, startService, type ServiceHost, type ServiceSpec } from "./service.ts";

// The commands that act on the local server of a data directory. The lock file says which server runs and where;
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
      `membr: sign in at ${running.url}?token=${encodeURIComponent(token(dir))}`,
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
