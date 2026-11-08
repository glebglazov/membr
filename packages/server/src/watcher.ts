import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Schedule, Watch } from "@membr/protocol";
import type { Clock } from "./clock.ts";

// The newest stdout lines that one fire carries. Older ones are dropped and counted.
export const LINES = 50;
// Lines that come within this time of the first held line go in one fire.
export const SETTLE = 5_000;
// A lines watch that would fire more than this many times in an hour fires a burst instead.
export const BURST = 10;
const HOUR = 3_600_000;
const STDERR = 5;
const LINE_CHARS = 1_000;

export type Exit = { code: number | null; signal: string | null; after: number; stderr: string[] };
export type WatchEvent =
  | { kind: "lines"; lines: string[]; dropped: number }
  | { kind: "ended"; lines: string[]; dropped: number; exit: Exit }
  | { kind: "burst"; dropped: number };
// "wait" keeps what the watch holds, and the next poke tries again with whatever came in since.
export type Deliver = (schedule: string, event: WatchEvent) => "started" | "wait";

type Live = {
  watch: Watch;
  // null after the command exited, while its last fire waits for the chat
  proc: ChildProcess | null;
  started: number;
  lines: string[];
  dropped: number;
  // when the oldest held line came, so a batch waits SETTLE from it
  first: number | null;
  stderr: string[];
  exit: Exit | null;
  fires: number[];
  stopWake: (() => void) | null;
};

// Runs the commands of the watches that Schedules wants, and turns their output into fires. It knows no phases and
// writes nothing to the log: Schedules decides which watches run and what a fire becomes.
export class Watcher {
  private readonly live = new Map<string, Live>();
  private readonly pids: string;

  // changed: a command started or exited, so the running mark of its schedule is new.
  constructor(store: string, private readonly cwd: () => string, private readonly deliver: Deliver, private readonly changed: () => void, private readonly clock: Clock) {
    this.pids = path.join(store, "watches.pids");
    sweep(this.pids);
  }

  // Starts the command of each wanted watch that does not run, and kills each one that is no longer wanted. A watch
  // whose command exited stays until its last fire is written, so a second sync does not start it again.
  sync(wanted: readonly Schedule[]): void {
    const ids = new Set(wanted.map((s) => s.id));
    for (const [id, live] of this.live) if (!ids.has(id)) this.drop(id, live);
    for (const s of wanted) if (!this.live.has(s.id) && s.when.kind === "watch") this.start(s.id, s.when);
  }

  running(schedule: string): boolean { return this.live.get(schedule)?.proc != null; }

  poke(): void {
    for (const id of [...this.live.keys()]) this.send(id);
  }

  close(): void {
    for (const [id, live] of this.live) this.drop(id, live);
  }

  private start(id: string, watch: Watch): void {
    const live: Live = { watch, proc: null, started: this.clock.now(), lines: [], dropped: 0, first: null, stderr: [], exit: null, fires: [], stopWake: null };
    this.live.set(id, live);
    // Its own process group, so a kill reaches every process of a pipeline.
    const proc = spawn("/bin/sh", ["-c", watch.command], { cwd: this.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    live.proc = proc;
    this.save();
    const out = lines((line) => this.hold(id, live, line));
    const err = lines((line) => { live.stderr.push(line); if (live.stderr.length > STDERR) live.stderr.shift(); });
    proc.stdout!.setEncoding("utf8").on("data", out.data);
    proc.stderr!.setEncoding("utf8").on("data", err.data);
    let ended = false;
    const end = (code: number | null, signal: string | null) => {
      if (ended) return;
      ended = true;
      out.end();
      err.end();
      live.proc = null;
      if (this.live.get(id) !== live) return;
      this.save();
      live.exit = { code, signal, after: this.clock.now() - live.started, stderr: live.stderr.slice() };
      this.changed();
      this.send(id);
    };
    proc.on("error", (error) => { live.stderr.push(error.message); end(null, null); });
    // The watch ends with its shell. A child it left in the background could hold stdout open, and close waits for that.
    proc.on("exit", () => kill(proc));
    proc.on("close", end);
  }

  private hold(id: string, live: Live, line: string): void {
    if (this.live.get(id) !== live) return;
    live.lines.push(line.length > LINE_CHARS ? line.slice(0, LINE_CHARS) + "…" : line);
    if (live.lines.length > LINES) { live.lines.shift(); live.dropped++; }
    live.first ??= this.clock.now();
    if (live.watch.on === "lines" && !live.stopWake) {
      live.stopWake = this.clock.wake(Math.max(0, this.due(live) - this.clock.now()), () => { live.stopWake = null; this.send(id); });
    }
  }

  private due(live: Live): number {
    return Math.max((live.first ?? 0) + SETTLE, (live.fires.at(-1) ?? -Infinity) + live.watch.quiet * 1000);
  }

  private send(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    const now = this.clock.now();
    let event: WatchEvent;
    if (live.exit) event = { kind: "ended", lines: live.lines, dropped: live.dropped, exit: live.exit };
    else if (live.watch.on === "lines" && live.lines.length && now >= this.due(live)) {
      live.fires = live.fires.filter((t) => now - t < HOUR);
      event = live.fires.length >= BURST ? { kind: "burst", dropped: live.dropped + live.lines.length } : { kind: "lines", lines: live.lines, dropped: live.dropped };
    } else return;
    if (this.deliver(id, event) === "wait") return;
    live.lines = [];
    live.dropped = 0;
    live.first = null;
    if (event.kind === "lines") live.fires.push(now);
  }

  private drop(id: string, live: Live): void {
    this.live.delete(id);
    live.stopWake?.();
    if (live.proc) kill(live.proc);
    this.save();
  }

  // The process groups that run now, so the next start can end them if this server dies without close.
  private save(): void {
    const groups = [...this.live.values()].flatMap((live) => live.proc?.pid ? [JSON.stringify({ pgid: live.proc.pid, command: live.watch.command })] : []);
    if (groups.length) fs.writeFileSync(this.pids, groups.join("\n") + "\n");
    else fs.rmSync(this.pids, { force: true });
  }
}

// A watch command does no cleanup that a grace time would wait for, so SIGKILL ends its group at once.
function kill(proc: ChildProcess): void {
  try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
}

// Ends the groups that a server which died without close left running. A group is ended only while its leader is
// still the shell of that command, or the command itself when sh ran a simple command in its place, so a pid that the
// system gave to another process since then is left alone.
function sweep(file: string): void {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split("\n").filter(Boolean)) {
    let group: { pgid: number; command: string };
    try { group = JSON.parse(line); } catch { continue; }
    const leader = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(group.pgid)], { encoding: "utf8" }).stdout?.trim();
    if (leader === `/bin/sh -c ${group.command}` || leader === group.command) try { process.kill(-group.pgid, "SIGKILL"); } catch {}
  }
  fs.rmSync(file, { force: true });
}

// Cuts a text stream into lines. end gives the last line that had no newline.
function lines(take: (line: string) => void): { data(chunk: string): void; end(): void } {
  let rest = "";
  return {
    data(chunk) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop()!;
      for (const part of parts) take(part.replace(/\r$/, ""));
    },
    end() {
      if (rest) take(rest);
      rest = "";
    },
  };
}
