import { h } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { diagramZoom } from "./diagram-zoom.ts";

const marked = new Marked({ gfm: true, breaks: true, async: false });

// Model text is untrusted: links open outside the chat, and nothing it writes can run.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noreferrer"); }
});

function html(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

// Mermaid is a hundred times the size of the rest of the web view, so it is its own bundle
// (src/mermaid.ts), loaded once a finished message holds a diagram. The URL is a variable so the
// bundler leaves the import alone.
type Mermaid = typeof import("mermaid").default;
// Relative to the page, which is /membr/<agent>/ or the default agent's /.
const MERMAID_URL = new URL("mermaid.js", location.href).href;
let mermaid: Promise<Mermaid> | undefined;
let rendered = 0;
const dark = matchMedia("(prefers-color-scheme: dark)");
const diagrams = new Map<HTMLElement, () => void>();

function themed(api: Mermaid): Mermaid {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  api.initialize({ startOnLoad: false, suppressErrorRendering: true, securityLevel: "strict", theme: "base", fontFamily: value("--sans"), themeVariables: {
    darkMode: dark.matches, background: value("--surface"), primaryColor: value("--block"), primaryTextColor: value("--ink"),
    primaryBorderColor: value("--mid"), lineColor: value("--mid"), secondaryColor: value("--surface"), tertiaryColor: value("--paper"),
    clusterBkg: value("--paper"), clusterBorder: value("--line"), edgeLabelBackground: value("--surface"), fontSize: "13px",
  } });
  return api;
}

async function draw(figure: HTMLElement): Promise<void> {
  const source = figure.querySelector("pre")?.textContent ?? "";
  const canvas = figure.querySelector<HTMLElement>(".diagram-canvas")!;
  try {
    const api = await (mermaid ??= (import(MERMAID_URL) as Promise<{ default: Mermaid }>).then((module) => themed(module.default)));
    const { svg } = await api.render(`mermaid-${++rendered}`, source);
    if (!diagrams.has(figure)) return;
    diagrams.get(figure)?.();
    canvas.innerHTML = svg;
    const drawing = canvas.querySelector("svg");
    if (drawing) diagrams.set(figure, diagramZoom(canvas, drawing, figure.querySelector<HTMLElement>(".diagram-bar")!));
    figure.classList.remove("failed");
  } catch (error) {
    if (!diagrams.has(figure)) return;
    diagrams.get(figure)?.();
    diagrams.set(figure, () => {});
    canvas.textContent = "This diagram did not render: " + (error instanceof Error ? error.message : String(error));
    figure.classList.add("failed", "source");
    figure.querySelector<HTMLButtonElement>(".diagram-bar > button")!.textContent = "Diagram";
  }
}

dark.addEventListener("change", () => {
  if (!mermaid) return;
  void mermaid.then((api) => { themed(api); for (const figure of diagrams.keys()) void draw(figure); });
});

// Wraps each ```mermaid block in a figure that shows the diagram, with a button to see its source.
function upgrade(root: HTMLElement): () => void {
  const figures: HTMLElement[] = [];
  for (const code of root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")) {
    const pre = code.parentElement!;
    const figure = document.createElement("figure");
    figure.className = "diagram";
    const bar = document.createElement("div");
    bar.className = "diagram-bar";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghost small";
    toggle.textContent = "Source";
    toggle.addEventListener("click", () => { toggle.textContent = figure.classList.toggle("source") ? "Diagram" : "Source"; });
    bar.append("Diagram", toggle);
    const canvas = document.createElement("div");
    canvas.className = "diagram-canvas";
    pre.replaceWith(figure);
    figure.append(bar, canvas, pre);
    diagrams.set(figure, () => {});
    figures.push(figure);
    void draw(figure);
  }
  return () => { for (const figure of figures) { diagrams.get(figure)?.(); diagrams.delete(figure); } };
}

// Renders a message as Markdown. A streaming message passes diagrams = false, because its last
// mermaid block may still be half written.
export function Markdown({ text, diagrams: draws = true }: { text: string; diagrams?: boolean }) {
  const body = useMemo(() => html(text), [text]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = root.current;
    if (!draws || !node) return;
    return upgrade(node);
  }, [body, draws]);
  return h("div", { class: "text markdown", ref: root, dangerouslySetInnerHTML: { __html: body } });
}
