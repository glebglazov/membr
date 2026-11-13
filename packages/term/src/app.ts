import { createElement as h, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { answering, complete, earlier, type Model } from "@membr/core";
import { EMPTY_COMPOSER, edit, insert, layout, type Composer } from "./composer.ts";
import type { Mouse } from "./terminal.ts";
import { newId, type Session } from "./session.ts";
import { status, transcript, wrap, type Line, type Tone } from "./transcript.ts";

const COLORS: Record<Tone, { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean }> = {
  user: { color: "#000000", backgroundColor: "#c6dbf7" }, label: { bold: true }, plain: {}, dim: { dimColor: true }, error: { color: "red" }, info: { color: "green" }, warn: { color: "yellow" },
};
const MENU_ROWS = 6;
const COMPOSER_ROWS = 6;

function approvalLines(model: Model, width: number): Line[] {
  const [first] = model.approvals.values();
  if (!first) return [];
  const input = JSON.stringify(first.input);
  const more = model.approvals.size > 1 ? ` (+${model.approvals.size - 1} more)` : "";
  const waiting = answering(model, first.id);
  return [
    { text: `Allow ${first.tool}?${more}`, tone: "warn" },
    ...wrap(input.length > 300 ? input.slice(0, 300) + "..." : input, width - 2).slice(0, 4).map((text): Line => ({ text: "  " + text, tone: "plain" })),
    { text: waiting ? "Waiting for the answer." : "[o] once   [a] always (this exact input)   [d] deny", tone: waiting ? "dim" : "warn" },
  ];
}

function previewLines(model: Model): Line[] {
  if (!model.preview) return [];
  return [{ text: model.preview.proposal ? "Saving the schedule..." : "Reading the time...", tone: "dim" }];
}

// What up and down recall: the user's messages in the chat, then what this terminal sent that is not in the chat yet or never goes there, such as /help.
function history(model: Model, sent: readonly string[]): string[] {
  const said = [...model.entries.values()].filter((entry) => entry.kind === "user").sort((a, b) => a.i - b.i).map((entry) => entry.text);
  const known = new Set(said);
  return [...said, ...sent.filter((text) => !known.has(text))].filter((text, index, all) => text !== all[index - 1]);
}

// `editor` opens the composer text in an external editor and gives back the saved text, or null.
export function App({ session, agent, mouse, editor }: { session: Session; agent?: string; mouse?: Mouse; editor?: (text: string) => string | null }): ReactElement {
  const { suspendTerminal } = useApp();
  const model = useSyncExternalStore(session.subscribe, session.model);
  const size = useWindowSize();
  const columns = size.columns || 80, rowsHigh = size.rows || 24;
  const [composer, setComposer] = useState<Composer>(EMPTY_COMPOSER);
  // How many lines the screen is above the bottom of the transcript. 0 follows the newest lines.
  const [scroll, setScroll] = useState(0);
  // How many lines at the bottom came in while the reader was scrolled up.
  const [fresh, setFresh] = useState(0);
  const [sent, setSent] = useState<string[]>([]);
  const scrollLimit = useRef(0);
  // The screen row of the jump line, or 0 when it is not shown. A click on it goes to the bottom.
  const jumpRow = useRef(0);
  // Ctrl+X starts a two-key command, as in Claude Code: Ctrl+X then g goes back to the bottom of the chat.
  const chord = useRef(false);
  useEffect(() => () => session.close(), [session]);
  useEffect(() => mouse?.((event) => {
    if (event.kind === "wheel") setScroll((previous) => Math.max(0, Math.min(scrollLimit.current, Math.min(previous, scrollLimit.current) + event.lines)));
    else if (jumpRow.current && event.row === jumpRow.current) setScroll(0);
  }), [mouse]);

  const menu = complete(model, composer.text, composer.cursor).commands;
  const approval = [...model.approvals.values()][0];

  const notices: Line[] = [
    ...model.info ? wrap(model.info, columns).map((text): Line => ({ text, tone: "info" })) : [],
    ...model.error ? wrap(model.error, columns).map((text): Line => ({ text, tone: "error" })) : [],
  ];
  const approvals = [...approvalLines(model, columns), ...previewLines(model)];
  const composerLines = approval ? [] : layout(composer, columns - 2);
  const cursorRow = composerLines.findIndex((line) => line.cursor);
  const firstRow = Math.max(0, Math.min(cursorRow - COMPOSER_ROWS + 1, composerLines.length - COMPOSER_ROWS));
  const shownComposer = composerLines.slice(firstRow, firstRow + COMPOSER_ROWS);
  const menuFirst = Math.max(0, Math.min(composer.pick - MENU_ROWS + 1, menu.length - MENU_ROWS));
  const shownMenu = menu.slice(menuFirst, menuFirst + MENU_ROWS);
  const bottom = notices.length + approvals.length + (approval ? 1 : 0) + 3 + shownMenu.length + shownComposer.length;
  const height = Math.max(3, rowsHigh - bottom);
  const lines = transcript(model, columns);
  // Lines that come in at the bottom while the reader is scrolled up add to the offset, so the lines on screen stay. Older pages come in at the top, and a change of page, fold or width draws other lines, so those leave the offset as it is.
  const shape = { length: lines.length, from: model.from, view: `${model.page} ${model.folded} ${columns}` };
  const [drawn, setDrawn] = useState(shape);
  if (drawn.length !== shape.length || drawn.from !== shape.from || drawn.view !== shape.view) {
    setDrawn(shape);
    const added = shape.length - drawn.length;
    if (scroll > 0 && shape.from === drawn.from && shape.view === drawn.view) {
      setScroll(Math.max(0, scroll + added));
      setFresh(Math.max(0, fresh + added));
    }
  }
  const maxScroll = Math.max(0, lines.length - height);
  const offset = Math.min(scroll, maxScroll);
  scrollLimit.current = maxScroll;
  if (offset === 0 && fresh) setFresh(0);
  const visible = lines.slice(Math.max(0, lines.length - height - offset), lines.length - offset);
  // The new lines are unseen while the first of them is still below the screen.
  const jump = offset > 0 ? `↓ Jump to bottom${fresh > 0 && offset >= fresh ? " (new messages)" : ""} · Ctrl+X g` : null;
  if (jump) visible.pop();
  jumpRow.current = jump ? visible.length + 1 : 0;
  const state = status(model, agent);
  // Reaching the top of the loaded chat asks for the next older page. The offset counts from the bottom, so the rows that arrive above leave the same content on screen.
  const atTop = offset >= maxScroll && !model.folded && model.page === "chat" && earlier(model) === "idle";
  useEffect(() => {
    if (!atTop) return;
    setScroll(offset);
    session.input({ type: "older", id: newId() });
  }, [atTop]);

  function send(text: string) {
    session.input({ type: "send", id: newId(), text });
    setSent((previous) => [...previous, text]);
    const failed = session.model().error !== null;
    if (!failed) setScroll(0);
    return failed;
  }

  useInput((input, key) => {
    const current = session.model();
    if (key.pageUp) return setScroll(offset + Math.max(1, height >> 1));
    if (key.pageDown) return setScroll(Math.max(0, offset - Math.max(1, height >> 1)));
    if (chord.current) {
      chord.current = false;
      if (input === "g" && !key.ctrl && !key.meta) return setScroll(0);
    }
    if (key.ctrl && input === "x") { chord.current = true; return; }
    if (key.escape) {
      if (current.state.busy || current.state.subagents.length) session.input({ type: "stop", id: newId() });
      return;
    }
    if (current.error) session.input({ type: "dismiss-error" });
    if (current.info) session.input({ type: "dismiss-info" });
    const first = [...current.approvals.values()][0];
    if (first) {
      const choice = input === "o" ? "once" : input === "a" ? "always" : input === "d" ? "deny" : null;
      if (choice) session.input({ type: "answer", id: newId(), approval: first.id, choice });
      return;
    }
    if (key.ctrl && input === "g") {
      if (!editor) return;
      let saved: string | null = null;
      void suspendTerminal(() => { saved = editor(composer.text); }).then(() => { if (saved !== null) setComposer(insert(EMPTY_COMPOSER, saved)); });
      return;
    }
    const result = edit(composer, { input, ...key }, complete(current, composer.text, composer.cursor), history(current, sent));
    if (result.submit === null) return setComposer(result.composer);
    if (!send(result.submit)) setComposer(result.composer);
  });
  usePaste((text) => { if (!approval) setComposer((previous) => insert(previous, text)); });

  // A sent message fills the whole row, so its background marks it as one block.
  const text = (group: string) => (line: Line, index: number) => h(Text, { key: `${group}${index}`, ...COLORS[line.tone] },
    line.spans ? line.spans.map((span, n) => h(Text, { key: n, bold: span.bold, color: span.code ? "cyan" : undefined }, span.text)) : line.tone === "user" ? line.text.padEnd(columns) : line.text || " ");
  const rule = (key: string) => h(Text, { key, dimColor: true }, "─".repeat(columns));
  return h(Box, { flexDirection: "column" },
    ...visible.map(text("t")),
    jump ? h(Box, { key: "jump", width: columns, justifyContent: "center" }, h(Text, { inverse: true }, ` ${jump} `)) : null,
    ...approvals.map(text("a")),
    ...notices.map(text("n")),
    rule("above"),
    ...shownComposer.map((line, index) => h(Text, { key: index }, index + firstRow === 0 ? "> " : "  ", line.before,
      line.cursor ? h(Text, { inverse: true }, line.at) : null, line.after)),
    approval ? h(Text, { dimColor: true }, "Answer the approval above. Esc stops the turn.") : null,
    rule("below"),
    ...shownMenu.map((command, index) => h(Text, { key: command.name, inverse: menuFirst + index === composer.pick },
      `${command.name}${command.hint ? " " + command.hint : ""}`.padEnd(24) + " " + command.description)),
    h(Text, COLORS[state.tone], state.text));
}
