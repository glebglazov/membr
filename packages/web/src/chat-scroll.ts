import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Entry } from "@membr/protocol";

type Target = { kind: "entry"; i: number } | { kind: "live"; after: number };
type Position = { mode: "following" } | { mode: "reading"; unseen: Target | null };
type Content = { log: string; entries: ReadonlyMap<number, Entry>; live: string; ready: boolean };

export function useChatScroll(enabled: boolean, content: Content) {
  const main = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  const position = useRef<Position>({ mode: "following" });
  const previous = useRef(content);
  const active = useRef(enabled);
  active.current = enabled;
  const [, update] = useState(0);
  const lastTop = useRef(window.scrollY);
  const frame = useRef(0);

  function setPosition(next: Position) {
    const before = position.current;
    position.current = next;
    if ((before.mode === "reading" && before.unseen !== null) !== (next.mode === "reading" && next.unseen !== null)) update((n) => n + 1);
  }
  function atBottom(): boolean {
    return document.documentElement.scrollHeight - window.innerHeight - window.scrollY <= 2;
  }
  function bottom() {
    if (!active.current || position.current.mode !== "following") return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    lastTop.current = window.scrollY;
  }
  function schedule() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(bottom);
  }
  function find(target: Target): HTMLElement | null {
    if (target.kind === "live") return main.current?.querySelector<HTMLElement>('[data-live]') ?? null;
    return main.current?.querySelector<HTMLElement>(`[data-entry="${target.i}"], [data-entries~="${target.i}"]`) ?? null;
  }
  function unseen(target: Target): boolean {
    const node = find(target);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.bottom > (footer.current?.getBoundingClientRect().top ?? window.innerHeight);
  }
  function followLatest() {
    setPosition({ mode: "following" });
    schedule();
  }
  function goToUnseen() {
    const current = position.current;
    if (current.mode !== "reading" || !current.unseen) return;
    const node = find(current.unseen);
    setPosition({ mode: "reading", unseen: null });
    if (node) window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - (header.current?.getBoundingClientRect().bottom ?? 0) - 12, behavior: "instant" });
    lastTop.current = window.scrollY;
    if (atBottom()) followLatest();
  }

  useLayoutEffect(() => {
    if (!enabled) return;
    lastTop.current = window.scrollY;
    const scroll = () => {
      if (atBottom()) setPosition({ mode: "following" });
      else if (window.scrollY < lastTop.current - 1 && position.current.mode === "following") setPosition({ mode: "reading", unseen: null });
      lastTop.current = window.scrollY;
    };
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.deltaY >= 0 || window.scrollY === 0) return;
      let node = event.target instanceof Element ? event.target : null;
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
        node = node.parentElement;
      }
      if (position.current.mode === "following") setPosition({ mode: "reading", unseen: null });
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) {
        if (position.current.mode === "following") setPosition({ mode: "reading", unseen: null });
      }
    };
    const observer = new ResizeObserver(schedule);
    for (const node of [main.current, footer.current, header.current]) if (node) observer.observe(node, { box: "border-box" });
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("wheel", wheel, { passive: true });
    window.addEventListener("keydown", key);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", schedule);
    };
  }, [enabled]);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = content;
    if (!enabled) return;
    if (before.log !== content.log) setPosition({ mode: "following" });
    const current = position.current;
    if (current.mode === "following") { bottom(); return; }
    if (!before.ready || !content.ready) return;
    const added = [...content.entries.values()].filter((entry) => !before.entries.has(entry.i)).sort((a, b) => a.i - b.i);
    if (current.unseen?.kind === "live") {
      const after = current.unseen.after;
      const final = added.find((entry) => entry.kind === "unii" && entry.i > after);
      if (final) setPosition({ mode: "reading", unseen: { kind: "entry", i: final.i } });
      else if (!content.live) setPosition({ mode: "reading", unseen: null });
    }
    if (position.current.mode !== "reading" || position.current.unseen) return;
    const next = added.find((entry) => unseen({ kind: "entry", i: entry.i }));
    if (next) setPosition({ mode: "reading", unseen: { kind: "entry", i: next.i } });
    else if (content.live && content.live !== before.live) {
      const target: Target = { kind: "live", after: [...content.entries.keys()].reduce((last, i) => Math.max(last, i), -1) };
      if (unseen(target)) setPosition({ mode: "reading", unseen: target });
    }
  }, [enabled, content.log, content.entries, content.live, content.ready]);

  return { main, footer, header, hasUnseen: enabled && position.current.mode === "reading" && position.current.unseen !== null, goToUnseen, followLatest };
}
