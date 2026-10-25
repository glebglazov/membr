import { h, render, type ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { act, brief, createModel, hear, rows, partKey, effectivePick, answering, cacheShare, inputTokens, MODELS, EFFORTS, type Attachment, type Upload, type Input, type Row } from "@membr/core";
import { VERSION, parseEvent, type Entry, type ImportSource } from "@membr/protocol";
import "./style.css";
import { readExport } from "./export.ts";
import { Markdown } from "./markdown.ts";
import { BriefRow } from "./briefs.ts";
import { useChatScroll } from "./chat-scroll.ts";

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
    const response = await fetch(`/act/say?id=${encodeURIComponent(request.id)}`, { method: "POST", body: form });
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
  const url = new URL("/ws", location.href);
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
    entry.images?.map((name) => h("a", { href: `/docs/images/${encodeURIComponent(name)}`, target: "_blank", rel: "noreferrer", key: name }, h("img", { class: "attached-image", src: `/docs/images/${encodeURIComponent(name)}`, alt: "Attached image", loading: "lazy" }))));
}

function rowKey(row: Row): string {
  return row.kind === "message" ? `entry-${row.entry.i}` : row.kind === "brief" ? `brief-${row.brief.i}` : partKey(row.part);
}

function MemoryBlock({ row }: { row: Row }): ComponentChild {
  if (row.kind === "message") return h(Block, { entry: row.entry });
  if (row.kind === "brief") return h(BriefRow, { brief: row.brief, working: model.state.agents, openAgent: (name) => input({ type: "agent", name }) });
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

function compact(tokens: number): string {
  return tokens < 1000 ? String(tokens) : tokens < 1e6 ? `${Math.round(tokens / 1000)}k` : `${(tokens / 1e6).toFixed(1)}M`;
}

function Usage() {
  const epoch = model.state.epoch;
  const share = cacheShare(model.state.usage);
  if (!epoch) return null;
  return h("span", { class: "usage" }, `${compact(inputTokens(epoch) + epoch.output)} tokens`, share !== null && ` · cache ${Math.round(share * 100)}%`);
}

function Settings() {
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => { if (panel.current?.open && event.target instanceof Node && !panel.current.contains(event.target)) panel.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const share = cacheShare(model.state.usage);
  const epoch = model.state.epoch;
  return h("details", { class: "settings", ref: panel },
    h("summary", { "aria-label": "Settings", title: "Settings" }, h(Icon, { name: "gear" })),
    h("div", { class: "popover" },
      h("dl", { class: "facts", "aria-label": "Chat status" },
        h("div", { "aria-label": "Current model" }, h("dt", null, "Model"), h("dd", null, model.state.pick?.model ?? "unavailable")),
        h("div", { "aria-label": "Epoch use", title: "Total input and output tokens reported for completed chat turns in the current epoch, including cache reads and writes." }, h("dt", null, "Epoch"), h("dd", null, epoch ? (inputTokens(epoch) + epoch.output).toLocaleString() + " tokens" : "unavailable")),
        h("div", { "aria-label": "Cache share", title: "Cache reads as a share of all input tokens in the last completed turn, including cache writes." }, h("dt", null, "Cache"), h("dd", null, share === null ? "unavailable" : (share * 100).toFixed(1) + "%")),
        h("div", { "aria-label": "Goal", title: model.state.goal ?? "No goal" }, h("dt", null, "Goal"), h("dd", null, model.state.goal ?? "none"))),
      h(ImportPanel, null),
      h("a", { class: "export", href: "/export" }, "Export memory")));
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

function App() {
  const [, update] = useState(0);
  const [draft, setDraft] = useState("");
  const [readingImages, setReadingImages] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const agent = model.agent === null ? null : model.agents.get(model.agent);
  const scroll = useChatScroll(model.page === "chat" && (model.agent !== null || !model.folded), { log: model.agent ?? "", entries: agent?.entries ?? model.entries, live: agent?.live ?? model.live, ready: model.connection === "ready" && (model.agent === null || agent?.loaded === true) });
  changed = () => update((value) => value + 1);
  useEffect(() => {
    const page = () => input({ type: "page", page: location.hash === "#tree" ? "tree" : "chat" });
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
  function send() {
    if ((!draft.trim() && !model.attachments.length) || readingImages || model.connection === "refused") return;
    input({ type: "send", id: id(), text: draft });
    if (!model.error) { setDraft(""); scroll.followLatest(); }
  }
  const status = model.connection === "ready" ? model.state.busy ? model.state.wait || "Working" : "Ready" : model.connection === "connecting" ? "Connecting" : model.connection === "refused" ? "Access refused" : "Offline. Messages will send when connected.";
  const tone = model.connection === "ready" ? model.state.busy ? "busy" : "ready" : model.connection === "refused" ? "refused" : "offline";
  const body = rows(model);
  const chatting = model.page === "chat" && model.agent === null;
  return h("div", { class: "app" },
    h("header", { ref: scroll.header },
      h("h1", null, "membr", h("span", { class: "brand-dot", "aria-hidden": "true" }, ".")),
      h("nav", { "aria-label": "Pages" }, h("a", { href: "#chat", "aria-current": model.page === "chat" ? "page" : undefined }, "Chat"), h("a", { href: "#tree", "aria-current": model.page === "tree" ? "page" : undefined }, "Memory")),
      h("div", { class: "meta" },
        h("span", { class: `pulse ${tone}`, "aria-hidden": "true" }),
        h("span", { role: "status" }, status),
        model.imports.some((run) => run.phase === "running") && h("span", { class: "importing" }, "Importing"),
        model.state.agents.length > 0 && h("span", { class: "at-work" }, `${model.state.agents.length} agent${model.state.agents.length === 1 ? "" : "s"} at work`),
        h(Usage, null),
        h(Settings, null))),
    h("main", { ref: scroll.main, "aria-label": model.page === "tree" ? "Memory tree" : model.agent === null ? "Chat" : `${model.agent} log` },
      model.page === "tree" && h("h2", null, "Memory tree"),
      model.info && h("section", { class: "info", "aria-label": "Command information" }, h("pre", null, model.info), h("button", { type: "button", class: "ghost", onClick: () => input({ type: "dismiss-info" }) }, "Close command information")),
      chatting && body.length > 0 && h("div", { class: "fold-bar" },
        model.folded && h("span", { class: "label" }, "The whole chat in the fewest blocks."),
        h("button", { type: "button", class: "ghost small", onClick: () => input({ type: "fold" }) }, model.folded ? "Unfold all" : "Fold all")),
      agent ? [
        h("div", { key: "title", class: "agent-title" },
          h("button", { type: "button", class: "ghost small", onClick: () => input({ type: "agent", name: null }) }, "← Main chat"),
          h("h2", null, model.agent),
          model.agent !== null && model.state.agents.includes(model.agent) && h("span", { class: "label" }, "at work")),
        !agent.loaded && h("p", { key: "loading", role: "status" }, "Loading agent log..."),
        brief([...agent.entries.values()].sort((a, b) => a.i - b.i)).map((row) => h(MemoryBlock, { row, key: rowKey(row) })),
        agent.live && h("article", { key: "live", class: "message unii live", "data-live": true, "aria-label": "Live agent reply" }, h("div", { class: "label" }, model.agent), h(Markdown, { text: agent.live, diagrams: false })),
      ] : [
        body.length === 0 && !model.live && h("p", { key: "empty", class: "empty" }, model.page === "tree" || model.folded ? model.reads.size ? "Loading memory..." : "No memory yet." : "Start a conversation."),
        body.map((row) => h(MemoryBlock, { row, key: rowKey(row) })),
        model.page === "chat" && model.live && h("article", { key: "live", class: "message unii live", "data-live": true, "aria-label": "Live reply" }, h("div", { class: "label" }, "membr"), h(Markdown, { text: model.live, diagrams: false })),
      ]),
    h("footer", { ref: scroll.footer },
      scroll.hasUnseen && h("div", { class: "new-messages" }, h("button", { type: "button", class: "primary", onClick: scroll.goToUnseen }, "New messages")),
      h(ApprovalCards, null),
      model.error && h("div", { class: "error toast", role: "alert" }, h("span", null, model.error), h("button", { type: "button", class: "ghost small", "aria-label": "Dismiss error", onClick: () => input({ type: "dismiss-error" }) }, "Close")),
      model.pending.size > 0 && h("p", { class: "pending" }, `${model.pending.size} request${model.pending.size === 1 ? "" : "s"} awaiting an answer`),
      model.page === "chat" && model.agent !== null && h("div", { class: "agent-bar" }, h("button", { type: "button", class: "ghost", disabled: !model.state.agents.includes(model.agent) || model.connection !== "ready", onClick: () => input({ type: "stop", id: id(), agent: model.agent }) }, `Stop ${model.agent}`)),
      chatting && h("form", { class: "composer", onSubmit: (event: SubmitEvent) => { event.preventDefault(); send(); } },
        model.attachments.length > 0 && h("div", { class: "attachments", "aria-label": "Image attachments" }, model.attachments.map((image) => h("div", { key: image.id }, h("img", { class: "attached-image", src: `data:${image.type};base64,${image.data}`, alt: image.name }), h("button", { type: "button", class: "ghost small", "aria-label": `Remove ${image.name}`, onClick: () => input({ type: "detach", id: image.id }) }, "Remove")))),
        h("textarea", { "aria-label": "Message", placeholder: "Message membr", value: draft, rows: 2,
          onInput: (event: Event) => { if (event.currentTarget instanceof HTMLTextAreaElement) setDraft(event.currentTarget.value); },
          onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(hover: hover)").matches) { event.preventDefault(); send(); } } }),
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

render(h(App, null), document.getElementById("app")!);
connect();
