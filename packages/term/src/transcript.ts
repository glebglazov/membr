import { epochWords, effectivePick, rows, type Brief, type Model, type Row } from "@membr/core";
import type { Entry } from "@membr/protocol";

export type Tone = "user" | "label" | "plain" | "dim" | "error" | "info" | "warn";
// `spans`, when set, splits `text` into runs drawn bold or as code.
export type Span = { text: string; bold: boolean; code: boolean };
export type Line = { text: string; tone: Tone; spans?: Span[] };

// Where each row of one paragraph starts and ends, breaking at spaces and cutting only a word longer than the row. The space at a break belongs to no row.
function rowRanges(paragraph: string, width: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0, end = 0, at = 0;
  for (const word of paragraph.split(" ")) {
    let from = at;
    const to = at + word.length;
    at = to + 1;
    while (to - from > width) {
      if (end > start) out.push([start, end]);
      out.push([from, from + width]);
      from += width;
      start = end = from;
    }
    if (end === start) [start, end] = [from, to];
    else if (to - start <= width) end = to;
    else { out.push([start, end]); [start, end] = [from, to]; }
  }
  out.push([start, end]);
  return out;
}

export function wrap(text: string, width: number): string[] {
  return text.split("\n").flatMap((paragraph) => rowRanges(paragraph, width).map(([start, end]) => paragraph.slice(start, end)));
}

const BOLD = 1, CODE = 2;

// Takes the ** and ` markers out of one line of Markdown and gives each character left its style, so wrapping counts only what the screen shows.
function inline(source: string, style = 0): { text: string; styles: number[] } {
  let text = "";
  const styles: number[] = [];
  const add = (part: string, with_: number) => { text += part; styles.push(...Array<number>(part.length).fill(with_)); };
  let last = 0;
  for (const match of source.matchAll(/`([^`]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*/g)) {
    add(source.slice(last, match.index), style);
    if (match[1] !== undefined) add(match[1], style | CODE);
    else { const inner = inline(match[2], style | BOLD); text += inner.text; styles.push(...inner.styles); }
    last = match.index + match[0].length;
  }
  add(source.slice(last), style);
  return { text, styles };
}

// A message as indented screen lines with bold and code drawn. Text inside a ``` block is code, so its markers stay as written.
export function markdown(text: string, width: number, tone: Tone): Line[] {
  const lines: Line[] = [];
  let fenced = false;
  for (const paragraph of text.split("\n")) {
    const fence = /^\s*```/.test(paragraph);
    const { text: shown, styles } = fenced || fence ? { text: paragraph, styles: Array<number>(paragraph.length).fill(fenced && !fence ? CODE : 0) } : inline(paragraph);
    if (fence) fenced = !fenced;
    for (const [start, end] of rowRanges(shown, width - 2)) {
      const spans: Span[] = [{ text: "  ", bold: false, code: false }];
      for (let i = start; i < end; i++) {
        const last = spans[spans.length - 1], bold = (styles[i] & BOLD) !== 0, code = (styles[i] & CODE) !== 0;
        if (last.bold === bold && last.code === code) last.text += shown[i];
        else spans.push({ text: shown[i], bold, code });
      }
      lines.push({ text: "  " + shown.slice(start, end), tone, spans });
    }
  }
  return lines;
}

const LABELS: Record<Exclude<Entry["kind"], "user">, string> = { unii: "membr", tool: "Tool call", echo: "Tool result", work: "Report", note: "Note", ai: "Imported chat" };
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const preview = (text: string) => text.trim().split("\n")[0];

function briefLine(brief: Brief): Line {
  switch (brief.kind) {
    case "tools": {
      const counts = new Map<string, number>();
      for (const call of brief.calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
      const failed = brief.calls.filter((call) => call.result?.error).length;
      const running = brief.calls.some((call) => !call.result);
      const chips = [...[...counts].map(([tool, count]) => count > 1 ? `${tool} x${count}` : tool), ...failed ? [`${failed} failed`] : [], ...running ? ["running"] : []];
      return { text: `> Made ${plural(brief.calls.length, "tool call")}: ${chips.join(", ")}`, tone: failed ? "warn" : "dim" };
    }
    case "spawn": return { text: `> ${brief.call.result ? `Started ${plural(brief.subagents.length, "subagent")}` : "Starting subagents"}: ${brief.subagents.map((subagent) => subagent.name).join(", ")}`, tone: "dim" };
    case "report": return { text: `> Report from ${brief.subagent}: ${preview(brief.text)}`, tone: "dim" };
    case "note": return { text: `> Note: ${preview(brief.text)}`, tone: "dim" };
  }
}

function rowLines(row: Row, width: number): Line[] {
  switch (row.kind) {
    case "message": {
      const { entry } = row;
      const images = (entry.images ?? []).map((name): Line => ({ text: `  [image ${name}]`, tone: "dim" }));
      if (entry.kind === "user") return [...wrap(entry.text, width - 2).map((text, n): Line => ({ text: (n ? "  " : "> ") + text, tone: "user" })), ...images];
      const body = entry.kind === "tool" || entry.kind === "echo" ? wrap(entry.text, width - 2).map((text): Line => ({ text: "  " + text, tone: "plain" })) : markdown(entry.text, width, "plain");
      return [{ text: LABELS[entry.kind], tone: "label" }, ...body, ...images];
    }
    case "brief": { const line = briefLine(row.brief); return wrap(line.text, width).map((text) => ({ ...line, text })); }
    case "summary": return wrap(`[${plural(2 ** row.part.l, "message")}] ${row.text}`, width).map((text) => ({ text, tone: "dim" as const }));
    case "open": return row.rows.flatMap((child) => rowLines(child, width));
  }
}

// The chat as styled screen lines, wrapped to `width`. Scrolling is a slice of this list.
export function transcript(model: Model, width: number): Line[] {
  const lines = rows(model).flatMap((row, index) => [...index ? [{ text: "", tone: "plain" as const }] : [], ...rowLines(row, width)]);
  if (model.live) lines.push({ text: "", tone: "plain" }, { text: "membr", tone: "label" }, ...markdown(model.live, width, "plain"));
  return lines;
}

// agent names the chat when the server has more than one, so the user sees which agent they talk to.
export function status(model: Model, agent?: string): Line {
  const connection = model.connection === "ready" ? model.state.busy ? model.state.wait || "Working" : "Ready"
    : model.connection === "connecting" ? "Connecting" : model.connection === "refused" ? "Access refused" : "Offline. Messages send when connected";
  const pick = effectivePick(model);
  const parts = [
    agent ?? null,
    connection,
    model.state.subagents.length ? `${plural(model.state.subagents.length, "subagent")} at work` : null,
    model.state.goal ? `goal: ${model.state.goal}` : null,
    pick ? `${pick.model} ${pick.effort}${pick.fast ? " fast" : ""}` : null,
    epochWords(model.state.context),
    model.pending.size ? `${plural(model.pending.size, "request")} waiting` : null,
  ];
  return { text: parts.filter(Boolean).join(" | "), tone: model.connection === "refused" ? "error" : model.connection === "ready" ? "dim" : "warn" };
}
