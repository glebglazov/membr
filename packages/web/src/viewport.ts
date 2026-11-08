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
}
