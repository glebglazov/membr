import { chromium, expect, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { Log } from "../../server/src/log.ts";
import { PAGE } from "../../server/src/view.ts";
import { defaultStore } from "../../server/test/config.ts";
import { FakeEngine } from "../../server/test/engine.ts";

const COUNT = 230;
const name = (i: number) => `Message ${String(i).padStart(4, "0")} ` + "word ".repeat(20);
const dir = mkdtempSync(path.join(tmpdir(), "membr-lazy-browser-"));
const log = new Log(defaultStore(dir));
for (let i = 0; i < COUNT; i++) log.append(i % 2 ? "unii" : "user", name(i));
let hub: ReturnType<typeof serveHub> | undefined;
let browser: Browser | undefined;
try {
  hub = serveHub({ dir, port: 0, engine: new FakeEngine(() => {}) });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(hub.server.url.href);
  await expect(page.getByRole("status")).toHaveText("Ready");
  const chat = page.getByRole("main", { name: "Chat", exact: true });
  const messages = chat.locator("article[data-entry]");
  await expect(chat).toContainText(`Message ${COUNT - 1}`.replace(" ", " 0"));
  expect(await messages.count(), "Only the latest page renders on load.").toBe(PAGE);
  await expect(chat).not.toContainText("Message 0000");
  const first = `Message ${String(COUNT - PAGE).padStart(4, "0")}`;
  const top = () => chat.locator("article[data-entry]", { hasText: first }).evaluate((node) => node.getBoundingClientRect().top);

  await page.evaluate(() => document.querySelector(".scroller")!.scrollTo(0, 0));
  const before = await top();
  await expect.poll(() => messages.count(), { message: "Scrolling to the top loads an older page." }).toBeGreaterThan(PAGE);
  await page.waitForTimeout(300);
  const after = await top();
  expect(Math.abs(after - before), `The message that was at the top stays put (${before} to ${after}).`).toBeLessThan(4);
  await expect(page.getByRole("button", { name: "New messages" })).toHaveCount(0);

  await expect.poll(async () => { await page.evaluate(() => document.querySelector(".scroller")!.scrollTo(0, 0)); return await chat.getByText("Message 0000").count(); }, { message: "The first message is reachable.", timeout: 20_000 }).toBe(1);
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  expect(await messages.count(), "Every message renders once.").toBe(COUNT);
  expect(errors).toEqual([]);
  console.log("PASS Only the latest page loads, older pages load at the top without a jump, and the first message is reachable.");
} finally {
  await browser?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
}
