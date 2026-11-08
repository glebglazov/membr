// On a phone, the keyboard covers the page instead of making it shorter, and Safari pans the
// page to keep the focused field in view. The app follows the visible area instead, so the
// composer sits on the keyboard with no blank band and the messages stay between it and the header.
export function followVisibleArea(): void {
  const area = window.visualViewport;
  if (!area) return;
  const root = document.documentElement;
  const sync = () => {
    // A pinch zoom also shrinks the visible area; the app keeps its full size then.
    if (area.scale > 1.01) {
      root.style.removeProperty("--visible-height");
      root.style.removeProperty("--visible-top");
      delete root.dataset.keyboard;
      return;
    }
    root.style.setProperty("--visible-height", `${area.height}px`);
    root.style.setProperty("--visible-top", `${area.offsetTop}px`);
    // The keyboard covers the home indicator, so the footer drops its safe-area padding.
    if (window.innerHeight - area.height > 120) root.dataset.keyboard = "";
    else delete root.dataset.keyboard;
  };
  area.addEventListener("resize", sync);
  area.addEventListener("scroll", sync);
  sync();
  holdPageOnFocus();
}

// Safari moves the whole page up when a tap puts focus in a field that the keyboard will cover,
// and the app moves back down only when the keyboard is open, so the page jumps. For a tap on a
// field in the footer, the field goes to the top of the screen for one frame while it gets focus:
// Safari sees it in view and does not move the page. The app then shrinks onto the keyboard.
function holdPageOnFocus(): void {
  let start: { x: number; y: number } | null = null;
  document.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  document.addEventListener("touchend", (event) => {
    const touch = event.changedTouches[0];
    const tap = start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) < 10;
    start = null;
    if (!tap) return;
    const field = event.target instanceof Element ? event.target.closest("footer :is(textarea, input:not([type=checkbox]):not([type=file]))") : null;
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) || field === document.activeElement || field.disabled) return;
    event.preventDefault();
    const { transform, opacity } = field.style;
    field.style.transform = `translateY(${-field.getBoundingClientRect().top}px)`;
    field.style.opacity = "0";
    field.focus({ preventScroll: true });
    requestAnimationFrame(() => { field.style.transform = transform; field.style.opacity = opacity; });
  }, { passive: false });
}
