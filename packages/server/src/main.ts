#!/usr/bin/env bun
// the one `membr` entry point. `membr serve` takes the data directory's lock,
// then listens on loopback.
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { lock } from "./lock.ts";
import { serveHub } from "./hub.ts";

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
let url = "";
const taken = await lock(dir, () => ({ pid: process.pid, url }));
if ("heldBy" in taken) {
  console.error(`membr: ${dir} is in use by another membr server (pid ${taken.heldBy.pid}, ${taken.heldBy.url})`);
  process.exit(1);
}

const { server, token } = serveHub({ dir, port });
url = server.url.href;
console.log(`membr: serving ${dir} at ${url}`);
console.log(`membr: sign in at ${url}?token=${encodeURIComponent(token)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop(true);
    taken.lock.release();
    process.exit(0);
  });
}
