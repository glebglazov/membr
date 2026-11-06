#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { lock } from "./lock.ts";
import { dataDir, readConfig } from "./config.ts";
import { parseServeOptions } from "./serve-options.ts";
import type { Engine } from "./engine.ts";

export async function main(engine?: Engine) {
  const USAGE = "usage: membr serve [--port N] [--host ADDRESS | --tailscale] [--home PATH]\n       membr service install|uninstall|status|reload\n       membr term [url] [--token TOKEN]";

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { port: { type: "string" }, host: { type: "string" }, tailscale: { type: "boolean", default: false }, token: { type: "string" }, home: { type: "string" }, help: { type: "boolean", default: false } },
  });

  if (positionals[0] === "term") {
    const { runTerm, TERM_USAGE } = await import("../../term/src/run.ts");
    if (values.help) { console.log(TERM_USAGE); return; }
    try { await runTerm({ url: positionals[1], token: values.token }); } catch (error) {
      console.error("membr: " + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
    process.exit(0);
  }

  if (positionals[0] !== "serve" && positionals[0] !== "service") {
    console.error(USAGE);
    process.exit(2);
  }

  let options: ReturnType<typeof parseServeOptions>;
  try { options = parseServeOptions(values); } catch (error) {
    console.error("membr: " + (error instanceof Error ? error.message : String(error)));
    process.exit(2);
  }

  const dir = dataDir();

  if (positionals[0] === "service") {
    const { runService, realHost, SERVICE_USAGE } = await import("./service.ts");
    if (values.help || positionals[1] === undefined) { console.log(SERVICE_USAGE); return; }
    if (process.platform !== "darwin") {
      console.error("membr: membr service needs macOS, because it writes a launchd agent");
      process.exit(2);
    }
    try {
      process.exit(runService(positionals[1], options, { env: process.env, dir, host: realHost(), log: console.log }));
    } catch (error) {
      console.error("membr: " + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  }

  const config = () => readConfig(dir, process.env, values.home);
  try { config(); } catch (error) {
    console.error("membr: " + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
  let url = "";
  const taken = await lock(dir, () => ({ pid: process.pid, url }));
  if ("heldBy" in taken) {
    console.error(`membr: ${dir} is in use by another membr server (pid ${taken.heldBy.pid}, ${taken.heldBy.url})`);
    process.exit(1);
  }

  const { serveHub } = await import("./hub.ts");
  const hub = serveHub({ dir, port: options.port ?? 8788, hostname: options.host ?? "127.0.0.1", engine, config });
  const { server, token, close } = hub;
  url = server.url.href;
  taken.lock.update();
  console.log(`membr: serving ${dir} at ${url} (pid ${process.pid})`);
  console.log(`membr: sign in at ${url}?token=${encodeURIComponent(token)}`);

  if (options.tailscale) {
    const { tailscaleServe } = await import("./tailscale.ts");
    try {
      console.log(`membr: on the tailnet at ${tailscaleServe(Number(new URL(url).port))} with no sign-in`);
    } catch (error) {
      console.error("membr: " + (error instanceof Error ? error.message : String(error)));
      await close();
      taken.lock.release();
      process.exit(1);
    }
  }

  process.on("SIGHUP", () => hub.reload());

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void close().then(
        () => { taken.lock.release(); process.exit(0); },
        (error) => {
          console.error("membr: " + (error instanceof Error ? error.message : String(error)));
          taken.lock.release();
          process.exit(1);
        },
      );
    });
  }
}

if (import.meta.main) await main();
