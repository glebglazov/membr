import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectSession } from "../src/session.ts";
import { hooksFile, readHooks, startHooks } from "../src/hooks.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";
import { startHub } from "./hub.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until<T>(check: () => T | false | undefined, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function configDir(hooks: unknown): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "membr-hooks-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "membr"));
  writeFileSync(path.join(dir, "membr", "hooks.json"), typeof hooks === "string" ? hooks : JSON.stringify(hooks));
  return { XDG_CONFIG_HOME: dir };
}

test("a terminal chat runs the hook of each event in order, with the event, the agent and its own environment", async () => {
  const env = configDir({});
  const record = path.join(env.XDG_CONFIG_HOME!, "events");
  const line = `echo "$MEMBR_EVENT $MEMBR_AGENT $TMUX_PANE" >> '${record}'`;
  writeFileSync(hooksFile(env), JSON.stringify({ open: line, working: line, done: line, close: line }));
  const events = () => { try { return readFileSync(record, "utf8").trim().split("\n"); } catch { return []; } };

  const engine = new FakeEngine();
  const server = await startHub(engine);
  cleanups.push(() => server.remove(), () => server.close());
  const session = connectSession({ url: server.url, token: null, delays: [50] });
  cleanups.push(() => session.close());
  const runner = startHooks({ hooks: readHooks(hooksFile(env)), agent: "research", env: { ...process.env, TMUX_PANE: "%7" } });
  session.subscribe(() => { const status = session.model().state.status; if (status !== undefined) runner.status(status); });

  await until(() => session.model().state.status === null, "the chat to connect");
  session.input({ type: "send", id: "work", text: "Work" });
  await until(() => events().includes("working research %7"), "the working hook");
  engine.epochs[0]!.emit({ ...END, reply: "Done" });
  await until(() => events().includes("done research %7"), "the done hook");
  await runner.close();

  expect(events()).toEqual(["open research %7", "working research %7", "done research %7", "close research %7"]);
});

test("a hooks file with an unknown event or a command that is not text stops membr with the reason", () => {
  expect(() => readHooks(hooksFile(configDir({ stop: "true" })))).toThrow("stop is not an event. The events are open, working, blocked, done, failed, close");
  expect(() => readHooks(hooksFile(configDir({ done: ["true"] })))).toThrow("done must be a shell command");
  expect(() => readHooks(hooksFile(configDir("{")))).toThrow("hooks.json");
});

test("no hooks file means no hooks", () => {
  expect(readHooks(hooksFile({ XDG_CONFIG_HOME: path.join(tmpdir(), "membr-no-such-dir") }))).toEqual({});
});
