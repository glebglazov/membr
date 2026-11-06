import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import type { FakeEngine } from "../../server/test/engine.ts";

// The real hub over a fake Engine, the way the web e2e tests start one. Pass `dir` and `port` to bring a hub back where an earlier one stood.
export async function startHub(engine: FakeEngine, where: { dir?: string; port?: number } = {}) {
  const dir = where.dir ?? mkdtempSync(path.join(tmpdir(), "membr-term-"));
  const hub = serveHub({ dir, port: where.port ?? 0, engine });
  // The fake Engine lists its skills when the first epoch opens, so give it a moment before a client says hello.
  await Bun.sleep(50);
  return {
    hub, dir, port: hub.server.port,
    url: hub.server.url.href.replace("http:", "ws:") + "ws",
    async close() { await hub.close(); },
    remove() { rmSync(dir, { recursive: true, force: true }); },
  };
}
