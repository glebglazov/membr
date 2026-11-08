#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { lock } from "./lock.ts";
import { migrate } from "./migrate.ts";
import { DEFAULT_AGENT, dataDir, readConfig } from "./config.ts";
import type { Engine } from "./engine.ts";

export const HELP = `usage: membr [AGENT | URL] [--token TOKEN]
       membr agent list | new NAME
       membr server start | stop | status | reload | run
       membr export FILE | import FILE

Opens the chat with an agent in this terminal. With no AGENT, it is the
agent "default". membr starts the local server when it does not run.
config.json in ~/.local/share/membr, or in the directory that MEMBR_DIR
names, sets the server and its agents. With a URL, membr connects to
that server, and to the agent that the URL names (…/membr/NAME), and
starts nothing. A remote server needs the sign-in link that membr server
status prints, or its token with --token.

Agents:
  membr agent list       show the agents, their state and their URLs
  membr agent new NAME   add an agent to config.json and open the file

Server:
  membr server start     start the local server with no chat
  membr server stop      stop the local server until the next membr
  membr server status    show the PID, the addresses, the sign-in link and the log
  membr server reload    read config.json again and show the result
  membr server run       run the server in the foreground (launchd and make run)

Archive:
  membr export FILE      save config.json and every agent to a .tar.gz, with no token
  membr import FILE      restore it into a new or empty base directory

Keys: Enter sends. Shift+Enter, Ctrl+J or a trailing \\ adds a line. Tab
takes the chosen / completion, and Up and Down move through it. PageUp
and PageDown scroll. Esc stops the turn, and Ctrl+C quits.`;

function fail(error: unknown, status = 1): never {
  console.error("membr: " + (error instanceof Error ? error.message : String(error)));
  process.exit(status);
}

function args() {
  try { return parseArgs({ allowPositionals: true, options: { token: { type: "string" }, help: { type: "boolean", default: false } } }); }
  catch (error) { console.error(HELP); fail(error, 2); }
}

function usage(): never {
  console.error(HELP);
  process.exit(2);
}

async function print(lines: Promise<string[]> | string[]): Promise<never> {
  try { for (const line of await lines) console.log(line); }
  catch (error) { fail(error); }
  process.exit(0);
}

// The first word is a command when it is one; a URL when it has a scheme; an agent name in any other case.
export async function main(engine?: Engine) {
  const { positionals, values } = args();
  if (values.help || positionals[0] === "help") { console.log(HELP); return; }
  const [command, sub, name, ...rest] = positionals;
  const dir = dataDir();
  // `serve` is what launchd plists from before `membr server run` start.
  if (command === "serve" && positionals.length === 1) return await serve(dir, engine);
  if (command === "server") {
    if (sub === "run" && positionals.length === 2) return await serve(dir, engine);
    if (positionals.length !== 2) usage();
    const { realHost } = await import("./service.ts");
    const host = process.platform === "darwin" ? realHost() : null;
    const { reloadServer, serverStatus, startServer, stopServer } = await import("./control.ts");
    if (sub === "reload") return await print(reloadServer(dir));
    if (sub === "status") return await print(serverStatus(dir, host));
    if (sub === "stop") return await print(stopServer(dir, host));
    if (sub === "start") return await print(startServer(dir, host));
    usage();
  }
  if (command === "export" || command === "import") {
    if (positionals.length !== 2) usage();
    const { exportArchive, importArchive } = await import("./archive.ts");
    return await print((command === "export" ? exportArchive : importArchive)(dir, sub!));
  }
  if (command === "agent") {
    const { agentList, agentNew } = await import("./control.ts");
    if (sub === "list" && positionals.length === 2) return await print(agentList(dir));
    if (sub === "new" && name !== undefined && !rest.length) return await print(agentNew(dir, name));
    usage();
  }
  if (positionals.length > 1) usage();

  let url: string, token = values.token ?? null;
  if (command !== undefined && command.includes("://")) {
    if (!URL.canParse(command)) usage();
    url = command;
  } else {
    const agent = command ?? DEFAULT_AGENT;
    try {
      const { agents } = readConfig(dir);
      if (!agents.has(agent)) throw new Error(`no agent ${agent}. Agents: ${[...agents.keys()].join(", ")}. Add one with membr agent new ${agent}.`);
    } catch (error) { fail(error); }
    const { realHost, currentSpec } = await import("./service.ts");
    if (process.platform !== "darwin") fail("membr starts its server through launchd, which needs macOS. Run membr server run in another terminal, then membr ws://127.0.0.1:8788/membr/" + agent + "/ws.");
    const { ensureServer } = await import("./control.ts");
    try {
      url = new URL(`membr/${encodeURIComponent(agent)}/`, (await ensureServer({ dir, host: realHost(), spec: currentSpec(dir, process.env) })).url).href;
      // The local token, because a host other than loopback makes even this machine's connection need it.
      token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
    } catch (error) { fail(error); }
  }
  const { runTerm } = await import("../../term/src/run.ts");
  try { await runTerm({ url, token }); } catch (error) { fail(error); }
  process.exit(0);
}

async function serve(dir: string, engine?: Engine) {
  const config = () => readConfig(dir);
  let where = { url: "", tailnet: undefined as string | undefined };
  const taken = await lock(dir, () => ({ pid: process.pid, ...where }));
  if ("heldBy" in taken) fail(`${dir} is in use by another membr server (pid ${taken.heldBy.pid}, ${taken.heldBy.url})`);
  // Only the default base directory has a legacy one: a MEMBR_DIR is the user's own choice.
  if (!process.env.MEMBR_DIR) {
    try { for (const note of await migrate(dir)) console.log("membr: " + note); }
    catch (error) { taken.lock.release(); fail(error); }
  }
  let listen;
  try { listen = config().listen; } catch (error) { taken.lock.release(); fail(error); }

  const { serveHub } = await import("./hub.ts");
  const announce = (url: string, tailnet: string | null) => {
    where = { url, tailnet: tailnet ?? undefined };
    taken.lock.update();
    console.log(`membr: serving ${dir} at ${url} (pid ${process.pid})`);
    if (tailnet) console.log(`membr: on the tailnet at ${tailnet} with no sign-in`);
  };
  let hub: ReturnType<typeof serveHub>;
  try {
    hub = serveHub({ dir, port: listen.port, hostname: listen.host, tailscale: listen.tailscale, engine, config, onListen: announce });
  } catch (error) {
    taken.lock.release();
    fail(error);
  }
  announce(hub.server.url.href, hub.tailnet);
  console.log(`membr: sign in at ${hub.server.url.href}membr/?token=${encodeURIComponent(hub.token)}`);

  process.on("SIGHUP", () => hub.reload());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void hub.close().then(
        () => { taken.lock.release(); process.exit(0); },
        (error) => { taken.lock.release(); fail(error); },
      );
    });
  }
}

if (import.meta.main) await main();
