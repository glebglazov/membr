import { createElement as h, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { answering, complete, describeWhen, fireTime, runLabel, type Model } from "@membr/core";
import { EMPTY_COMPOSER, edit, insert, layout, type Composer } from "./composer.ts";
import type { Wheel } from "./terminal.ts";
import { newId, type Session } from "./session.ts";
import { status, transcript, wrap, type Line, type Tone } from "./transcript.ts";

const COLORS: Record<Tone, { color?: string; dimColor?: boolean; bold?: boolean }> = {
  user: { color: "cyan" }, label: { bold: true }, plain: {}, dim: { dimColor: true }, error: { color: "red" }, info: { color: "green" }, warn: { color: "yellow" },
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

function previewLines(model: Model, width: number): Line[] {
  const proposal = model.preview?.proposal;
  if (!model.preview) return [];
  if (!proposal) return [{ text: "Reading the time...", tone: "dim" }];
  const zone = proposal.when.kind === "cron" ? proposal.when.zone : undefined;
  const next = proposal.next.length ? `Next: ${proposal.next.map((time) => fireTime(time, zone)).join(", ")}.` : "It does not fire again.";
  const waiting = [...model.pending.values()].some((request) => request.act === "schedule");
  return [
    ...wrap(`Proposed: ${describeWhen(proposal.when)}, as a ${runLabel("subagent")}.`, width).map((text): Line => ({ text, tone: "warn" })),
    ...wrap(`${next}${waiting ? "" : "  [a] accept  [d] delete"}`, width).map((text): Line => ({ text, tone: waiting ? "dim" : "warn" })),
  ];
}

// What up and down recall: the user's messages in the chat, then what this terminal sent that is not in the chat yet or never goes there, such as /help.
function history(model: Model, sent: readonly string[]): string[] {
  const said = [...model.entries.values()].filter((entry) => entry.kind === "user").sort((a, b) => a.i - b.i).map((entry) => entry.text);
  const known = new Set(said);
  return [...said, ...sent.filter((text) => !known.has(text))].filter((text, index, all) => text !== all[index - 1]);
}

// `editor` opens the composer text in an external editor and gives back the saved text, or null.
export function App({ session, agent, wheel, editor }: { session: Session; agent?: string; wheel?: Wheel; editor?: (text: string) => string | null }): ReactElement {
  const { suspendTerminal } = useApp();
  const model = useSyncExternalStore(session.subscribe, session.model);
  const size = useWindowSize();
  const columns = size.columns || 80, rowsHigh = size.rows || 24;
  const [composer, setComposer] = useState<Composer>(EMPTY_COMPOSER);
  const [scroll, setScroll] = useState(0);
  const [sent, setSent] = useState<string[]>([]);
  const scrollLimit = useRef(0);
  // Ctrl+X starts a two-key command, as in Claude Code: Ctrl+X then g goes back to the bottom of the chat.
  const chord = useRef(false);
  useEffect(() => () => session.close(), [session]);
  useEffect(() => wheel?.((lines) => setScroll((previous) => Math.max(0, Math.min(scrollLimit.current, Math.min(previous, scrollLimit.current) + lines)))), [wheel]);

  const menu = complete(model, composer.text, composer.cursor).commands;
  const approval = [...model.approvals.values()][0];

  const notices: Line[] = [
    ...model.info ? wrap(model.info, columns).map((text): Line => ({ text, tone: "info" })) : [],
    ...model.error ? wrap(model.error, columns).map((text): Line => ({ text, tone: "error" })) : [],
  ];
  const proposal = model.preview?.proposal ?? null;
  const approvals = [...approvalLines(model, columns), ...previewLines(model, columns)];
  const composerLines = approval || proposal ? [] : layout(composer, columns - 2);
  const cursorRow = composerLines.findIndex((line) => line.cursor);
  const firstRow = Math.max(0, Math.min(cursorRow - COMPOSER_ROWS + 1, composerLines.length - COMPOSER_ROWS));
  const shownComposer = composerLines.slice(firstRow, firstRow + COMPOSER_ROWS);
  const menuFirst = Math.max(0, Math.min(composer.pick - MENU_ROWS + 1, menu.length - MENU_ROWS));
  const shownMenu = menu.slice(menuFirst, menuFirst + MENU_ROWS);
  const bottom = notices.length + approvals.length + (approval || proposal ? 1 : 0) + 1 + shownMenu.length + shownComposer.length;
  const height = Math.max(3, rowsHigh - 1 - bottom);
  const lines = transcript(model, columns);
  const maxScroll = Math.max(0, lines.length - height);
  const offset = Math.min(scroll, maxScroll);
  scrollLimit.current = maxScroll;
  const visible = lines.slice(Math.max(0, lines.length - height - offset), lines.length - offset);
  const state = status(model, agent);

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
    if (current.preview?.proposal) {
      if (input === "a") session.input({ type: "schedule-accept", id: newId() });
      else if (input === "d") session.input({ type: "schedule-discard" });
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
  usePaste((text) => { if (!approval && !proposal) setComposer((previous) => insert(previous, text)); });

  const text = (group: string) => (line: Line, index: number) => h(Text, { key: `${group}${index}`, ...COLORS[line.tone] }, line.text || " ");
  return h(Box, { flexDirection: "column" },
    ...visible.map(text("t")),
    ...approvals.map(text("a")),
    ...notices.map(text("n")),
    h(Text, { ...COLORS[state.tone], inverse: true }, ` ${state.text}${offset ? `  (scrolled up ${offset})` : ""} `),
    ...shownMenu.map((command, index) => h(Text, { key: command.name, inverse: menuFirst + index === composer.pick },
      `${command.name}${command.hint ? " " + command.hint : ""}`.padEnd(24) + " " + command.description)),
    ...shownComposer.map((line, index) => h(Text, { key: index }, index + firstRow === 0 ? "> " : "  ", line.before,
      line.cursor ? h(Text, { inverse: true }, line.at) : null, line.after)),
    approval || proposal ? h(Text, { dimColor: true }, approval ? "Answer the approval above. Esc stops the turn." : "Accept or delete the schedule above.") : null);
}
