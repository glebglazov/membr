import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "./src/log.ts";
import { cleanupEpochs } from "./src/export-cleanup.ts";
import { FakeEngine } from "./test/engine.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("cleanup deletes epochs older than 30 days and keeps the current epoch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-export-cleanup-"));
  dirs.push(dir);
  const log = new Log(dir);
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  log.epoch("old", "old-session", new Date(now - 31 * 86_400_000).toISOString());
  log.epoch("edge", "edge-session", new Date(now - 30 * 86_400_000).toISOString());
  log.epoch("current", "current-session", new Date(now - 60 * 86_400_000).toISOString());
  const engine = new FakeEngine();
  const deleted: string[] = [];
  engine.deleteSession = async (session) => { deleted.push(session); };
  await cleanupEpochs(log, engine, "current", now);
  expect(deleted).toEqual(["old-session"]);
  expect(Object.keys(log.epochs)).toEqual(["edge", "current"]);
});
