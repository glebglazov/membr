#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { lock } from "./lock.ts";
import { dataDir, readConfig } from "./config.ts";
import type { Engine } from "./engine.ts";

export const HELP = `usage: membr [URL] [--token TOKEN]
       membr reload | status | stop

Opens the chat in this terminal. With no URL, membr starts the local
server when it does not run. Server options come from config.json in
~/.membr, or in the directory that MEMBR_DIR names. With a URL, membr
connects to that server and starts nothing. A remote server needs the
sign-in link that membr status prints, or its token with --token.

Commands:
  membr reload    read config.json again and show the result
  membr status    show the PID, the address, the sign-in link and the log path
  membr stop      stop the local server until the next membr

Keys: Enter sends. Shift+Enter, Ctrl+J or a trailing \\ adds a line. Tab
takes the chosen / completion, and Up and Down move through it. PageUp
and PageDown scroll. Esc stops the turn, and Ctrl+C quits.

membr serve runs the server in the foreground. launchd and make run use it.`;

function fail(error: unknown, status = 1): never {
  console.error("membr: " + (error instanceof Error ? error.message : String(error)));
  process.exit(status);
}

function args() {
  try { return parseArgs({ allowPositionals: true, options: { token: { type: "string" }, help: { type: "boolean", default: false } } }); }
  catch (error) { console.error(HELP); fail(error, 2); }
}

export async function main(engine?: Engine) {
  const { positionals, values } = args();
  if (values.help) { console.log(HELP); return; }
  if (positionals.length > 1) { console.error(HELP); process.exit(2); }

  const [command] = positionals;
  const dir = dataDir();
  if (command === "serve") return await serve(dir, engine);

  const { realHost } = await import("./service.ts");
  const host = process.platform === "darwin" ? realHost() : null;
  if (command === "reload" || command === "status" || command === "stop") {
    const { reloadServer, serverStatus, stopServer } = await import("./control.ts");
    try {
      const lines = command === "reload" ? await reloadServer(dir) : command === "status" ? serverStatus(dir, host) : await stopServer(dir, host);
      for (const line of lines) console.log(line);
    } catch (error) { fail(error); }
    process.exit(0);
  }

  let url = command, token = values.token ?? null;
  if (url !== undefined && !URL.canParse(url)) { console.error(HELP); process.exit(2); }
  if (url === undefined) {
    if (!host) fail("membr starts its server through launchd, which needs macOS. Run membr serve in another terminal, then membr ws://127.0.0.1:8788/ws.");
    const { ensureServer } = await import("./control.ts");
    const { currentSpec } = await import("./service.ts");
    try {
      url = (await ensureServer({ dir, host, spec: currentSpec(dir, process.env) })).url;
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
  let listen;
  try { listen = config().listen; } catch (error) { fail(error); }
  let where = { url: "", tailnet: undefined as string | undefined };
  const taken = await lock(dir, () => ({ pid: process.pid, ...where }));
  if ("heldBy" in taken) fail(`${dir} is in use by another membr server (pid ${taken.heldBy.pid}, ${taken.heldBy.url})`);

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
  console.log(`membr: sign in at ${hub.server.url.href}?token=${encodeURIComponent(hub.token)}`);

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
