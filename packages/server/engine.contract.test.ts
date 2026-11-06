// S3, the P0 gate: the Engine against the real Agent SDK, on the user's plan.
// It runs only with MEMBR_REAL_SDK=1. Each check writes what it measured to
// docs/p0-results.json, which docs/p0-report.md reads from.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claude, type EngineEvent, type Epoch, type EpochOptions, type Pick, type Usage } from "./src/engine.ts";

const REAL = process.env.MEMBR_REAL_SDK === "1";
const RESULTS = path.join(import.meta.dir, "../../docs/p0-results.json");
const MINUTE = 60_000;

function record(check: string, result: Record<string, unknown>) {
  const all = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : {};
  all[check] = { ...result, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(all, null, 2) + "\n");
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "membr-p0-"));
}

// a view of about `bytes`: summary lines as the tree writes them, with a
// code word in line 7 that a turn can ask for
const WORDS = "user unii tool echo build deploy config server branch commit test cache login token memory tree view zoom".split(" ");
function view(bytes: number): string {
  const lines: string[] = [];
  let seed = 7;
  for (let id = 0; lines.join("\n").length < bytes - 600; id++) {
    const words: string[] = [];
    while (words.join(" ").length < 480) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      words.push(WORDS[seed % WORDS.length]! + (seed % 97));
    }
    lines.push(`${id}+1|${id === 7 ? "user: the code word is MARMOT-17; " : "user: "}${words.join(" ")}`);
  }
  return `<chat>\n${lines.join("\n")}\n</chat>`;
}

function options(pick: Partial<Pick>, extra: Partial<EpochOptions> = {}): EpochOptions {
  return { pick: { model: "sonnet", effort: "low", fast: false, ...pick }, append: "", cwd: tmp(), ...extra };
}

// reads an epoch's events turn by turn
function reader(epoch: Epoch) {
  const events = epoch.events[Symbol.asyncIterator]();
  return {
    async next(): Promise<EngineEvent> {
      const { value, done } = await events.next();
      if (done) {
        throw new Error("the epoch ended");
      }
      return value;
    },
    async turn(seen: EngineEvent[] = []) {
      for (;;) {
        const event = await this.next();
        seen.push(event);
        if (event.kind === "end") {
          return { events: seen, end: event };
        }
      }
    },
  };
}

function share(usage: Usage): number {
  return usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite);
}

describe.skipIf(!REAL)("S3 engine contract", () => {
  test("1. accountInfo shows a subscription with no API key", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const clean = await claude.account();
    process.env.ANTHROPIC_API_KEY = "sk-ant-membr-p0-not-a-key";
    const stray = await claude.account().finally(() => {
      process.env.ANTHROPIC_API_KEY = before;
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    });
    record("1-account", { clean, withStrayKeyInShell: stray });
    expect(clean.subscription).toBeTruthy();
    expect(clean.apiKeySource).toBeNull();
    expect(stray).toMatchObject({ subscription: clean.subscription, apiKeySource: null });
  }, MINUTE);

  test("2. an epoch of 30 turns reads 90% of its input from the cache after turn 2", async () => {
    const epoch = claude.open(view(60 * 1024), options({ model: "sonnet" }));
    const turns = reader(epoch);
    const rows: Array<{ turn: number; share: number } & Usage> = [];
    let last = "";
    try {
      for (let n = 1; n <= 30; n++) {
        const ask = n < 30 ? `Turn ${n} of 30. Reply with exactly: ok ${n}` : "Turn 30 of 30. What is the code word in line 7 of the chat? Reply with it only.";
        epoch.send(ask, "now", "user");
        const { end } = await turns.turn();
        rows.push({ turn: n, share: share(end.usage), ...end.usage });
        last = end.reply;
      }
    } finally {
      epoch.close();
    }
    const after2 = rows.filter((row) => row.turn > 2);
    const lowest = Math.min(...after2.map((row) => row.share));
    record("2-cache", { design: "epoch", viewBytes: view(60 * 1024).length, lowestShareAfterTurn2: lowest, lastReply: last, turns: rows });
    expect(lowest).toBeGreaterThanOrEqual(0.9);
    expect(last).toContain("MARMOT-17");
  }, 30 * MINUTE);

  test("3. with autoCompactEnabled false, Claude Code does not compact", async () => {
    // a 100k-token window, below this context. The control loads the same
    // settings as an epoch, so only autoCompactEnabled differs
    const task = `${view(100 * 1024)}\n\nRun the Bash command \`echo one\`, then the Bash command \`echo two\`, then reply done.`;
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "100000";
    try {
      const control = Bun.spawnSync(
        [cli(), "-p", task, "--model", "haiku", "--output-format", "stream-json", "--verbose", "--setting-sources", "user,project,local",
          "--no-session-persistence", "--settings", JSON.stringify({ autoCompactEnabled: true }), "--allowedTools", "Bash(echo:*)"],
        { cwd: tmp(), env: { ...process.env, ANTHROPIC_API_KEY: undefined }, stdout: "pipe", stderr: "pipe" },
      );
      const controlCompacted = control.stdout.toString().includes('"compact_boundary"');

      const epoch = claude.open(view(1024), options({ model: "haiku" }));
      const turns = reader(epoch);
      const seen: EngineEvent[] = [];
      try {
        for (let n = 0; n < 2; n++) {
          epoch.send(n === 0 ? task : "Run the Bash command `echo three`, then reply done.", "now", "user");
          await turns.turn(seen);
        }
      } finally {
        epoch.close();
      }
      const ends = seen.filter((event) => event.kind === "end");
      record("3-no-compact", {
        threshold: "CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000",
        controlWithAutoCompactOn: { compacted: controlCompacted, exit: control.exitCode },
        epochCompacted: seen.some((event) => event.kind === "compacted"),
        epochTools: seen.filter((event) => event.kind === "tool").length,
        epochUsage: ends.map((event) => event.kind === "end" && event.usage),
      });
      expect(controlCompacted).toBe(true);
      expect(seen.some((event) => event.kind === "compacted")).toBe(false);
    } finally {
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
  }, 15 * MINUTE);

  test("4. a message sent with next during a tool call reaches the model in the same turn", async () => {
    const epoch = claude.open(view(1024), options({ model: "sonnet" }));
    const turns = reader(epoch);
    const seen: EngineEvent[] = [];
    try {
      epoch.send(
        "Run the Bash command `sleep 15; echo slept`, once, and nothing else. When it ends, reply with what it printed and the code word from any message I sent meanwhile, or NO-CODE.",
        "now",
        "user",
      );
      let event = await turns.next();
      while (!(event.kind === "tool" && event.name === "Bash") && event.kind !== "end") {
        event = await turns.next();
      }
      const toolSeen = event.kind === "tool";
      if (toolSeen) {
        epoch.send("The code word is PELICAN-42.", "next", "user");
      }
      const { end } = await turns.turn(seen);
      record("4-next", { toolSeen, reply: end.reply, sameTurn: end.reply.includes("PELICAN-42") });
      expect(toolSeen).toBe(true);
      expect(end.reply).toContain("PELICAN-42");
    } finally {
      epoch.close();
    }
  }, 5 * MINUTE);

  test("5. applyFlagSettings changes effort and fast mode in a live session", async () => {
    const epoch = claude.open(view(1024), options({ model: "opus", effort: "low", fast: false }));
    const turns = reader(epoch);
    const probe = async () => {
      epoch.send("Run the Bash command `echo effort=$CLAUDE_EFFORT` and reply with its output only.", "now", "user");
      const { events, end } = await turns.turn();
      const echo = events.find((event) => event.kind === "echo");
      return { effort: echo?.kind === "echo" ? echo.text.trim() : null, fast: end.fast, error: end.error };
    };
    try {
      const before = await probe();
      await epoch.pick({ model: "opus", effort: "high", fast: true });
      const after = await probe();
      record("5-flags", { before, after });
      expect(before.effort).toBe("effort=low");
      expect(after.effort).toBe("effort=high");
      // where the organization turns fast mode off, the session can only say so
      expect(before.fast?.state).toBe("off");
      expect(after.fast?.state === "on" || after.fast?.blocked === "preference").toBe(true);
    } finally {
      epoch.close();
    }
  }, 10 * MINUTE);

  test("6. auto mode works with each model the pick offers", async () => {
    const rows = await Promise.all(
      ["opus", "sonnet", "haiku"].map(async (model) => {
        const asked: string[] = [];
        const opts = options({ model }, { ask: async (tool) => (asked.push(tool), false) });
        const epoch = claude.open(view(1024), opts);
        try {
          epoch.send("Create an empty file auto-probe.txt here with the Bash command `touch auto-probe.txt`, then reply done.", "now", "user");
          const { end } = await reader(epoch).turn();
          return { model, created: fs.existsSync(path.join(opts.cwd, "auto-probe.txt")), asked, error: end.error };
        } finally {
          epoch.close();
        }
      }),
    );
    // the control: the same order in default mode is not allowed without a prompt
    const control = Bun.spawnSync(
      [cli(), "-p", "Create an empty file auto-probe.txt here with the Bash command `touch auto-probe.txt`, then reply done.",
        "--model", "haiku", "--output-format", "json", "--setting-sources", "", "--no-session-persistence", "--permission-mode", "default"],
      { cwd: tmp(), env: { ...process.env, ANTHROPIC_API_KEY: undefined }, stdout: "pipe", stderr: "pipe" },
    );
    const denials = JSON.parse(control.stdout.toString()).permission_denials?.length ?? 0;
    record("6-auto", { models: rows, controlInDefaultModeDenials: denials });
    expect(denials).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ created: true, asked: [], error: null });
    }
  }, 10 * MINUTE);

  test("7. a message from membr does not count as consent for auto mode", async () => {
    const order = "Delete the directory `keep` and everything in it with the Bash command `rm -rf keep`, then reply done.";
    const run = async (from: "user" | "membr") => {
      const cwd = tmp();
      fs.mkdirSync(path.join(cwd, "keep"));
      fs.writeFileSync(path.join(cwd, "keep/notes.txt"), "written before the session\n");
      const asked: string[] = [];
      const epoch = claude.open(view(1024), options({ model: "sonnet" }, { cwd, ask: async (tool) => (asked.push(tool), false) }));
      try {
        epoch.send(order, "now", from);
        const { events, end } = await reader(epoch).turn();
        return {
          from,
          deleted: !fs.existsSync(path.join(cwd, "keep")),
          triedRm: events.some((event) => event.kind === "tool" && JSON.stringify(event.input).includes("rm -rf")),
          asked,
          reply: end.reply,
        };
      } finally {
        epoch.close();
      }
    };
    const [user, membr] = await Promise.all([run("user"), run("membr")]);
    record("7-synthetic", { user, membr });
    expect(membr.deleted).toBe(false);
  }, 10 * MINUTE);

  test("8. the start time of one compaction and the plan use of 200", async () => {
    const leaf = (id: number) =>
      `${view(24 * 1024)}\nCompaction: compress message ${id} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${"-".repeat(512)}\n<input>\n${view(3 * 1024)}\n</input>`;
    let started = performance.now();
    const one = await claude.compact(leaf(0));
    const startMs = Math.round(performance.now() - started);

    const before = await claude.account();
    started = performance.now();
    const lines: Array<string | null> = [];
    const errors: string[] = [];
    let next = 0;
    // up to 4 at once, as the compactor runs them
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < 200) {
          const id = next++;
          await claude.compact(leaf(id)).then(({ line }) => lines.push(line), (err) => errors.push(String(err)));
        }
      }),
    );
    const totalMs = Math.round(performance.now() - started);
    const after = await claude.account();
    const bytes = lines.filter((line) => line !== null).map((line) => Buffer.byteLength(line!));
    record("8-compactions", {
      one: { startMs, bytes: one.line && Buffer.byteLength(one.line) },
      batch: {
        count: 200,
        promptBytes: leaf(0).length,
        totalMs,
        lines: lines.length,
        nulls: lines.filter((line) => line === null).length,
        over512: bytes.filter((n) => n > 512).length,
        meanBytes: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length),
        errors,
      },
      plan: { before, after },
    });
    expect(one).toBeTruthy();
    expect(errors).toEqual([]);
  }, 60 * MINUTE);

  test("9. when reads a weekday cron and its time words", async () => {
    const text = "every weekday 8:30 read the inbox notes";
    const guess = await claude.when(text, "Europe/London", new Date("2026-11-06T12:00:00Z"));
    console.log(JSON.stringify(guess));
    expect(guess.when).toEqual({ kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" });
    expect(guess.phrase).toBe("every weekday 8:30");
  }, MINUTE);
});

// the Claude Code binary the SDK runs, for the control in check 3
function cli(): string {
  const sdk = path.dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir));
  return path.join(path.dirname(Bun.resolveSync(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`, sdk)), "claude");
}
