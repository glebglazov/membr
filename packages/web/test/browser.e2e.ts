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
      const context = await options.browser.newContext({ viewport: { width: 1200, height: 900 } });
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
  { width: 1200, height: 900, colorScheme: "light", background: "rgb(255, 255, 255)" },
  { width: 1200, height: 900, colorScheme: "dark", background: "rgb(23, 23, 25)" },
  { width: 390, height: 844, colorScheme: "light", background: "rgb(255, 255, 255)" },
  { width: 390, height: 844, colorScheme: "dark", background: "rgb(23, 23, 25)" },
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

let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  await sameTurn(browser);
  console.log("PASS Two tabs show the same live and completed turn.");
  await sharedApproval(browser);
  console.log("PASS An approval answer closes the card in both tabs.");
  await responsiveLayout(browser);
  console.log("PASS Light and dark layouts fit desktop and 390 px widths.");
  console.log("3 browser checks passed.");
} finally {
  await browser?.close();
}
