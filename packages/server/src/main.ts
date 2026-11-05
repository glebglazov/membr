#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { lock } from "./lock.ts";
import { readConfig } from "./config.ts";
import type { Engine } from "./engine.ts";

export async function main(engine?: Engine) {
  const USAGE = "usage: membr serve [--port N] [--host ADDRESS | --tailscale]";

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { port: { type: "string", default: "8788" }, host: { type: "string" }, tailscale: { type: "boolean", default: false } },
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

  if (values.tailscale && values.host !== undefined) {
    console.error("membr: --tailscale serves on 127.0.0.1 behind tailscale serve, so it takes no --host");
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

  const { serveHub } = await import("./hub.ts");
  const { server, token, close } = serveHub({ dir, port, hostname: values.host ?? "127.0.0.1", engine, config });
  url = server.url.href;
  taken.lock.update();
  console.log(`membr: serving ${dir} at ${url}`);
  console.log(`membr: sign in at ${url}?token=${encodeURIComponent(token)}`);

  if (values.tailscale) {
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
