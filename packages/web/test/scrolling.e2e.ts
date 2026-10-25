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


async function gap(page: Page) {
  return page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY);
}

async function following(browser: Browser) {
  const engine = new FakeEngine(() => {});
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Start a long reply.");
    let reply = "";
    for (let i = 0; i < 3; i++) {
      const text = `Paragraph ${i}.\n\n`.repeat(30);
      reply += text;
      engine.epochs[0].emit({ kind: "delta", text });
      await expect(page.getByLabel("Live reply", { exact: true })).toContainText(`Paragraph ${i}.`);
      await expect.poll(() => gap(page), { message: "New text follows to the actual document bottom." }).toBeLessThanOrEqual(2);
    }
    const body = reply + "\n```mermaid\nflowchart TD\n A[Start] --> B[Next] --> C[End]\n```";
    engine.epochs[0].emit({ kind: "text", text: body }, END);
    await expect(page.locator("figure.diagram svg")).toBeVisible();
    await expect.poll(() => gap(page), { message: "Deferred diagram layout preserves following." }).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "New messages", exact: true })).toHaveCount(0);
    await page.evaluate(() => { document.querySelector("footer")!.style.paddingBottom = "130px"; });
    await expect.poll(() => gap(page), { message: "A larger footer preserves following." }).toBeLessThanOrEqual(2);
  } });
}

async function reading(browser: Browser) {
  const engine = new FakeEngine(() => {});
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Start the history.");
    const epoch = engine.epochs[0];
    epoch.emit({ kind: "text", text: "Old paragraph.\n\n".repeat(60) });
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    await expect(page.locator("article.unii")).toContainText("Old paragraph.");
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, -650);
    await expect.poll(() => gap(page)).toBeGreaterThan(500);
    const top = await page.evaluate(() => scrollY);
    const first = "First unseen reply.\n\n".repeat(40);
    epoch.emit({ kind: "delta", text: first });
    const button = page.getByRole("button", { name: "New messages", exact: true });
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => scrollY), "New text does not move a reader.").toBe(top);
    epoch.emit({ kind: "text", text: first });
    epoch.emit({ kind: "text", text: "Second unseen reply.\n\n".repeat(40) });
    await expect(page.locator("article.unii").last()).toContainText("Second unseen reply.");
    await button.click();
    const target = page.locator("article.unii").filter({ hasText: "First unseen reply." });
    const bounds = await target.boundingBox();
    const header = await page.locator("header").boundingBox();
    expect(bounds!.y, "The first unseen reply starts below the header.").toBeGreaterThanOrEqual(header!.height);
    expect(bounds!.y).toBeLessThan(header!.height + 20);
    await expect(button).toHaveCount(0);
    await expect.poll(() => gap(page)).toBeGreaterThan(1000);
    const readerTop = await page.evaluate(() => scrollY);
    epoch.emit({ kind: "delta", text: "Third unseen reply.\n\n".repeat(20) });
    await expect(page.getByLabel("Live reply", { exact: true })).toContainText("Third unseen reply.");
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => scrollY), "A jump to a long reply does not resume following.").toBe(readerTop);
    epoch.emit({ kind: "text", text: "Third unseen reply.\n\n".repeat(20) }, END);
    await expect(page.getByRole("status")).toHaveText("Ready");
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    await send(page, "Continue.");
    epoch.emit({ kind: "delta", text: "Another reply.\n\n".repeat(40) });
    await expect(page.getByLabel("Live reply", { exact: true })).toContainText("Another reply.");
    await expect.poll(() => gap(page), { message: "Returning to the bottom resumes following." }).toBeLessThanOrEqual(2);
  } });
}

async function briefTarget(browser: Browser) {
  const engine = new FakeEngine(() => {});
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Run tools.");
    const epoch = engine.epochs[0];
    epoch.emit({ kind: "text", text: "Old paragraph.\n\n".repeat(60) });
    epoch.emit({ kind: "tool", id: "read", name: "Read", input: { file_path: "/repo/file.ts" } });
    epoch.emit({ kind: "tool", id: "spawn", name: "mcp__memory__spawn", input: { tasks: [{ name: "reader", task: "Read another file." }] } });
    await expect(page.locator("details.brief.tools")).toHaveCount(1);
    await expect(page.locator("details.brief.spawn")).toHaveCount(1);
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, -650);
    await expect.poll(() => gap(page)).toBeGreaterThan(500);
    epoch.emit({ kind: "echo", id: "read", text: "Read complete.", error: false });
    const button = page.getByRole("button", { name: "New messages", exact: true });
    await expect(button).toBeVisible();
    epoch.emit({ kind: "text", text: "Later reply.\n\n".repeat(40) }, END);
    await expect(page.getByRole("status")).toHaveText("Ready");
    await button.click();
    const bounds = await page.locator("details.brief.tools").boundingBox();
    const header = await page.locator("header").boundingBox();
    expect(bounds!.y, "A late tool result jumps to its own brief across a later spawn.").toBeGreaterThanOrEqual(header!.height);
    expect(bounds!.y).toBeLessThan(header!.height + 20);
  } });
}

async function agentFollowing(browser: Browser) {
  const engine = new FakeEngine((epoch, message) => {
    if (!epoch.options.agents) { epoch.emit({ kind: "delta", text: "Agent paragraph.\n\n".repeat(50) }); return; }
    if (message.from === "membr") { epoch.emit(END); return; }
    const tasks = [{ name: "reader", task: "Read the history." }];
    epoch.emit({ kind: "tool", id: "spawn", name: "mcp__memory__spawn", input: { tasks } });
    epoch.emit({ kind: "echo", id: "spawn", text: epoch.options.agents.spawn(tasks), error: false }, END);
  });
  await withChat({ browser, engine, check: async (context, url) => {
    const page = await openChat(context, url);
    await send(page, "Start a reader.");
    await page.locator("details.brief.spawn > summary").click();
    await page.getByRole("button", { name: "Open reader's chat", exact: true }).click();
    await expect(page.getByLabel("Live agent reply", { exact: true })).toContainText("Agent paragraph.");
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    const agent = engine.epochs.find((epoch) => !epoch.options.agents)!;
    agent.emit({ kind: "delta", text: "More agent details.\n\n".repeat(20) });
    await expect(page.getByLabel("Live agent reply", { exact: true })).toContainText("More agent details.");
    await expect.poll(() => gap(page), { message: "The selected agent log still follows new text." }).toBeLessThanOrEqual(2);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, -650);
    await expect.poll(() => gap(page)).toBeGreaterThan(500);
    agent.emit({ kind: "delta", text: "Unread agent text.\n\n".repeat(20) });
    await expect(page.getByRole("button", { name: "New messages", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "← Main chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "New messages", exact: true })).toHaveCount(0);
  } });
}

const browser = await chromium.launch();
try {
  await following(browser);
  console.log("PASS Streaming, diagram rendering, and footer growth follow the document bottom.");
  await reading(browser);
  console.log("PASS Reading stays in place, and New messages opens the first unseen reply after finalization.");
  await agentFollowing(browser);
  console.log("PASS Agent logs follow new text without sharing unseen targets with the main chat.");
  await briefTarget(browser);
  console.log("PASS An unseen tool result opens its grouped brief.");
} finally { await browser.close(); }
