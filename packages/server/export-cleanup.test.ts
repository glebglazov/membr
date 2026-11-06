import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Epochs } from "./src/epochs.ts";
import { cleanupEpochs } from "./src/export-cleanup.ts";
import { FakeEngine } from "./test/engine.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("cleanup deletes epochs older than 30 days in the directory each one ran in, and keeps the current epoch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-export-cleanup-"));
  dirs.push(dir);
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  const old = new Date(now - 31 * 86_400_000).toISOString();
  fs.writeFileSync(path.join(dir, "epochs.json"), JSON.stringify({ legacy: "legacy-session", unhomed: { session: "unhomed-session", date: old } }));
  const epochs = new Epochs(dir);
  epochs.record("old", "old-session", "/vault", old);
  epochs.record("moved", "moved-session", "/elsewhere", old);
  epochs.record("edge", "edge-session", "/vault", new Date(now - 30 * 86_400_000).toISOString());
  epochs.record("current", "current-session", "/vault", new Date(now - 60 * 86_400_000).toISOString());
  const engine = new FakeEngine();
  const deleted: Array<[string, string | undefined]> = [];
  engine.deleteSession = async (session, cwd) => { deleted.push([session, cwd]); };
  await cleanupEpochs(epochs, engine, "current", now, "/server");
  expect(deleted.toSorted()).toEqual([["moved-session", "/elsewhere"], ["old-session", "/vault"], ["unhomed-session", "/server"]]);
  expect(Object.keys(epochs.list)).toEqual(["legacy", "edge", "current"]);
});
