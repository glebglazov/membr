import { chromium, webkit, expect, type Locator } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

const browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch();
const dir = mkdtempSync(path.join(tmpdir(), "membr-diagrams-e2e-"));
const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "```mermaid\nflowchart LR\n A[broken\n```\n\n```mermaid\nflowchart LR\n A[Browser] --> B[Hub]\n```\n\n```mermaid\nflowchart TD\n A[Receive message] --> B[Read history] --> C[Select action] --> D[Run action] --> E[Save result] --> F[Reply]\n```" }, END));
const hub = serveHub({ dir, port: 0, engine });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: "light" });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(hub.server.url.href);
    await expect(page.getByRole("status")).toHaveText("Ready");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Draw a broken diagram, then a valid diagram.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const failed = page.locator("figure.diagram.failed");
    const valid = page.locator("figure.diagram:not(.failed)").first();
    const tall = page.locator("figure.diagram:not(.failed)").last();
    await expect(failed).toHaveCount(1);
    await expect(valid.locator("svg")).toBeVisible();
    await expect(failed.locator(".diagram-canvas")).toContainText("This diagram did not render:");
    await expect(failed.locator("pre")).toBeVisible();
    await expect(failed.locator("pre")).toContainText("A[broken");
    await expect(page.locator("body > div:not(#app) svg"), "A parse error does not leave an error picture below the chat.").toHaveCount(0);
    await expect(page.locator("footer [role=alert]")).toHaveCount(0);
    await failed.getByRole("button", { name: "Diagram", exact: true }).click();
    await expect(failed.locator("pre")).toBeHidden();
    await failed.getByRole("button", { name: "Source", exact: true }).click();
    await expect(failed.locator("pre")).toBeVisible();
    for (const colorScheme of ["dark", "light"] as const) {
      const previous = await valid.locator("svg").getAttribute("id");
      await page.emulateMedia({ colorScheme });
      await expect(valid.locator("svg")).not.toHaveAttribute("id", previous!);
      await expect(valid.locator("svg")).toContainText("Hub");
      await expect(failed.locator("pre")).toBeVisible();
      await expect(failed.getByRole("button", { name: "Diagram", exact: true })).toBeVisible();
      await expect(page.locator("body > div:not(#app) svg")).toHaveCount(0);
    }
    async function resize(canvas: Locator, delta: number) {
      const handle = canvas.locator("..").getByRole("button", { name: "Resize diagram height", exact: true });
      await handle.scrollIntoViewIfNeeded();
      const before = (await canvas.boundingBox())!;
      const grip = (await handle.boundingBox())!;
      const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step++) {
        await page.mouse.move(x, y + delta * step / 10);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      }
      await page.mouse.up();
      await expect.poll(async () => (await canvas.boundingBox())!.height, { message: "Dragging the panel handle changes its height." }).toBeCloseTo(before.height + delta, 0);
      expect((await canvas.boundingBox())!.width, "Vertical resize keeps the panel width.").toBe(before.width);
    }
    const canvas = tall.locator(".diagram-canvas");
    const svg = tall.locator("svg");
    const node = svg.locator("g.node").nth(2);
    const initialNode = (await node.boundingBox())!;
    const original = await svg.getAttribute("viewBox");
    await resize(canvas, 120);
    const largerNode = (await node.boundingBox())!;
    expect(largerNode.height, "A taller panel makes a tall diagram larger.").toBeGreaterThan(initialNode.height);
    expect(largerNode.width / largerNode.height, "Resize preserves the diagram proportions.").toBeCloseTo(initialNode.width / initialNode.height, 3);
    const chosenHeight = (await canvas.boundingBox())!.height;
    await page.screenshot({ path: "/tmp/membr-resized-diagram.png" });
    await tall.getByRole("button", { name: "Source", exact: true }).click();
    await expect(tall.locator("pre")).toBeVisible();
    await expect(tall.getByRole("button", { name: "Resize diagram height", exact: true })).toBeHidden();
    await tall.getByRole("button", { name: "Zoom in diagram", exact: true }).click();
    await tall.getByRole("button", { name: "Diagram", exact: true }).click();
    await expect(svg).toHaveAttribute("viewBox", original!);
    expect((await canvas.boundingBox())!.height).toBe(chosenHeight);
    const previous = await svg.getAttribute("id");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(svg).not.toHaveAttribute("id", previous!);
    expect((await canvas.boundingBox())!.height).toBe(chosenHeight);
    await resize(canvas, -180);
    await node.scrollIntoViewIfNeeded();
    const anchor = (await node.boundingBox())!;
    const point = { x: anchor.x + anchor.width * 0.35, y: anchor.y + anchor.height / 2 };
    const anchorInDiagram = await svg.evaluate((element, point) => {
      if (!(element instanceof SVGSVGElement)) throw new Error("The diagram is not an SVG.");
      const mapped = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!.inverse());
      return { x: mapped.x, y: mapped.y };
    }, point);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await expect(svg).not.toHaveAttribute("viewBox", original!);
    const enlarged = (await node.boundingBox())!;
    expect(enlarged.height).toBeGreaterThan(anchor.height);
    const zoomedAnchor = await svg.evaluate((element, point) => {
      if (!(element instanceof SVGSVGElement)) throw new Error("The diagram is not an SVG.");
      const mapped = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!);
      return { x: mapped.x, y: mapped.y };
    }, anchorInDiagram);
    expect(zoomedAnchor.x).toBeCloseTo(point.x, 0);
    expect(zoomedAnchor.y).toBeCloseTo(point.y, 0);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y + 25, { steps: 5 });
    await page.mouse.up();
    const moved = (await node.boundingBox())!;
    expect(moved.y - enlarged.y, "Panning moves the diagram by the drag distance after resize.").toBeCloseTo(25, 0);
    await tall.getByRole("button", { name: "Reset diagram zoom", exact: true }).click();
    await expect(svg).toHaveAttribute("viewBox", original!);
    expect((await canvas.boundingBox())!.height).toBe(chosenHeight - 180);
    const handle = tall.getByRole("button", { name: "Resize diagram height", exact: true });
    await handle.focus();
    await handle.press("ArrowDown");
    await expect.poll(async () => (await canvas.boundingBox())!.height).toBe(chosenHeight - 180 + 32);
    await handle.press("ArrowUp");
    await expect.poll(async () => (await canvas.boundingBox())!.height).toBe(chosenHeight - 180);
    await handle.press("Home");
    await expect.poll(async () => (await canvas.boundingBox())!.height).toBe(chosenHeight - 120);
    await resize(valid.locator(".diagram-canvas"), 80);
    await valid.getByRole("button", { name: "Zoom in diagram", exact: true }).click();
    await expect(valid.locator("svg")).toHaveClass(/zoomed/);
    await expect(failed.getByRole("button", { name: "Resize diagram height", exact: true })).toHaveCount(0);
    console.log("PASS Dragging a diagram panel changes its height, preserves proportions and zoom anchors, and survives source and theme changes.");
    expect(errors, "Invalid Mermaid does not cause an uncaught browser error.").toEqual([]);
    console.log("PASS Invalid Mermaid stays inside its message, shows its source, and does not block a valid diagram in light or dark mode.");
  } finally {
    await context.close();
  }
} finally {
  await hub.close();
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
