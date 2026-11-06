import type { Key } from "ink";
import type { Command } from "@membr/core";

export type Composer = { text: string; cursor: number; pick: number };
export const EMPTY_COMPOSER: Composer = { text: "", cursor: 0, pick: 0 };

export type Press = { input: string } & Partial<Pick<Key, "upArrow" | "downArrow" | "leftArrow" | "rightArrow" | "home" | "end" | "return" | "tab" | "backspace" | "delete" | "ctrl" | "meta" | "shift">>;
export type Edit = { composer: Composer; submit: string | null };

function typed(text: string, cursor: number): Composer {
  return { text, cursor, pick: 0 };
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

// One key press against the composer. `menu` is what core offers for the current text: when it is not empty, up and down move through it and Tab takes the chosen name.
export function edit(composer: Composer, press: Press, menu: readonly Command[]): Edit {
  const { text, cursor } = composer;
  const keep = (next: Composer): Edit => ({ composer: next, submit: null });
  const newline = press.return && (press.shift || press.meta) || press.ctrl && press.input === "j";
  if (newline) return keep(insert(composer, "\n"));
  if (press.return) {
    if (text.slice(0, cursor).endsWith("\\")) return keep(typed(text.slice(0, cursor - 1) + "\n" + text.slice(cursor), cursor));
    return text.trim() ? { composer: EMPTY_COMPOSER, submit: text } : keep(composer);
  }
  if (press.tab) {
    const chosen = menu[composer.pick];
    return chosen ? keep(typed(chosen.name + " ", chosen.name.length + 1)) : keep(composer);
  }
  if (press.upArrow || press.downArrow) {
    if (menu.length) return keep({ ...composer, pick: (composer.pick + (press.upArrow ? -1 : 1) + menu.length) % menu.length });
    return keep(vertical(composer, press.upArrow ? -1 : 1));
  }
  if (press.leftArrow) return keep({ ...composer, cursor: Math.max(0, cursor - 1) });
  if (press.rightArrow) return keep({ ...composer, cursor: Math.min(text.length, cursor + 1) });
  if (press.home || press.ctrl && press.input === "a") return keep({ ...composer, cursor: lineStart(text, cursor) });
  if (press.end || press.ctrl && press.input === "e") return keep({ ...composer, cursor: lineEnd(text, cursor) });
  if (press.ctrl && press.input === "u") return keep(typed(text.slice(0, lineStart(text, cursor)) + text.slice(cursor), lineStart(text, cursor)));
  if (press.ctrl && press.input === "w") {
    const start = text.slice(0, cursor).replace(/\S+\s*$/, "").length;
    return keep(typed(text.slice(0, start) + text.slice(cursor), start));
  }
  // Terminals disagree on whether the Backspace key sends backspace or delete, so both erase backwards.
  if (press.backspace || press.delete) return cursor === 0 ? keep(composer) : keep(typed(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1));
  if (press.ctrl || press.meta || !press.input) return keep(composer);
  return keep(insert(composer, press.input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")));
}

export type ComposerLine = { before: string; at: string; after: string; cursor: boolean };

// Hard-wraps the text to `width` and finds the cursor, so the screen can draw it as an inverse cell.
export function layout(composer: Composer, width: number): ComposerLine[] {
  const lines: ComposerLine[] = [];
  let offset = 0;
  const logical = composer.text.split("\n");
  logical.forEach((line, index) => {
    const chunks = line.length === 0 ? [""] : line.match(new RegExp(`.{1,${width}}`, "gs")) ?? [""];
    if (line.length > 0 && line.length % width === 0 && index === logical.length - 1 && composer.cursor === composer.text.length) chunks.push("");
    chunks.forEach((chunk, n) => {
      const last = n === chunks.length - 1;
      const start = offset, end = offset + chunk.length;
      const holds = composer.cursor >= start && (composer.cursor < end || last && composer.cursor === end);
      const column = composer.cursor - start;
      lines.push(holds
        ? { before: chunk.slice(0, column), at: chunk[column] ?? " ", after: chunk.slice(column + 1), cursor: true }
        : { before: chunk, at: "", after: "", cursor: false });
      offset = end;
    });
    offset += 1;
  });
  return lines;
}
