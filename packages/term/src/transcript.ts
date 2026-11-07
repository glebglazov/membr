import { epochWords, effectivePick, rows, type Brief, type Model, type Row } from "@membr/core";
import type { Entry } from "@membr/protocol";

export type Tone = "user" | "label" | "plain" | "dim" | "error" | "info" | "warn";
export type Line = { text: string; tone: Tone };

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (let word of paragraph.split(" ")) {
      while (word.length > width) {
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const LABELS: Record<Entry["kind"], string> = { user: "You", unii: "membr", tool: "Tool call", echo: "Tool result", work: "Report", note: "Note", ai: "Imported chat" };
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
      const body = wrap(entry.text, width - 2).map((text): Line => ({ text: "  " + text, tone: entry.kind === "user" ? "user" : "plain" }));
      return [{ text: LABELS[entry.kind], tone: "label" }, ...body, ...(entry.images ?? []).map((name): Line => ({ text: `  [image ${name}]`, tone: "dim" }))];
    }
    case "brief": { const line = briefLine(row.brief); return wrap(line.text, width).map((text) => ({ ...line, text })); }
    case "summary": return wrap(`[${plural(2 ** row.part.l, "message")}] ${row.text}`, width).map((text) => ({ text, tone: "dim" as const }));
    case "open": return row.rows.flatMap((child) => rowLines(child, width));
  }
}

// The chat as styled screen lines, wrapped to `width`. Scrolling is a slice of this list.
export function transcript(model: Model, width: number): Line[] {
  const lines = rows(model).flatMap((row, index) => [...index ? [{ text: "", tone: "plain" as const }] : [], ...rowLines(row, width)]);
  if (model.live) lines.push({ text: "", tone: "plain" }, { text: "membr", tone: "label" }, ...wrap(model.live, width - 2).map((text): Line => ({ text: "  " + text, tone: "plain" })));
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
  return { text: parts.filter(Boolean).join(" | "), tone: model.connection === "refused" ? "error" : model.connection === "ready" ? "info" : "warn" };
}
