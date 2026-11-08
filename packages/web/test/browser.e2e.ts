import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

async function withChat(options: {
  browser: Browser;
  engine: FakeEngine;
  check: (context: BrowserContext, url: string) => Promise<void>;
}): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "membr-web-e2e-"));
  try {
    const hub = serveHub({ dir, port: 0, engine: options.engine });
    try {
      const context = await options.browser.newContext({ viewport: { width: 1200, height: 900 }, hasTouch: true });
      try {
        const errors: string[] = [];
        context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
        await options.check(context, hub.server.url.href);
        expect(errors, "The browser has no uncaught JavaScript errors.").toEqual([]);
      } finally {
        await context.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function openChat(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(url);
  await expect(page.getByRole("status")).toHaveText("Ready");
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function sameTurn(browser: Browser): Promise<void> {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "delta", text: "A shared" }));
  await withChat({ browser, engine, check: async (context, url) => {
    const tabs = [await openChat(context, url), await openChat(context, url)];
    await send(tabs[0], "Show this turn in both tabs.");
    for (const page of tabs) {
      await expect(page.getByRole("main", { name: "Chat", exact: true }).getByText("Show this turn in both tabs.", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Live reply", { exact: true })).toContainText("A shared");
      await expect(page.getByRole("status")).toHaveText("Working");
    }
    engine.epochs[0].emit({ kind: "delta", text: " reply." });
    for (const page of tabs) {
      await expect(page.getByLabel("Live reply", { exact: true })).toContainText("A shared reply.");
    }
    engine.epochs[0].emit({ kind: "text", text: "A shared reply." }, END);
    for (const page of tabs) {
      await expect(page.getByLabel("Live reply", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Chat", exact: true }).getByText("A shared reply.", { exact: true })).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Ready");
    }
  } });
}

async function compressionUse(browser: Browser): Promise<void> {
  const engine = new FakeEngine((epoch) => epoch.emit({ ...END, context: { used: 42_000, window: 200_000 } }));
  engine.compactUsage = { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 };
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await expect(page.locator(".usage")).toHaveCount(0);
    await send(page, "A message long enough for Haiku to compress. " + "x".repeat(600));
    await expect(page.locator(".usage")).toHaveText("epoch 42k / 150k (28%)");
    await page.locator("summary[aria-label=Settings]").click();
    await expect(page.getByLabel("Compression use")).toContainText("100 sent, 90.0% cached, 5 out");
    await expect(page.getByLabel("Epoch size")).toContainText("42,000 of 150,000 tokens");
  } });
}

async function sharedApproval(browser: Browser): Promise<void> {
  const engine = new FakeEngine((epoch) => {
    void epoch.options.ask?.("Bash", { command: "pwd" }).then((allowed) => {
      epoch.emit({ kind: "text", text: allowed ? "Approved pwd. The turn continued." : "Denied pwd." }, END);
    });
  });
  await withChat({ browser, engine, check: async (context, url) => {
    const tabs = [await openChat(context, url), await openChat(context, url)];
    await send(tabs[0], "Ask before running pwd.");
    for (const page of tabs) {
      const card = page.getByRole("region", { name: "Approval Bash", exact: true });
      await expect(card).toBeVisible();
      await expect(card).toContainText("pwd");
    }
    await tabs[1].getByRole("button", { name: "Allow once", exact: true }).click();
    for (const page of tabs) {
      await expect(page.getByRole("region", { name: "Approval Bash", exact: true })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Chat", exact: true }).getByText("Approved pwd. The turn continued.", { exact: true })).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Ready");
    }
  } });
}

type Layout = {
  width: number;
  height: number;
  colorScheme: "light" | "dark";
  background: string;
};
const layouts: Layout[] = [
  { width: 1200, height: 900, colorScheme: "light", background: "rgb(247, 245, 240)" },
  { width: 1200, height: 900, colorScheme: "dark", background: "rgb(22, 21, 19)" },
  { width: 390, height: 844, colorScheme: "light", background: "rgb(247, 245, 240)" },
  { width: 390, height: 844, colorScheme: "dark", background: "rgb(22, 21, 19)" },
];

async function responsiveLayout(browser: Browser): Promise<void> {
  const engine = new FakeEngine((epoch, message) => {
    void epoch.options.ask?.("Bash", { command: message.text }).then(() => epoch.emit(END));
  });
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    const text = "Check the layout " + "x".repeat(360);
    await send(page, text);
    const card = page.getByRole("region", { name: "Approval Bash", exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText(text);
    for (const layout of layouts) {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.emulateMedia({ colorScheme: layout.colorScheme });
      await expect(page.locator("body")).toHaveCSS("background-color", layout.background);
      await expect(page.getByRole("main", { name: "Chat", exact: true }).getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("A draft at this width.");
      await page.getByRole("button", { name: "Send", exact: true }).click({ trial: true });
      await card.getByRole("button", { name: "Allow once", exact: true }).click({ trial: true });
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout.colorScheme} mode at ${layout.width} px has no horizontal overflow.`).toBe(true);
    }
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("Ready");
  } });
}

async function markdownReply(browser: Browser): Promise<void> {
  const reply = "## Overview\n\nThe **hub** owns the chat.\n\n```mermaid\nflowchart LR\n  B[Browser] --> H[Hub]\n```\n\n<img src=x onerror=alert(1)>";
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: reply }, END));
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Explain the hub.");
    const chat = page.getByRole("main", { name: "Chat", exact: true });
    await expect(chat.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(chat.locator("strong", { hasText: "hub" })).toBeVisible();
    const diagram = chat.locator("figure.diagram");
    await expect(diagram.locator("svg")).toBeVisible();
    await expect(diagram.locator("svg")).toContainText("Hub");
    await diagram.getByRole("button", { name: "Source", exact: true }).click();
    await expect(diagram.locator("pre")).toContainText("B[Browser] --> H[Hub]");
    await expect(diagram.locator("svg")).toBeHidden();
    expect(await chat.locator("img[onerror]").count(), "Sanitizing drops event handlers from model HTML.").toBe(0);
  } });
}

async function diagramZoom(browser: Browser): Promise<void> {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "```mermaid\nflowchart LR\n  A[Browser] --> B[Hub]\n```\n\n" + "More details below the diagram.\n\n".repeat(30) }, END));
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Draw a diagram.");
    const diagram = page.locator("figure.diagram");
    const svg = diagram.locator("svg");
    await expect(svg).toBeVisible();
    const original = await svg.getAttribute("viewBox");
    const node = svg.locator("g.node").first();
    const initialWidth = (await node.boundingBox())!.width;
    await svg.hover();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -250);
    await page.keyboard.up("Control");
    await expect(svg, "A trackpad pinch zooms the diagram.").not.toHaveAttribute("viewBox", original!);
    expect((await node.boundingBox())!.width).toBeGreaterThan(initialWidth);
    const zoomed = await svg.getAttribute("viewBox");
    const desktopBox = (await svg.boundingBox())!;
    await page.mouse.move(desktopBox.x + desktopBox.width / 2, desktopBox.y + desktopBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(desktopBox.x + desktopBox.width / 2 + 30, desktopBox.y + desktopBox.height / 2);
    await page.mouse.up();
    await expect(svg, "Mouse drag moves a zoomed diagram.").not.toHaveAttribute("viewBox", zoomed!);
    await diagram.getByRole("button", { name: "Reset diagram zoom", exact: true }).click();
    await expect(svg).toHaveAttribute("viewBox", original!);
    await svg.hover();
    const beforeWheel = await page.evaluate(() => document.querySelector(".scroller")!.scrollTop);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.evaluate(() => document.querySelector(".scroller")!.scrollTop), { message: "An ordinary wheel scrolls the page over a diagram." }).toBeGreaterThan(beforeWheel);
    await expect(svg).toHaveAttribute("viewBox", original!);
    await page.setViewportSize({ width: 390, height: 844 });
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    if (!box) throw new Error("The diagram has no bounds.");
    const client = await context.newCDPSession(page);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const points = (distance: number) => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(25) });
    for (const distance of [35, 45, 55, 65]) await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(distance) });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(svg, "A two-finger pinch zooms the diagram on a touch screen.").not.toHaveAttribute("viewBox", original!);
    expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
    const pinched = await svg.getAttribute("viewBox");
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(25) });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(25).map((point) => ({ ...point, x: point.x + 20 })) });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(svg, "Two fingers move a zoomed diagram.").not.toHaveAttribute("viewBox", pinched!);
    await diagram.getByRole("button", { name: "Reset diagram zoom", exact: true }).click();
    await expect(svg).toHaveAttribute("viewBox", original!);
    await svg.scrollIntoViewIfNeeded();
    const touchBox = (await svg.boundingBox())!;
    const beforeSwipe = await page.evaluate(() => document.querySelector(".scroller")!.scrollTop);
    const touchX = touchBox.x + touchBox.width / 2, touchY = touchBox.y + touchBox.height / 2;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY, id: 1 }] });
    for (const delta of [15, 30, 45, 60]) await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y: touchY - delta, id: 1 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => document.querySelector(".scroller")!.scrollTop), { message: "A one-finger swipe scrolls the page over a diagram." }).toBeGreaterThan(beforeSwipe);
    await expect(svg).toHaveAttribute("viewBox", original!);
    for (const colorScheme of ["light", "dark"] as const) {
      const previous = await svg.getAttribute("id");
      const changed = await page.evaluate((scheme) => matchMedia(`(prefers-color-scheme: ${scheme})`).matches === false, colorScheme);
      await page.emulateMedia({ colorScheme });
      if (changed) await expect(svg).not.toHaveAttribute("id", previous!);
      await expect(diagram.getByRole("button", { name: "Reset diagram zoom", exact: true })).toHaveCount(1);
      await diagram.getByRole("button", { name: "Zoom in diagram", exact: true }).click();
      const enlarged = (await node.boundingBox())!.width;
      await diagram.getByRole("button", { name: "Zoom out diagram", exact: true }).click();
      expect((await node.boundingBox())!.width).toBeLessThan(enlarged);
      await expect(svg).toHaveAttribute("viewBox", original!);
    }
    await client.detach();
  } });
}

async function briefsAndAgents(browser: Browser): Promise<void> {
  const engine = new FakeEngine((epoch, message) => {
    const subagents = epoch.options.subagents;
    if (!subagents) return epoch.emit({ kind: "text", text: "The log is **append-only**." }, { ...END, reply: "The log is **append-only**." });
    if (message.from === "membr") return epoch.emit(END);
    epoch.emit({ kind: "tool", id: "read", name: "Read", input: { file_path: "/repo/packages/server/src/log.ts" } }, { kind: "echo", id: "read", text: "export class Log", error: false });
    epoch.emit({ kind: "tool", id: "spawn", name: "mcp__memory__spawn", input: { tasks: [{ name: "store-reader", task: "Read log.ts" }] } });
    epoch.emit({ kind: "echo", id: "spawn", text: subagents.spawn([{ name: "store-reader", task: "Read log.ts" }]), error: false }, { kind: "text", text: "I asked store-reader." }, END);
  });
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Explain the log.");
    const chat = page.getByRole("main", { name: "Chat", exact: true });
    const tools = chat.locator("details.brief.tools");
    await expect(tools.locator(":scope > summary")).toContainText("Made 1 tool call");
    await expect(tools.locator(".call")).toBeHidden();
    await tools.locator(":scope > summary").click();
    await expect(tools.locator(".call-what")).toHaveText("…/server/src/log.ts");
    await expect(chat.locator("details.brief.spawn summary")).toContainText("Started 1 subagent");
    const report = chat.locator("details.brief.report");
    await expect(report.locator(":scope > summary")).toContainText("store-reader reported");
    await report.locator(":scope > summary").click();
    await expect(report.locator("strong", { hasText: "append-only" })).toBeVisible();
    await expect(page.locator(".subagent-tabs")).toHaveCount(0);
    await report.getByRole("button", { name: "Open store-reader's chat", exact: true }).click();
    const subagentChat = page.getByRole("main", { name: "store-reader log", exact: true });
    await expect(subagentChat.getByRole("heading", { name: "store-reader", exact: true })).toBeVisible();
    await expect(subagentChat.getByText("Read log.ts", { exact: true })).toBeVisible();
    await expect(subagentChat.locator("details.brief.note summary").last()).toContainText("Finished.");
    await subagentChat.getByRole("button", { name: "← Main chat", exact: true }).click();
    await expect(chat.getByText("I asked store-reader.", { exact: true })).toBeVisible();
  } });
}

let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  await sameTurn(browser);
  console.log("PASS Two tabs show the same live and completed turn.");
  await sharedApproval(browser);
  console.log("PASS An approval answer closes the card in both tabs.");
  await compressionUse(browser);
  console.log("PASS The status shows the epoch size of the size that starts a new epoch, and the settings show the tokens sent to Haiku for compression with their cache share.");
  await responsiveLayout(browser);
  console.log("PASS Light and dark layouts fit desktop and 390 px widths.");
  await markdownReply(browser);
  console.log("PASS A reply renders Markdown and draws its Mermaid diagram.");
  await diagramZoom(browser);
  console.log("PASS Diagram zoom responds to trackpad and touch pinch.");
  await briefsAndAgents(browser);
  console.log("PASS Tool calls, a subagent start and its report fold into briefs that open the subagent's chat.");
  console.log("7 browser checks passed.");
} finally {
  await browser?.close();
}
