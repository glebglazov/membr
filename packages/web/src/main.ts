import { h, render, type ComponentChild } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { accept, act, brief, complete, createModel, hear, rows, partKey, effectivePick, answering, cacheShare, inputTokens, epochWords, epochLimit, earlier, clientZone, describeWhen, fireTime, runLabel, MODELS, EFFORTS, type Attachment, type Upload, type Input, type Row, type Command } from "@membr/core";
import { NOTEBOOK_CAP, VERSION, parseEvent, type Entry, type ImportSource, type ScheduleSpec, type ScheduleView } from "@membr/protocol";
import "./style.css";
import { readExport } from "./export.ts";
import { Markdown } from "./markdown.ts";
import { BriefRow } from "./briefs.ts";
import { useChatScroll } from "./chat-scroll.ts";
import { followVisibleArea } from "./viewport.ts";

let model = createModel();
let socket: WebSocket | null = null;
let changed = () => {};
const uploading = new Set<string>();

async function upload(request: Upload) {
  if (uploading.has(request.id)) return;
  uploading.add(request.id);
  try {
    const form = new FormData();
    form.set("text", request.text);
    for (const image of request.images) {
      const bytes = Uint8Array.from(atob(image.data), (byte) => byte.charCodeAt(0));
      form.append("images", new Blob([bytes], { type: image.type }), image.name);
    }
    const response = await fetch(`act/say?id=${encodeURIComponent(request.id)}`, { method: "POST", body: form });
    const event = response.headers.get("content-type")?.includes("application/json")
      ? parseEvent(await response.json())
      : { type: "answer", id: request.id, ok: false, reason: await response.text() || "The image upload failed." } as const;
    if (event.type !== "answer" || event.id !== request.id) throw new Error("The server sent an invalid upload answer.");
    model = hear(model, event);
  } catch {
    model = hear(model, { type: "error", id: null, reason: "The image upload failed. Retrying when connected." });
    setTimeout(() => { if (model.uploads.has(request.id) && model.connection === "ready") void upload(request); }, 1000);
  } finally {
    uploading.delete(request.id);
    changed();
  }
}

function id(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

function input(value: Input) {
  const previousPage = model.page;
  const result = act(model, value);
  model = result.model;
  if (model.page !== previousPage && location.hash !== `#${model.page}`) history.pushState(null, "", `#${model.page}`);
  for (const message of [...result.acts, ...result.reads]) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  for (const request of result.uploads) void upload(request);
  changed();
}

function connect() {
  model = hear(model, { type: "connecting" });
  changed();
  const url = new URL("ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () => current.send(JSON.stringify({ type: "hello", version: VERSION, kind: "web", device: null, token: null }));
  current.onmessage = (message) => {
    if (socket !== current) return;
    try {
      const event = parseEvent(JSON.parse(String(message.data)));
      model = hear(model, event);
      if (event.type === "ready") input({ type: "flush" });
      else if (event.type === "view") input({ type: "reads" });
      else if (event.type === "when") input({ type: "schedule-save", id: id() });
      changed();
    } catch {
      model = hear(model, { type: "refused", reason: "The server sent an invalid response." });
      changed();
      current.close();
    }
  };
  current.onclose = (event) => {
    if (socket !== current) return;
    socket = null;
    model = event.code === 1008 && model.connection !== "refused"
      ? hear(model, { type: "refused", reason: "Access refused. Open the sign-in link printed by membr serve." })
      : hear(model, { type: "offline" });
    changed();
    if (model.connection !== "refused") setTimeout(connect, 1000);
  };
}

const PROSE = new Set<Entry["kind"]>(["unii", "ai"]);

function Block({ entry }: { entry: Entry }) {
  const label = { user: "You", unii: "membr", tool: "Tool call", echo: "Tool result", work: "Report", note: "Note", ai: "Imported chat" }[entry.kind];
  return h("article", { class: `message ${entry.kind}`, "data-entry": entry.i },
    h("div", { class: "label" }, label), PROSE.has(entry.kind) ? h(Markdown, { text: entry.text }) : h("div", { class: "text" }, entry.text),
    entry.images?.map((name) => h("a", { href: `docs/images/${encodeURIComponent(name)}`, target: "_blank", rel: "noreferrer", key: name }, h("img", { class: "attached-image", src: `docs/images/${encodeURIComponent(name)}`, alt: "Attached image", loading: "lazy" }))));
}

function rowKey(row: Row): string {
  return row.kind === "message" ? `entry-${row.entry.i}` : row.kind === "brief" ? `brief-${row.brief.i}` : partKey(row.part);
}

function MemoryBlock({ row }: { row: Row }): ComponentChild {
  if (row.kind === "message") return h(Block, { entry: row.entry });
  if (row.kind === "brief") return h(BriefRow, { brief: row.brief, working: model.state.subagents, openSubagent: (name) => input({ type: "subagent", name }) });
  const { part } = row;
  const name = `${part.i * 2 ** part.l}+${2 ** part.l}`;
  if (row.kind === "summary") return h("button", {
    type: "button", class: "message summary", "data-part": partKey(part), "aria-label": `Open block ${name}`,
    onClick: () => input({ type: "open", id: id(), part }),
  }, h("span", { class: "label" }, `${2 ** part.l} message${part.l === 0 ? "" : "s"}`), h("span", { class: "text" }, row.text));
  return h("section", { class: "memory-open", "data-part": partKey(part) },
    h("button", { type: "button", class: "close-block", "aria-label": `Close block ${name}`, onClick: () => input({ type: "close", part }) }, `Close ${2 ** part.l} message${part.l === 0 ? "" : "s"}`),
    row.loading && h("p", { role: "status", class: "label" }, "Loading block..."),
    row.rows.map((child) => h(MemoryBlock, { row: child, key: rowKey(child) })));
}

const ICONS = {
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  clip: "M21 12.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l9.2-9.2a3.7 3.7 0 015.2 5.2l-9.2 9.2a1.8 1.8 0 01-2.6-2.6l8.5-8.5",
  up: "M12 19V5M5 12l7-7 7 7",
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return h("svg", { class: "icon", viewBox: "0 0 24 24", "aria-hidden": "true" }, h("path", { d: ICONS[name] }));
}

function Usage() {
  const words = epochWords(model.state.context);
  if (!words) return null;
  return h("span", { class: "usage", title: "Tokens of the epoch after its last turn, of the size at which the next turn starts a new epoch" }, words);
}

// The agent of this page: /membr/<name>/, or the default agent at / as before there were many agents.
const AGENT = decodeURIComponent(/^\/membr\/([^/]+)\//.exec(location.pathname)?.[1] ?? "default");
document.title = `membr · ${AGENT}`;

function AgentSwitch() {
  if (model.agents.length < 2) return null;
  return h("select", { class: "agent-switch", "aria-label": "Agent", value: AGENT, onChange: (event: Event) => { location.href = `/membr/${encodeURIComponent((event.currentTarget as HTMLSelectElement).value)}/`; } },
    model.agents.map((agent) => h("option", { value: agent.name, key: agent.name }, agent.busy && agent.name !== AGENT ? `${agent.name} (working)` : agent.name)));
}

function Settings() {
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => { if (panel.current?.open && event.target instanceof Node && !panel.current.contains(event.target)) panel.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const share = cacheShare(model.state.usage);
  const compression = model.state.compression;
  const cached = cacheShare(compression ?? null);
  return h("details", { class: "settings", ref: panel },
    h("summary", { "aria-label": "Settings", title: "Settings" }, h(Icon, { name: "gear" })),
    h("div", { class: "popover" },
      h("dl", { class: "facts", "aria-label": "Chat status" },
        h("div", { "aria-label": "Current model" }, h("dt", null, "Model"), h("dd", null, model.state.pick?.model ?? "unavailable")),
        h("div", { "aria-label": "Epoch size", title: "Tokens of the epoch at the end of its last turn, of the size at which the next turn starts a new epoch: 220k tokens, or 80% of a smaller model's context window." }, h("dt", null, "Epoch"), h("dd", null, model.state.context === "overflow" ? "full" : model.state.context ? `${model.state.context.used.toLocaleString()} of ${epochLimit(model.state.context.window).toLocaleString()} tokens` : "after the next turn")),
        h("div", { "aria-label": "Compression use", title: "Every Haiku call that compressed a message or merged two lines of memory: input tokens sent, the share read from the cache, and output tokens." }, h("dt", null, "Compression"), h("dd", null, compression && cached !== null ? `${inputTokens(compression).toLocaleString()} sent, ${(cached * 100).toFixed(1)}% cached, ${compression.output.toLocaleString()} out` : "none yet")),
        h("div", { "aria-label": "Cache share", title: "Cache reads as a share of all input tokens in the last completed turn, including cache writes." }, h("dt", null, "Turn cache"), h("dd", null, share === null ? "unavailable" : (share * 100).toFixed(1) + "%")),
        h("div", { "aria-label": "Goal", title: model.state.goal ?? "No goal" }, h("dt", null, "Goal"), h("dd", null, model.state.goal ?? "none"))),
      h(ImportPanel, null),
      h("a", { class: "export", href: "export" }, "Export memory")));
}

function PickBar() {
  const pick = effectivePick(model);
  const disabled = !pick || model.connection === "refused";
  return h("div", { class: "pick-bar", "aria-label": "Chat controls" },
    h("select", { "aria-label": "Model", title: "Model", value: pick?.model ?? "", disabled, onChange: (event: Event) => {
      if (event.currentTarget instanceof HTMLSelectElement) input({ type: "pick", id: id(), change: { model: event.currentTarget.value } });
    } }, !pick && h("option", { value: "" }, "Loading"), MODELS.map((name) => h("option", { value: name, key: name }, name))),
    h("select", { "aria-label": "Effort", title: "Effort", value: pick?.effort ?? "", disabled, onChange: (event: Event) => {
      if (!(event.currentTarget instanceof HTMLSelectElement)) return;
      const selected = event.currentTarget.value;
      const effort = EFFORTS.find((value) => value === selected);
      if (effort) input({ type: "pick", id: id(), change: { effort } });
    } }, !pick && h("option", { value: "" }, "Loading"), EFFORTS.map((effort) => h("option", { value: effort, key: effort }, effort))),
    h("label", { class: "fast-mode", title: "Fast mode" }, h("input", { type: "checkbox", "aria-label": "Fast mode", checked: pick?.fast ?? false, disabled, onChange: (event: Event) => {
      if (event.currentTarget instanceof HTMLInputElement) input({ type: "pick", id: id(), change: { fast: event.currentTarget.checked } });
    } }), h("span", { "aria-hidden": "true" }, "⚡"), h("span", { class: "narrow-hide" }, "Fast")));
}

function ApprovalCards() {
  return h("div", { class: "approvals" }, [...model.approvals.values()].map((approval) => h("section", {
    class: "approval", key: approval.id, "aria-label": `Approval ${approval.tool}`,
  }, h("h2", null, `Allow ${approval.tool}?`),
  h("pre", null, JSON.stringify(approval.input, null, 2)),
  h("div", { class: "approval-actions" }, ([{ choice: "once", label: "Allow once" }, { choice: "always", label: "Always" }, { choice: "deny", label: "Deny" }] satisfies { choice: "once" | "always" | "deny"; label: string }[]).map(({ choice, label }) => h("button", {
    type: "button", key: choice, class: choice === "once" ? "primary" : "ghost", disabled: model.connection !== "ready" || answering(model, approval.id),
    onClick: () => input({ type: "answer", id: id(), approval: approval.id, choice }),
  }, label))),
  h("p", { class: "label" }, answering(model, approval.id) ? "Waiting for the answer." : "Always allows this tool with this exact input."))));
}

function ImportPanel() {
  const [source, setSource] = useState<ImportSource>("claude-code");
  const [folder, setFolder] = useState("~/.claude/projects");
  const [reading, setReading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const website = source === "claude.ai" || source === "chatgpt";
  const plan = model.importPlan;
  const pending = [...model.pending.values()].some((request) => request.act === "import");
  async function choose(files: File[]) {
    setReading(true);
    try {
      const selected = website ? files : files.filter((file) => file.name.endsWith(".jsonl") && !file.webkitRelativePath.split("/").includes("subagents"));
      if (!selected.length) throw new Error("No session files were found.");
      if (selected.length > 10000) throw new Error("Choose at most 10,000 session files.");
      if (!website && selected.reduce((bytes, file) => bytes + file.size, 0) > 32 * 2 ** 20) throw new Error("Choose at most 32 MB of session files.");
      const sessions = await Promise.all(selected.map(async (file) => ({ name: file.webkitRelativePath || file.name, text: website ? await readExport(file) : await file.text() })));
      const selectedInput = { source, path: website ? files[0].name : files[0]?.webkitRelativePath.split("/")[0] ?? "Selected folder", files: sessions };
      if (new TextEncoder().encode(JSON.stringify(selectedInput)).length > 32 * 2 ** 20) throw new Error(website ? "The export request exceeds 32 MB. Use fewer conversations or the server JSON file." : "The session request exceeds 32 MB. Use the server folder for larger imports.");
      input({ type: "import-plan", id: id(), input: selectedInput });
    } catch (error) { model = hear(model, { type: "error", id: null, reason: error instanceof Error ? error.message : "The files could not be read." }); changed(); }
    finally { setReading(false); }
  }
  return h("details", { class: "imports" },
    h("summary", null, "Import past sessions"),
    h("section", { "aria-label": "Import sessions" },
      h("label", null, "Session source", h("select", { "aria-label": "Session source", value: source, disabled: reading, onChange: (event: Event) => {
        if (!(event.currentTarget instanceof HTMLSelectElement)) return;
        const selected = event.currentTarget.value;
        if (selected === "claude-code" || selected === "codex" || selected === "claude.ai" || selected === "chatgpt") { setSource(selected); setFolder(selected === "claude-code" ? "~/.claude/projects" : selected === "codex" ? "~/.codex" : ""); }
      } }, h("option", { value: "claude-code" }, "Claude Code"), h("option", { value: "codex" }, "Codex"), h("option", { value: "claude.ai" }, "claude.ai"), h("option", { value: "chatgpt" }, "ChatGPT"))),
      h("input", { key: website ? "export" : "folder", type: "file", multiple: !website, webkitdirectory: website ? undefined : true, accept: website ? ".zip,.json" : undefined, hidden: true, ref: picker, "aria-label": website ? "Website export" : "Session folder", onChange: (event: Event) => {
        if (!(event.currentTarget instanceof HTMLInputElement)) return;
        const files = [...event.currentTarget.files ?? []]; event.currentTarget.value = "";
        if (files.length) void choose(files);
      } }),
      h("button", { type: "button", disabled: reading || pending, onClick: () => picker.current?.click() }, reading ? "Reading files..." : website ? "Choose ZIP or JSON" : "Choose folder"),
      h("label", null, website ? "Server JSON file" : "Server folder", h("input", { "aria-label": website ? "Server JSON file" : "Server folder", value: folder, onInput: (event: Event) => { if (event.currentTarget instanceof HTMLInputElement) setFolder(event.currentTarget.value); } })),
      h("button", { type: "button", disabled: reading || pending, onClick: () => input({ type: "import-plan", id: id(), input: { source, path: folder } }) }, website ? "Estimate server JSON file" : "Estimate server folder"),
      plan && h("div", { "aria-label": "Import estimate" },
        h("p", null, `${plan.input.source}: ${plan.input.path}`),
        plan.estimate ? h("p", null, `${plan.estimate.sessions} sessions, ${plan.estimate.messages} new messages. Estimated plan usage: ${plan.estimate.compactions} compaction calls. Retries can use more calls.`) : h("p", null, "Reading sessions..."),
        h("button", { type: "button", disabled: !plan.estimate?.messages || pending || model.connection !== "ready", onClick: () => input({ type: "import-start", id: id() }) }, "Start import")),
      model.imports.map((run) => h("div", { key: run.id, class: "import-run", "aria-label": `Import ${run.id}` },
        h("p", null, `${run.messages} messages, ${run.phase}. Estimated ${run.compactions} compaction calls.`),
        run.phase !== "complete" && h("button", { type: "button", disabled: model.connection !== "ready" || [...model.pending.values()].some((request) => request.act === "go" && request.import === run.id), onClick: () => input({ type: "import-go", id: id(), run: run.id, paused: run.phase !== "paused" }) }, run.phase === "paused" ? "Resume import" : "Pause import")))));
}

function SchedulePreview() {
  const preview = model.preview;
  if (!preview) return null;
  if (preview.proposal) return h("section", { class: "schedule-preview", "aria-label": "Schedule preview" }, h("p", { role: "status" }, "Saving the schedule..."));
  return h("section", { class: "schedule-preview", "aria-label": "Schedule preview" }, h("p", { role: "status" }, "Reading the time..."),
    h("div", { class: "schedule-actions" }, h("button", { type: "button", class: "ghost", onClick: () => input({ type: "schedule-discard" }) }, "Discard")));
}

function ScheduleCard({ schedule }: { schedule: ScheduleView }) {
  const zone = schedule.when.kind === "cron" ? schedule.when.zone : undefined;
  const busy = [...model.pending.values()].some((request) => "schedule" in request && request.schedule === schedule.id);
  const change = (kind: "accept" | "pause" | "resume" | "unschedule") => input({ type: "schedule-act", id: id(), schedule: schedule.id, change: kind });
  const button = (label: string, kind: Parameters<typeof change>[0], primary = false) => h("button", { type: "button", class: primary ? "primary small" : "ghost small", disabled: busy || model.connection !== "ready", onClick: () => change(kind) }, label);
  return h("article", { class: `schedule ${schedule.phase}`, "aria-label": `Schedule ${schedule.id}` },
    h("div", { class: "schedule-head" },
      h("span", { class: "schedule-when" }, describeWhen(schedule.when)),
      h("span", { class: `phase ${schedule.phase}` }, schedule.phase === "proposed" && schedule.author === "membr" ? "proposed by membr" : schedule.phase)),
    h("p", { class: "schedule-text" }, schedule.text),
    h("p", { class: "label" }, [
      schedule.next.length ? `Next: ${schedule.next.map((time) => fireTime(time, zone)).join(", ")}` : null,
      runLabel(schedule.run),
      schedule.running ? "running now" : null,
      schedule.last ? `Last: ${schedule.last.result}, ${fireTime(schedule.last.at, zone)}` : null,
      schedule.author === "membr" && schedule.phase !== "proposed" ? "set by membr" : null,
    ].filter(Boolean).join(" · ")),
    h("div", { class: "schedule-actions" },
      schedule.phase === "proposed" && button("Accept", "accept", true),
      schedule.phase === "active" && button("Pause", "pause"),
      schedule.phase === "paused" && button("Resume", "resume"),
      button("Delete", "unschedule")));
}

function SchedulesPage() {
  const [text, setText] = useState("");
  const [run, setRun] = useState<ScheduleSpec["run"]>("subagent");
  const [missed, setMissed] = useState<ScheduleSpec["missed"]>("once");
  const schedules = model.schedules.filter((schedule) => schedule.phase !== "cancelled");
  function add() {
    if (!text.trim() || model.connection !== "ready") return;
    input({ type: "schedule-preview", id: id(), text: text.trim(), zone: clientZone(), run, missed });
    setText("");
  }
  return h("div", { class: "schedules" },
    h("form", { class: "schedule-form", onSubmit: (event: SubmitEvent) => { event.preventDefault(); add(); } },
      h("input", { "aria-label": "When and what", placeholder: "every weekday 8:30 read the inbox notes", value: text, onInput: (event: Event) => { if (event.currentTarget instanceof HTMLInputElement) setText(event.currentTarget.value); } }),
      h("label", null, "Run as", h("select", { "aria-label": "Run as", value: run, onChange: (event: Event) => { if (event.currentTarget instanceof HTMLSelectElement) setRun(event.currentTarget.value === "turn" ? "turn" : "subagent"); } },
        h("option", { value: "subagent" }, "A subagent"), h("option", { value: "turn" }, "A turn in the chat"))),
      h("label", null, "If missed", h("select", { "aria-label": "If missed", value: missed, onChange: (event: Event) => { if (event.currentTarget instanceof HTMLSelectElement) setMissed(event.currentTarget.value === "skip" ? "skip" : "once"); } },
        h("option", { value: "once" }, "Run once when back"), h("option", { value: "skip" }, "Skip"))),
      h("button", { type: "submit", class: "primary", disabled: !text.trim() || model.connection !== "ready" }, "Add")),
    h(SchedulePreview, null),
    schedules.length === 0 && h("p", { class: "empty" }, "No schedules yet."),
    schedules.map((schedule) => h(ScheduleCard, { schedule, key: schedule.id })));
}

// Asks for the next older page when it nears the viewport, and is a button too, for a visitor who would rather ask.
function Earlier() {
  const state = earlier(model);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state !== "idle" || !button.current) return;
    const observer = new IntersectionObserver((seen) => { if (seen.some((item) => item.isIntersecting)) input({ type: "older", id: id() }); }, { root: button.current.closest(".scroller"), rootMargin: "600px 0px 0px 0px" });
    observer.observe(button.current);
    return () => observer.disconnect();
  }, [state]);
  if (state === "none") return null;
  return h("button", { type: "button", class: "ghost small earlier", ref: button, disabled: state === "loading", "aria-busy": state === "loading", onClick: () => input({ type: "older", id: id() }) }, "Load earlier messages");
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

function NotebookPage() {
  // from: the revision the edit started from. saving: the act in flight, so a refusal keeps the draft.
  const [editing, setEditing] = useState<{ from: number; draft: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    if (saving === null || model.pending.has(saving)) return;
    setSaving(null);
    if (!model.error) setEditing(null);
  });
  const notebook = model.notebook;
  if (!notebook) return h("p", { class: "empty" }, "Loading the notebook...");
  const used = editing ? bytesOf(editing.draft) : bytesOf(notebook.text);
  const newer = editing !== null && notebook.revision > editing.from;
  const by = notebook.by === null ? "" : ` · changed by ${notebook.by === "agent" ? "the agent" : "you"}`;
  const save = () => {
    if (!editing || used > NOTEBOOK_CAP || model.connection !== "ready") return;
    const request = id();
    setSaving(request);
    input({ type: "notebook-save", id: request, text: editing.draft, base: notebook.revision });
  };
  return h("div", { class: "notebook" },
    h("div", { class: "notebook-bar" },
      h("span", { class: "label" }, `Revision ${notebook.revision}${by}`),
      h("span", { class: "grow" }),
      h("a", { class: "ghost small", href: "notebook.md", download: "" }, "Download"),
      !editing && h("button", { type: "button", class: "primary small", onClick: () => setEditing({ from: notebook.revision, draft: notebook.text }) }, "Edit")),
    editing
      ? h("div", { class: "notebook-edit" },
        newer && h("section", { class: "notebook-newer", "aria-label": "Newer notebook" },
          h("p", { class: "label" }, `${notebook.by === "agent" ? "The agent" : "Someone"} changed the notebook to revision ${notebook.revision} while you edited. Your draft is kept. Save replaces this text with your draft.`),
          h("pre", null, notebook.text)),
        h("textarea", { "aria-label": "Notebook text", value: editing.draft, rows: 18, onInput: (event: Event) => { if (event.currentTarget instanceof HTMLTextAreaElement) setEditing({ ...editing, draft: event.currentTarget.value }); } }),
        h("div", { class: "notebook-bar" },
          h("span", { class: used > NOTEBOOK_CAP ? "over" : "label", role: "status", "aria-label": "Notebook size" }, `${used} / ${NOTEBOOK_CAP}`),
          h("span", { class: "grow" }),
          h("button", { type: "button", class: "ghost", onClick: () => setEditing(null) }, "Cancel"),
          h("button", { type: "button", class: "primary", disabled: used > NOTEBOOK_CAP || saving !== null || model.connection !== "ready", onClick: save }, "Save")))
      : notebook.text === "" ? h("p", { class: "empty" }, "The notebook is empty.") : h(Markdown, { text: notebook.text, diagrams: false }),
    !editing && h("p", { class: "label" }, `${used} / ${NOTEBOOK_CAP} bytes`));
}

function CommandMenu({ commands, selected, choose }: { commands: Command[]; selected: number; choose: (command: Command) => void }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { list.current?.children[selected]?.scrollIntoView({ block: "nearest" }); }, [selected, commands]);
  return h("ul", { class: "command-menu", role: "listbox", "aria-label": "Commands", ref: list }, commands.map((command, index) => h("li", {
    key: command.name, role: "option", "aria-selected": index === selected, class: index === selected ? "selected" : undefined,
    onPointerDown: (event: Event) => event.preventDefault(), onClick: () => choose(command),
  }, h("span", { class: "command-name" }, command.name, command.hint && h("span", { class: "command-hint" }, " " + command.hint)),
  h("span", { class: "command-description" }, command.description))));
}

function App() {
  const [, update] = useState(0);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [caret, setCaret] = useState(0);
  // Where the caret goes after the next render: setting `value` moves it to the end, so Tab puts it back.
  const place = useRef<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [readingImages, setReadingImages] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const subagent = model.subagent === null ? null : model.subagents.get(model.subagent);
  const scroll = useChatScroll(model.page === "chat" && (model.subagent !== null || !model.folded), { log: model.subagent ?? "", entries: subagent?.entries ?? model.entries, from: subagent ? 0 : model.from, live: subagent?.live ?? model.live, ready: model.connection === "ready" && (model.subagent === null || subagent?.loaded === true) });
  changed = () => update((value) => value + 1);
  useEffect(() => {
    const page = () => input({ type: "page", page: location.hash === "#tree" ? "tree" : location.hash === "#schedules" ? "schedules" : location.hash === "#notebook" ? "notebook" : "chat" });
    page();
    window.addEventListener("hashchange", page);
    return () => { window.removeEventListener("hashchange", page); };
  }, []);
  async function attach(selected: File[]) {
    setReadingImages(true);
    try {
      const images = await Promise.all(selected.map((file) => new Promise<Attachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The image could not be read."));
        reader.onload = () => {
          if (typeof reader.result !== "string") return reject(new Error("The image could not be read."));
          resolve({ id: id(), name: file.name, type: file.type, data: reader.result.slice(reader.result.indexOf(",") + 1) });
        };
        reader.readAsDataURL(file);
      })));
      input({ type: "attach", images });
    } catch (error) {
      model = hear(model, { type: "error", id: null, reason: error instanceof Error ? error.message : "The image could not be read." });
      changed();
    } finally { setReadingImages(false); }
  }
  const completion = complete(model, draft, caret);
  const commands = menuClosed ? [] : completion.commands;
  const current = Math.min(selected, commands.length - 1);
  useLayoutEffect(() => {
    if (place.current !== null) field.current?.setSelectionRange(place.current, place.current);
    place.current = null;
  });
  function edit(text: string, at: number = text.length) { setDraft(text); setCaret(at); setSelected(0); setMenuClosed(false); }
  function insert(command: Command) {
    const next = accept(draft, caret, completion, command);
    edit(next.text, next.cursor);
    place.current = next.cursor;
    field.current?.focus();
  }
  const track = (event: Event) => { if (event.currentTarget instanceof HTMLTextAreaElement) setCaret(event.currentTarget.selectionStart); };
  function send() {
    if ((!draft.trim() && !model.attachments.length) || readingImages || model.connection === "refused") return;
    input({ type: "send", id: id(), text: draft });
    if (!model.error) { edit(""); scroll.followLatest(); }
  }
  const status = model.connection === "ready" ? model.state.busy ? model.state.wait || "Working" : "Ready" : model.connection === "connecting" ? "Connecting" : model.connection === "refused" ? "Access refused" : "Offline. Messages will send when connected.";
  const tone = model.connection === "ready" ? model.state.busy ? "busy" : "ready" : model.connection === "refused" ? "refused" : "offline";
  const body = rows(model);
  const chatting = model.page === "chat" && model.subagent === null;
  return h("div", { class: "app" },
    h("header", null,
      h("h1", null, "membr", h("span", { class: "brand-dot", "aria-hidden": "true" }, ".")),
      h(AgentSwitch, null),
      h("nav", { "aria-label": "Pages" }, h("a", { href: "#chat", "aria-current": model.page === "chat" ? "page" : undefined }, "Chat"), h("a", { href: "#tree", "aria-current": model.page === "tree" ? "page" : undefined }, "Memory"), h("a", { href: "#schedules", "aria-current": model.page === "schedules" ? "page" : undefined }, "Schedules"), h("a", { href: "#notebook", "aria-current": model.page === "notebook" ? "page" : undefined }, "Notebook")),
      h("div", { class: "meta" },
        h("span", { class: `pulse ${tone}`, "aria-hidden": "true" }),
        h("span", { role: "status" }, status),
        model.imports.some((run) => run.phase === "running") && h("span", { class: "importing" }, "Importing"),
        model.state.subagents.length > 0 && h("span", { class: "at-work" }, `${model.state.subagents.length} subagent${model.state.subagents.length === 1 ? "" : "s"} at work`),
        h(Usage, null),
        h(Settings, null))),
    h("div", { class: "scroller", ref: scroll.scroller }, h("main", { ref: scroll.main, "aria-label": model.page === "tree" ? "Memory tree" : model.page === "schedules" ? "Schedules" : model.page === "notebook" ? "Notebook" : model.subagent === null ? "Chat" : `${model.subagent} log` },
      model.page === "tree" && h("h2", null, "Memory tree"),
      model.page === "schedules" && h("h2", null, "Schedules"),
      model.page === "notebook" && h("h2", null, "Notebook"),
      model.info && h("section", { class: "info", "aria-label": "Command information" }, h("pre", null, model.info), h("button", { type: "button", class: "ghost", onClick: () => input({ type: "dismiss-info" }) }, "Close command information")),
      chatting && body.length > 0 && h("div", { class: "fold-bar" },
        model.folded && h("span", { class: "label" }, "The whole chat in the fewest blocks."),
        h("button", { type: "button", class: "ghost small", onClick: () => input({ type: "fold" }) }, model.folded ? "Unfold all" : "Fold all")),
      chatting && !model.folded && h(Earlier, null),
      model.page === "schedules" ? h(SchedulesPage, null) : model.page === "notebook" ? h(NotebookPage, null) : subagent ? [
        h("div", { key: "title", class: "subagent-title" },
          h("button", { type: "button", class: "ghost small", onClick: () => input({ type: "subagent", name: null }) }, "← Main chat"),
          h("h2", null, model.subagent),
          model.subagent !== null && model.state.subagents.includes(model.subagent) && h("span", { class: "label" }, "at work")),
        !scroll.loaded ? h("p", { key: "loading", class: "loading" }, "Loading subagent log...") : brief([...subagent.entries.values()].sort((a, b) => a.i - b.i)).map((row) => h(MemoryBlock, { row, key: rowKey(row) })),
        subagent.live && h("article", { key: "live", class: "message unii live", "data-live": true, "aria-label": "Live subagent reply" }, h("div", { class: "label" }, model.subagent), h(Markdown, { text: subagent.live, diagrams: false })),
      ] : model.page === "chat" && !scroll.loaded ? h("p", { key: "loading", class: "loading" }, "Loading chat...") : [
        body.length === 0 && !model.live && h("p", { key: "empty", class: "empty" }, model.page === "tree" || model.folded ? model.reads.size ? "Loading memory..." : "No memory yet." : "Start a conversation."),
        body.map((row) => h(MemoryBlock, { row, key: rowKey(row) })),
        model.page === "chat" && model.live && h("article", { key: "live", class: "message unii live", "data-live": true, "aria-label": "Live reply" }, h("div", { class: "label" }, "membr"), h(Markdown, { text: model.live, diagrams: false })),
      ])),
    h("footer", null,
      scroll.jump && h("div", { class: "new-messages" }, scroll.jump === "unseen"
        ? h("button", { type: "button", class: "primary", onClick: scroll.goToUnseen }, "New messages")
        : h("button", { type: "button", class: "primary", onClick: scroll.followLatest }, "Back to newest")),
      h(ApprovalCards, null),
      model.error && h("div", { class: "error toast", role: "alert" }, h("span", null, model.error), h("button", { type: "button", class: "ghost small", "aria-label": "Dismiss error", onClick: () => input({ type: "dismiss-error" }) }, "Close")),
      model.pending.size > 0 && h("p", { class: "pending" }, `${model.pending.size} request${model.pending.size === 1 ? "" : "s"} awaiting an answer`),
      chatting && h(SchedulePreview, null),
      model.page === "chat" && model.subagent !== null && h("div", { class: "subagent-bar" }, h("button", { type: "button", class: "ghost", disabled: !model.state.subagents.includes(model.subagent) || model.connection !== "ready", onClick: () => input({ type: "stop", id: id(), subagent: model.subagent }) }, `Stop ${model.subagent}`)),
      chatting && h("form", { class: "composer", onSubmit: (event: SubmitEvent) => { event.preventDefault(); send(); } },
        model.attachments.length > 0 && h("div", { class: "attachments", "aria-label": "Image attachments" }, model.attachments.map((image) => h("div", { key: image.id }, h("img", { class: "attached-image", src: `data:${image.type};base64,${image.data}`, alt: image.name }), h("button", { type: "button", class: "ghost small", "aria-label": `Remove ${image.name}`, onClick: () => input({ type: "detach", id: image.id }) }, "Remove")))),
        commands.length > 0 && h(CommandMenu, { commands, selected: current, choose: insert }),
        h("textarea", { "aria-label": "Message", placeholder: "Message membr", value: draft, rows: 2, ref: field,
          onInput: (event: Event) => { if (event.currentTarget instanceof HTMLTextAreaElement) edit(event.currentTarget.value, event.currentTarget.selectionStart); }, onKeyUp: track, onClick: track,
          onKeyDown: (event: KeyboardEvent) => {
            if (commands.length > 0 && !event.isComposing) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((current + (event.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length); return; }
              if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); insert(commands[current]); return; }
              if (event.key === "Escape") { event.preventDefault(); setMenuClosed(true); return; }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(hover: hover)").matches) { event.preventDefault(); send(); } } }),
        h("input", { type: "file", multiple: true, accept: "image/png,image/jpeg,image/gif,image/webp", hidden: true, ref: files, "aria-label": "Attach images", onChange: (event: Event) => {
          if (!(event.currentTarget instanceof HTMLInputElement)) return;
          const selected = [...event.currentTarget.files ?? []];
          event.currentTarget.value = "";
          if (selected.length) void attach(selected);
        } }),
        h("div", { class: "composer-row" },
          h("button", { type: "button", class: "ghost", "aria-label": readingImages ? "Reading images..." : "Attach", disabled: readingImages || model.connection === "refused", onClick: () => files.current?.click() }, h(Icon, { name: "clip" }), h("span", { class: "narrow-hide" }, readingImages ? "Reading images..." : "Attach")),
          h(PickBar, null),
          h("span", { class: "grow" }),
          model.state.busy && h("button", { type: "button", class: "ghost", disabled: model.connection !== "ready", onClick: () => input({ type: "stop", id: id() }) }, "Stop"),
          h("button", { type: "submit", class: "send", "aria-label": "Send", title: "Send", disabled: (!draft.trim() && !model.attachments.length) || readingImages || model.connection === "refused" }, h(Icon, { name: "up" }))))));
}

followVisibleArea();
render(h(App, null), document.getElementById("app")!);
connect();
