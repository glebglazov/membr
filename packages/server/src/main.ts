#!/usr/bin/env bun
// the one `membr` entry point. `membr serve` takes the data directory's lock,
// then listens on loopback.
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { lock } from "./lock.ts";
import { readConfig } from "./config.ts";
import type { Engine } from "./engine.ts";

export async function main(engine?: Engine) {
  const USAGE = "usage: membr serve [--port N]";

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { port: { type: "string", default: "8788" } },
  });

  if (positionals[0] !== "serve") {
    console.error(USAGE);
    process.exit(2);
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`membr: --port must be a port number, not "${values.port}"`);
    process.exit(2);
  }

  const dir = process.env.MEMBR_DIR || path.join(os.homedir(), ".membr");
  const config = readConfig(dir);
  let url = "";
  const taken = await lock(dir, () => ({ pid: process.pid, url }));
  if ("heldBy" in taken) {
    console.error(`membr: ${dir} is in use by another membr server (pid ${taken.heldBy.pid}, ${taken.heldBy.url})`);
    process.exit(1);
  }

  // Bun 1.3.14 refuses Unix socket probes after the SDK loads node:net.
  const { serveHub } = await import("./hub.ts");
  const { server, token, close } = serveHub({ dir, port, engine, config });
  url = server.url.href;
  console.log(`membr: serving ${dir} at ${url}`);
  console.log(`membr: sign in at ${url}?token=${encodeURIComponent(token)}`);

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
