import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Entry } from "@membr/protocol";

type Target = { kind: "entry"; i: number } | { kind: "live"; after: number };
type Position = { mode: "following" } | { mode: "reading"; unseen: Target | null };
type Content = { log: string; entries: ReadonlyMap<number, Entry>; live: string; ready: boolean };

export function useChatScroll(enabled: boolean, content: Content) {
  const scroller = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const position = useRef<Position>({ mode: "following" });
  const previous = useRef(content);
  const active = useRef(enabled);
  active.current = enabled;
  const [, update] = useState(0);
  const lastTop = useRef(0);
  const frame = useRef(0);

  function setPosition(next: Position) {
    const before = position.current;
    position.current = next;
    if ((before.mode === "reading" && before.unseen !== null) !== (next.mode === "reading" && next.unseen !== null)) update((n) => n + 1);
  }
  function top(): number {
    return scroller.current?.scrollTop ?? 0;
  }
  function atBottom(): boolean {
    const node = scroller.current;
    return !node || node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
  }
  function bottom() {
    if (!active.current || position.current.mode !== "following") return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "instant" });
    lastTop.current = top();
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
    return rect.bottom > (scroller.current?.getBoundingClientRect().bottom ?? window.innerHeight);
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
    if (node && scroller.current) scroller.current.scrollTo({ top: top() + node.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top - 12, behavior: "instant" });
    lastTop.current = top();
    if (atBottom()) followLatest();
  }

  useLayoutEffect(() => {
    const surface = scroller.current;
    if (!enabled || !surface) return;
    lastTop.current = top();
    const scroll = () => {
      if (atBottom()) setPosition({ mode: "following" });
      else if (top() < lastTop.current - 1 && position.current.mode === "following") setPosition({ mode: "reading", unseen: null });
      lastTop.current = top();
    };
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.deltaY >= 0 || top() === 0) return;
      let node = event.target instanceof Element ? event.target : null;
      while (node && node !== surface) {
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
    for (const node of [main.current, surface]) if (node) observer.observe(node, { box: "border-box" });
    surface.addEventListener("scroll", scroll, { passive: true });
    surface.addEventListener("wheel", wheel, { passive: true });
    window.addEventListener("keydown", key);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      surface.removeEventListener("scroll", scroll);
      surface.removeEventListener("wheel", wheel);
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

  return { scroller, main, hasUnseen: enabled && position.current.mode === "reading" && position.current.unseen !== null, goToUnseen, followLatest };
}
