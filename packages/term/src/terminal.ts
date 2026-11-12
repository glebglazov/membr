import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

// SGR mouse reports: Esc [ < button ; column ; row, then M for a press or m for a release.
const REPORT = /\x1b\[<(\d+);\d+;(\d+)([Mm])/g;
const PARTIAL = /\x1b(\[(<[\d;]*)?)?$/;
const WHEEL_LINES = 3;
// Without the kitty protocol, most terminals send Ctrl+Backspace as Ctrl+H, which Ink reads as a plain Backspace. Its kitty code lets the composer erase a word.
const CTRL_BACKSPACE = "\x1b[127;5u";

// A wheel turn gives the lines to scroll, up positive. A click gives the screen row it pressed, counted from 1 at the top.
export type MouseEvent = { kind: "wheel"; lines: number } | { kind: "click"; row: number };
export type Mouse = (listener: (event: MouseEvent) => void) => () => void;

// Mouse reports, so the wheel can scroll the transcript, which the screen draws itself and the terminal's scrollback does not hold, and a click can jump to its bottom.
// Extended keys (xterm modifyOtherKeys), so tmux and xterm send Shift+Enter and the other modified keys as their own codes and not as plain Enter. Kitty-protocol terminals do this through Ink already.
const MODES_ON = "\x1b[?1000h\x1b[?1006h\x1b[>4;2m";
const MODES_OFF = "\x1b[?1000l\x1b[?1006l\x1b[>4m";

export type Terminal = { stdin: NodeJS.ReadStream; mouse: Mouse; edit(text: string): string | null; close(): void };

// Sets the terminal modes above for as long as the chat runs.
// Ink gets a stdin with the reports taken out, because it would drop them, and the mouse listeners get the wheel turns and the left-button presses.
// Clicks are reported too, so most terminals select text only with a modifier held: Option in iTerm2 and Terminal, Shift in Ghostty, kitty and WezTerm.
export function terminalInput(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Terminal {
  const listeners = new Set<(event: MouseEvent) => void>();
  const filtered = new PassThrough({ encoding: "utf8" });
  let held = "";
  const data = (chunk: Buffer | string) => {
    const text = held + String(chunk);
    held = PARTIAL.exec(text)?.[0] ?? "";
    const rest = text.slice(0, text.length - held.length).replace(REPORT, (_, button: string, row: string, kind: string) => {
      // Bits 4, 8 and 16 are Shift, Meta and Ctrl; 0 is the left button, and 64 and 65 are the wheel up and down.
      const code = Number(button) & ~28;
      const event: MouseEvent | null = kind !== "M" ? null : code === 64 || code === 65 ? { kind: "wheel", lines: code === 64 ? WHEEL_LINES : -WHEEL_LINES } : code === 0 ? { kind: "click", row: Number(row) } : null;
      if (event) for (const listener of listeners) listener(event);
      return "";
    }).replaceAll("\b", CTRL_BACKSPACE);
    if (rest) filtered.write(rest);
  };
  // A lone Esc waits in `held` for the rest of a report; when no more input comes, it was the Esc key.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => { timer = null; filtered.write(held); held = ""; };
  const read = (chunk: Buffer | string) => { if (timer) clearTimeout(timer); timer = null; data(chunk); if (held) timer = setTimeout(flush, 20); };
  stdin.on("data", read);

  const proxy = Object.assign(filtered, {
    isTTY: stdin.isTTY,
    setRawMode: (mode: boolean) => { stdin.setRawMode(mode); return proxy; },
    ref: () => { stdin.ref(); return proxy; },
    unref: () => { stdin.unref(); return proxy; },
  }) as unknown as NodeJS.ReadStream;

  const off = () => stdout.write(MODES_OFF);
  stdout.write(MODES_ON);
  process.once("exit", off);
  return {
    stdin: proxy,
    mouse: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Gives the terminal to the editor without the modes, which an editor does not expect.
    edit(text) {
      off();
      try { return openEditor(text); } finally { stdout.write(MODES_ON); }
    },
    close() {
      off();
      process.off("exit", off);
      if (timer) clearTimeout(timer);
      stdin.off("data", read);
      stdin.pause();
    },
  };
}

// Opens $VISUAL, then $EDITOR, then vim on a plain text file that holds `text`, and waits for it to exit. It gives back the saved text, or null when the editor fails.
// spawnSync blocks the event loop, so this process reads nothing from the terminal while the editor has it.
export function openEditor(text: string): string | null {
  const directory = mkdtempSync(path.join(tmpdir(), "membr-"));
  const file = path.join(directory, "message.txt");
  try {
    writeFileSync(file, text);
    const editor = process.env.VISUAL || process.env.EDITOR || "vim";
    const result = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    // Editors end the last line with a newline; the message does not have one.
    return result.status === 0 ? readFileSync(file, "utf8").replace(/\r?\n$/, "") : null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
