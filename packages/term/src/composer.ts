import type { Key } from "ink";
import { accept, type Completion } from "@membr/core";

// `recall` is set while up and down walk the history: the message on screen, counted back from the newest, and the text that was in the composer before the walk.
export type Recall = { back: number; draft: string };
export type Composer = { text: string; cursor: number; pick: number; recall: Recall | null };
export const EMPTY_COMPOSER: Composer = { text: "", cursor: 0, pick: 0, recall: null };

export type Press = { input: string } & Partial<Pick<Key, "upArrow" | "downArrow" | "leftArrow" | "rightArrow" | "home" | "end" | "return" | "tab" | "backspace" | "delete" | "ctrl" | "meta" | "super" | "shift">>;
export type Edit = { composer: Composer; submit: string | null };

function typed(text: string, cursor: number): Composer {
  return { text, cursor, pick: 0, recall: null };
}

export function insert(composer: Composer, text: string): Composer {
  const clean = text.replace(/\r\n?/g, "\n");
  return typed(composer.text.slice(0, composer.cursor) + clean + composer.text.slice(composer.cursor), composer.cursor + clean.length);
}

function lineStart(text: string, cursor: number): number { return text.lastIndexOf("\n", cursor - 1) + 1; }
function lineEnd(text: string, cursor: number): number {
  const index = text.indexOf("\n", cursor);
  return index === -1 ? text.length : index;
}

function vertical(composer: Composer, direction: -1 | 1): Composer {
  const { text, cursor } = composer;
  const start = lineStart(text, cursor), column = cursor - start;
  if (direction < 0) {
    if (start === 0) return composer;
    const previous = lineStart(text, start - 1);
    return { ...composer, cursor: Math.min(previous + column, start - 1) };
  }
  const end = lineEnd(text, cursor);
  if (end === text.length) return composer;
  return { ...composer, cursor: Math.min(end + 1 + column, lineEnd(text, end + 1)) };
}

function wordLeft(text: string, cursor: number): number { return text.slice(0, cursor).replace(/\S+\s*$|\s+$/, "").length; }
function wordRight(text: string, cursor: number): number { return cursor + (/^\s*\S+|^\s+/.exec(text.slice(cursor))?.[0].length ?? 0); }

// Up from the first line shows the message before the one on screen, with the cursor at its start, so a second up goes on back. Down from the last line goes forward, with the cursor at the end, and past the newest message gives back the draft.
function recall(composer: Composer, direction: -1 | 1, history: readonly string[]): Composer {
  const back = (composer.recall?.back ?? 0) - direction;
  if (back > history.length) return composer;
  const draft = composer.recall?.draft ?? composer.text;
  if (back <= 0) return composer.recall ? typed(draft, draft.length) : composer;
  const text = history[history.length - back];
  return { text, cursor: direction < 0 ? 0 : text.length, pick: 0, recall: { back, draft } };
}

// One key press against the composer. `menu` is what core offers for the word at the cursor: when it has names, up and down move through them and Tab takes the chosen one in place of the word. `history` is the messages the user sent, oldest first.
export function edit(composer: Composer, press: Press, menu: Completion, history: readonly string[] = []): Edit {
  const { text, cursor } = composer;
  const keep = (next: Composer): Edit => ({ composer: next, submit: null });
  const newline = press.return && (press.shift || press.meta) || press.ctrl && press.input === "j";
  if (newline) return keep(insert(composer, "\n"));
  if (press.return) {
    if (text.slice(0, cursor).endsWith("\\")) return keep(typed(text.slice(0, cursor - 1) + "\n" + text.slice(cursor), cursor));
    return text.trim() ? { composer: EMPTY_COMPOSER, submit: text } : keep(composer);
  }
  if (press.tab) {
    const chosen = menu.commands[composer.pick];
    if (!chosen) return keep(composer);
    const next = accept(text, cursor, menu, chosen);
    return keep(typed(next.text, next.cursor));
  }
  if (press.upArrow || press.downArrow) {
    const direction = press.upArrow ? -1 : 1;
    if (menu.commands.length && !composer.recall) return keep({ ...composer, pick: (composer.pick + direction + menu.commands.length) % menu.commands.length });
    const moved = vertical(composer, direction);
    return keep(moved.cursor === cursor ? recall(composer, direction, history) : moved);
  }
  // Cmd+arrow goes to the line's start or end, as in macOS text fields. Ctrl+arrow and Option+arrow, which macOS Terminal sends as Esc b and Esc f, go one word.
  if (press.home || press.ctrl && press.input === "a" || press.super && press.leftArrow) return keep({ ...composer, cursor: lineStart(text, cursor) });
  if (press.end || press.ctrl && press.input === "e" || press.super && press.rightArrow) return keep({ ...composer, cursor: lineEnd(text, cursor) });
  if ((press.ctrl || press.meta) && press.leftArrow || press.meta && press.input === "b") return keep({ ...composer, cursor: wordLeft(text, cursor) });
  if ((press.ctrl || press.meta) && press.rightArrow || press.meta && press.input === "f") return keep({ ...composer, cursor: wordRight(text, cursor) });
  if (press.leftArrow) return keep({ ...composer, cursor: Math.max(0, cursor - 1) });
  if (press.rightArrow) return keep({ ...composer, cursor: Math.min(text.length, cursor + 1) });
  // Cmd+Backspace erases to the line's start, as Ctrl+U does. Ctrl+Backspace and Option+Backspace, which macOS Terminal sends as Esc and Backspace, erase one word back, as Ctrl+W does.
  if (press.ctrl && press.input === "u" || press.super && press.backspace) return keep(typed(text.slice(0, lineStart(text, cursor)) + text.slice(cursor), lineStart(text, cursor)));
  if (press.ctrl && press.input === "w" || (press.ctrl || press.meta) && press.backspace) {
    const start = wordLeft(text, cursor);
    return keep(typed(text.slice(0, start) + text.slice(cursor), start));
  }
  // Terminals disagree on whether the Backspace key sends backspace or delete, so both erase backwards.
  if (press.backspace || press.delete) return cursor === 0 ? keep(composer) : keep(typed(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1));
  if (press.ctrl || press.meta || !press.input) return keep(composer);
  return keep(insert(composer, press.input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")));
}

export type ComposerLine = { before: string; at: string; after: string; cursor: boolean };

// Where each row of one line ends. A row ends after its last space, so a word that does not fit moves whole to the next row, and only a word longer than the row is cut. A word that fills the row keeps the space after it, which the row does not draw.
function rowEnds(line: string, width: number): number[] {
  const ends: number[] = [];
  let start = 0;
  while (line.length - start > width) {
    const space = line.lastIndexOf(" ", start + width - 1);
    start = line[start + width] === " " ? start + width + 1 : space >= start ? space + 1 : start + width;
    ends.push(start);
  }
  ends.push(line.length);
  return ends;
}

// Wraps the text at words to `width` and finds the cursor, so the screen can draw it as an inverse cell. A cursor past the last cell of a row gets a row of its own.
export function layout(composer: Composer, width: number): ComposerLine[] {
  const lines: ComposerLine[] = [];
  let offset = 0;
  for (const line of composer.text.split("\n")) {
    const ends = rowEnds(line, width);
    let start = 0;
    ends.forEach((end, n) => {
      const shown = line.slice(start, Math.min(end, start + width));
      const column = composer.cursor - offset - start;
      const holds = column >= 0 && (start + column < end || n === ends.length - 1 && start + column === end);
      if (holds && column >= width) lines.push({ before: shown, at: "", after: "", cursor: false }, { before: "", at: " ", after: "", cursor: true });
      else if (holds) lines.push({ before: shown.slice(0, column), at: shown[column] ?? " ", after: shown.slice(column + 1), cursor: true });
      else lines.push({ before: shown, at: "", after: "", cursor: false });
      start = end;
    });
    offset += line.length + 1;
  }
  return lines;
}
