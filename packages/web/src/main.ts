import { h, render, type ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { act, createModel, hear, rows, partKey, type Input, type Row } from "@membr/core";
import { VERSION, parseEvent, type Entry } from "@membr/protocol";
import "./style.css";

let model = createModel();
let socket: WebSocket | null = null;
let changed = () => {};

function id(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

function input(value: Input) {
  const result = act(model, value);
  model = result.model;
  for (const message of [...result.acts, ...result.reads]) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
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

function Block({ entry }: { entry: Entry }) {
  const label = { user: "You", unii: "membr", tool: "Tool call", echo: "Tool result", work: "Report", note: "Note" }[entry.kind];
  return h("article", { class: `message ${entry.kind}`, "data-entry": entry.i },
    h("div", { class: "label" }, label), h("div", { class: "text" }, entry.text));
}

function MemoryBlock({ row }: { row: Row }): ComponentChild {
  if (row.kind === "message") return h(Block, { entry: row.entry });
  const { part } = row;
  const name = `${part.i * 2 ** part.l}+${2 ** part.l}`;
  if (row.kind === "summary") return h("button", {
    type: "button", class: "message summary", "data-part": partKey(part), "aria-label": `Open block ${name}`,
    onClick: () => input({ type: "open", id: id(), part }),
  }, h("span", { class: "label" }, `${2 ** part.l} message${part.l === 0 ? "" : "s"}`), h("span", { class: "text" }, row.text));
  return h("section", { class: "memory-open", "data-part": partKey(part) },
    h("button", { type: "button", class: "close-block", "aria-label": `Close block ${name}`, onClick: () => input({ type: "close", part }) }, `Close ${2 ** part.l} message${part.l === 0 ? "" : "s"}`),
    row.loading && h("p", { role: "status", class: "label" }, "Loading block..."),
    row.rows.map((child) => h(MemoryBlock, { row: child, key: child.kind === "message" ? `entry-${child.entry.i}` : partKey(child.part) })));
}

function App() {
  const [, update] = useState(0);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  changed = () => update((value) => value + 1);
  useEffect(() => {
    const scroll = () => { follow.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120; };
    const page = () => input({ type: "page", page: location.hash === "#tree" ? "tree" : "chat" });
    page();
    window.addEventListener("scroll", scroll);
    window.addEventListener("hashchange", page);
    return () => { window.removeEventListener("scroll", scroll); window.removeEventListener("hashchange", page); };
  }, []);
  useEffect(() => { if (follow.current && model.page === "chat" && !model.folded) end.current?.scrollIntoView({ block: "end" }); }, [model.entries, model.live]);
  function send() {
    if (!draft.trim() || model.connection === "refused") return;
    input({ type: "send", id: id(), text: draft });
    setDraft("");
    follow.current = true;
  }
  const status = model.connection === "ready" ? model.state.busy ? model.state.wait || "Working" : "Ready" : model.connection === "connecting" ? "Connecting" : model.connection === "refused" ? "Access refused" : "Offline. Messages will send when connected.";
  const body = rows(model);
  return h("div", { class: "app" },
    h("header", null, h("h1", null, "membr"),
      h("nav", { "aria-label": "Pages" }, h("a", { href: "#chat", "aria-current": model.page === "chat" ? "page" : undefined }, "Chat"), h("a", { href: "#tree", "aria-current": model.page === "tree" ? "page" : undefined }, "Tree")),
      h("span", { role: "status" }, status)),
    h("main", { "aria-label": model.page === "tree" ? "Memory tree" : "Chat" },
      model.page === "tree" && h("h2", null, "Memory tree"),
      model.page === "chat" && h("button", { type: "button", onClick: () => input({ type: "fold" }) }, model.folded ? "Unfold all" : "Fold all"),
      model.folded && model.page === "chat" && h("p", { class: "label" }, "The whole chat in the fewest blocks."),
      body.length === 0 && !model.live && h("p", { class: "empty" }, model.page === "tree" || model.folded ? model.reads.size ? "Loading memory..." : "No memory yet." : "Start a conversation."),
      body.map((row) => h(MemoryBlock, { row, key: row.kind === "message" ? `entry-${row.entry.i}` : partKey(row.part) })),
      model.page === "chat" && model.live && h("article", { class: "message unii live", "aria-label": "Live reply" }, h("div", { class: "label" }, "membr"), h("div", { class: "text" }, model.live)),
      h("div", { ref: end })),
    h("footer", null,
      model.error && h("p", { class: "error", role: "alert" }, model.error),
      model.pending.size > 0 && h("p", { class: "pending" }, `${model.pending.size} request${model.pending.size === 1 ? "" : "s"} awaiting an answer`),
      model.page === "chat" && h("form", { onSubmit: (event: SubmitEvent) => { event.preventDefault(); send(); } },
        h("textarea", { "aria-label": "Message", placeholder: "Message membr", value: draft, rows: 2,
          onInput: (event: Event) => { if (event.currentTarget instanceof HTMLTextAreaElement) setDraft(event.currentTarget.value); },
          onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(hover: hover)").matches) { event.preventDefault(); send(); } } }),
        h("button", { type: "submit", disabled: !draft.trim() || model.connection === "refused" }, "Send"),
        h("button", { type: "button", disabled: !model.state.busy || model.connection !== "ready", onClick: () => input({ type: "stop", id: id() }) }, "Stop"))));
}

render(h(App, null), document.getElementById("app")!);
connect();
