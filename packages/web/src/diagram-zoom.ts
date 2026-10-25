type Point = { x: number; y: number };
type Pinch = { center: Point; distance: number };

export function diagramZoom(canvas: HTMLElement, svg: SVGSVGElement, bar: HTMLElement): () => void {
  const base = { x: svg.viewBox.baseVal.x, y: svg.viewBox.baseVal.y, width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height };
  const original = svg.getAttribute("viewBox")!;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let view = { ...base }, scale = 1;
  let pinch: Pinch | null = null;
  let drag: Point | null = null;
  let gestureScale: number | null = null;
  const controls = document.createElement("span");
  controls.className = "diagram-zoom";
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "diagram-resize";
  handle.setAttribute("aria-label", "Resize diagram height");
  handle.title = "Drag to resize. Arrow Up and Arrow Down change height. Home restores the initial height.";
  let resizing: { pointer: number; y: number; height: number } | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = { pointer: event.pointerId, y: event.clientY, height: canvas.getBoundingClientRect().height };
    handle.setPointerCapture(event.pointerId);
  }, options);
  handle.addEventListener("pointermove", (event) => {
    if (!resizing || resizing.pointer !== event.pointerId) return;
    canvas.style.height = `${Math.max(0, resizing.height + event.clientY - resizing.y)}px`;
  }, options);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) handle.addEventListener(type, () => { resizing = null; }, options);
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") canvas.style.removeProperty("height");
    else canvas.style.height = `${Math.max(0, canvas.getBoundingClientRect().height + (event.key === "ArrowUp" ? -32 : 32))}px`;
  }, options);
  canvas.after(handle);
  function change(next: number, from: Point, to = from): void {
    next = Math.max(1, Math.min(8, next));
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const inverse = matrix.inverse();
    const start = new DOMPoint(from.x, from.y).matrixTransform(inverse);
    const finish = new DOMPoint(to.x, to.y).matrixTransform(inverse);
    const ratio = scale / next;
    const width = base.width / next, height = base.height / next;
    const x = start.x - (finish.x - view.x) * ratio;
    const y = start.y - (finish.y - view.y) * ratio;
    view = { x: Math.max(base.x, Math.min(base.x + base.width - width, x)), y: Math.max(base.y, Math.min(base.y + base.height - height, y)), width, height };
    scale = next;
    svg.setAttribute("viewBox", scale === 1 ? original : `${view.x} ${view.y} ${width} ${height}`);
    svg.classList.toggle("zoomed", scale > 1);
  }
  function center(): Point {
    const rect = svg.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  for (const [text, label, factor] of [["−", "Zoom out diagram", 1 / 1.5], ["+", "Zoom in diagram", 1.5], ["Reset", "Reset diagram zoom", 0]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost small";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => change(factor ? scale * factor : 1, center()), options);
    controls.append(button);
  }
  bar.insertBefore(controls, bar.lastChild);
  canvas.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    change(scale * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
  }, { ...options, passive: false });
  function touchPair(touches: TouchList): Pinch | null {
    if (touches.length !== 2) return null;
    const a = touches[0], b = touches[1];
    return { center: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }, distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
  }
  canvas.addEventListener("touchstart", (event) => {
    pinch = touchPair(event.touches);
    if (pinch) event.preventDefault();
  }, { ...options, passive: false });
  canvas.addEventListener("touchmove", (event) => {
    const next = touchPair(event.touches);
    if (pinch && next) {
      event.preventDefault();
      if (pinch.distance > 0) change(scale * next.distance / pinch.distance, pinch.center, next.center);
    }
    pinch = next;
  }, { ...options, passive: false });
  for (const type of ["touchend", "touchcancel"] as const) canvas.addEventListener(type, () => { pinch = null; }, options);
  svg.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || scale === 1) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY };
    svg.setPointerCapture(event.pointerId);
  }, options);
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const next = { x: event.clientX, y: event.clientY };
    change(scale, drag, next);
    drag = next;
  }, options);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) svg.addEventListener(type, () => { drag = null; }, options);
  canvas.addEventListener("gesturestart", (event) => {
    if (pinch) return;
    event.preventDefault();
    gestureScale = scale;
  }, { ...options, passive: false });
  canvas.addEventListener("gesturechange", (event) => {
    if (gestureScale === null || pinch || !("scale" in event) || typeof event.scale !== "number") return;
    event.preventDefault();
    change(gestureScale * event.scale, center());
  }, { ...options, passive: false });
  canvas.addEventListener("gestureend", () => { gestureScale = null; }, options);
  return () => { controller.abort(); controls.remove(); handle.remove(); };
}
