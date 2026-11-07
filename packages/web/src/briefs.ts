import { h, type ComponentChild } from "preact";
import type { Brief, Call } from "@membr/core";
import { Markdown } from "./markdown.ts";

type Props = { brief: Brief; working: readonly string[]; openSubagent: (name: string) => void };

const chevron = h("svg", { class: "chevron", viewBox: "0 0 24 24", "aria-hidden": "true" }, h("path", { d: "M9 6l6 6-6 6" }));

function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? "" : "s"}`; }
// The first line as plain text, for a one-line preview of Markdown.
function preview(text: string): string {
  return text.trim().split("\n")[0].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[#>\-\s]+/, "").replace(/[*_`~]/g, "");
}

function Subagent({ name, working }: { name: string; working: readonly string[] }) {
  return h("span", { class: working.includes(name) ? "subagent-name working" : "subagent-name" }, name);
}

function OpenSubagent({ name, openSubagent }: { name: string; openSubagent: (name: string) => void }) {
  return h("button", { type: "button", class: "ghost small", onClick: () => openSubagent(name) }, `Open ${name}'s chat`);
}

function status(call: Call): ComponentChild {
  if (!call.result) return h("span", { class: "call-status" }, "running");
  return call.result.error ? h("span", { class: "call-status failed" }, "failed") : h("span", { class: "call-status done", "aria-label": "done" }, "✓");
}

function CallRow({ call }: { call: Call }) {
  const input = JSON.stringify(call.input, null, 2);
  return h("details", { class: "call" },
    h("summary", null, h("span", { class: "call-tool" }, call.tool), h("span", { class: "call-what" }, call.what), status(call)),
    h("pre", null, input && input !== "{}" ? input + "\n\n" : "", call.result ? call.result.text || "(no output)" : "Waiting for the result."));
}

// Counts calls per tool in first-use order, so the closed line says what kinds of work happened.
function chips(calls: Call[]): ComponentChild[] {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  const failed = calls.filter((call) => call.result?.error).length;
  return [
    ...[...counts].map(([tool, count]) => h("span", { class: "chip", key: tool }, count > 1 ? `${tool} ×${count}` : tool)),
    failed > 0 && h("span", { class: "chip failed", key: "failed" }, `${failed} failed`),
    calls.some((call) => !call.result) && h("span", { class: "chip running", key: "running" }, "running"),
  ];
}

export function BriefRow({ brief, working, openSubagent }: Props) {
  let line: ComponentChild[], body: ComponentChild;
  switch (brief.kind) {
    case "tools":
      line = [h("span", { class: "brief-what" }, `Made ${plural(brief.calls.length, "tool call")}`), h("span", { class: "chips" }, chips(brief.calls))];
      body = brief.calls.map((call) => h(CallRow, { call, key: call.i }));
      break;
    case "spawn":
      line = [h("span", { class: "brief-what" }, brief.call.result ? `Started ${plural(brief.subagents.length, "subagent")}` : "Starting subagents"), h("span", { class: "chips" }, brief.subagents.map((subagent) => h(Subagent, { name: subagent.name, working, key: subagent.name })))];
      body = brief.subagents.map((subagent) => h("div", { class: "spawned", key: subagent.name },
        h("div", { class: "spawned-head" }, h(Subagent, { name: subagent.name, working }), brief.call.result && !brief.call.result.error && h(OpenSubagent, { name: subagent.name, openSubagent })),
        h(Markdown, { text: subagent.task })));
      if (brief.call.result?.error) body = [body, h("pre", { key: "error" }, brief.call.result.text)];
      break;
    case "report":
      line = [h(Subagent, { name: brief.subagent, working }), h("span", { class: "brief-what" }, "reported"), h("span", { class: "brief-preview" }, preview(brief.text))];
      body = [h(Markdown, { text: brief.text, key: "text" }), h(OpenSubagent, { name: brief.subagent, openSubagent, key: "open" })];
      break;
    case "note":
      line = [h("span", { class: "brief-what" }, "Note"), h("span", { class: "brief-preview" }, preview(brief.text))];
      body = h(Markdown, { text: brief.text });
      break;
  }
  const calls = brief.kind === "tools" ? brief.calls : brief.kind === "spawn" ? [brief.call] : [];
  const entries = calls.flatMap((call) => call.result ? [call.i, call.result.i] : [call.i]);
  return h("details", { class: `brief ${brief.kind}`, "data-entry": brief.i, "data-entries": entries.join(" ") },
    // Spaces between the parts keep the line readable as text; the flex layout ignores them.
    h("summary", null, chevron, line.flatMap((part) => [part, " "])),
    h("div", { class: "brief-body" }, body));
}
