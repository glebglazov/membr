import { h, type ComponentChild } from "preact";
import type { Brief, Call } from "@membr/core";
import { Markdown } from "./markdown.ts";

type Props = { brief: Brief; working: readonly string[]; openAgent: (name: string) => void };

const chevron = h("svg", { class: "chevron", viewBox: "0 0 24 24", "aria-hidden": "true" }, h("path", { d: "M9 6l6 6-6 6" }));

function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? "" : "s"}`; }
// The first line as plain text, for a one-line preview of Markdown.
function preview(text: string): string {
  return text.trim().split("\n")[0].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[#>\-\s]+/, "").replace(/[*_`~]/g, "");
}

function Agent({ name, working }: { name: string; working: readonly string[] }) {
  return h("span", { class: working.includes(name) ? "agent-name working" : "agent-name" }, name);
}

function OpenAgent({ name, openAgent }: { name: string; openAgent: (name: string) => void }) {
  return h("button", { type: "button", class: "ghost small", onClick: () => openAgent(name) }, `Open ${name}'s chat`);
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

export function BriefRow({ brief, working, openAgent }: Props) {
  let line: ComponentChild[], body: ComponentChild;
  switch (brief.kind) {
    case "tools":
      line = [h("span", { class: "brief-what" }, `Made ${plural(brief.calls.length, "tool call")}`), h("span", { class: "chips" }, chips(brief.calls))];
      body = brief.calls.map((call) => h(CallRow, { call, key: call.i }));
      break;
    case "spawn":
      line = [h("span", { class: "brief-what" }, brief.call.result ? `Started ${plural(brief.agents.length, "agent")}` : "Starting agents"), h("span", { class: "chips" }, brief.agents.map((agent) => h(Agent, { name: agent.name, working, key: agent.name })))];
      body = brief.agents.map((agent) => h("div", { class: "spawned", key: agent.name },
        h("div", { class: "spawned-head" }, h(Agent, { name: agent.name, working }), brief.call.result && !brief.call.result.error && h(OpenAgent, { name: agent.name, openAgent })),
        h(Markdown, { text: agent.task })));
      if (brief.call.result?.error) body = [body, h("pre", { key: "error" }, brief.call.result.text)];
      break;
    case "report":
      line = [h(Agent, { name: brief.agent, working }), h("span", { class: "brief-what" }, "reported"), h("span", { class: "brief-preview" }, preview(brief.text))];
      body = [h(Markdown, { text: brief.text, key: "text" }), h(OpenAgent, { name: brief.agent, openAgent, key: "open" })];
      break;
    case "note":
      line = [h("span", { class: "brief-what" }, "Note"), h("span", { class: "brief-preview" }, preview(brief.text))];
      body = h(Markdown, { text: brief.text });
      break;
  }
  return h("details", { class: `brief ${brief.kind}`, "data-entry": brief.i },
    // Spaces between the parts keep the line readable as text; the flex layout ignores them.
    h("summary", null, chevron, line.flatMap((part) => [part, " "])),
    h("div", { class: "brief-body" }, body));
}
