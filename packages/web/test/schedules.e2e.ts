import { chromium, expect, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

const dir = mkdtempSync(path.join(tmpdir(), "membr-schedules-browser-"));
const shots = process.env.MEMBR_SHOTS;
const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Done." }, END));
engine.onWhen = async (text) => text.includes("friday")
  ? { when: { kind: "once", at: "2026-11-13T17:00:00.000Z" }, phrase: "friday 17:00" }
  : { when: { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" }, phrase: "every weekday 8:30" };
let hub: ReturnType<typeof serveHub> | undefined;
let browser: Browser | undefined;
try {
  hub = serveHub({ dir, port: 0, engine });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 800 }, colorScheme: "light", timezoneId: "Europe/London" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(hub.server.url.href + "#schedules");
  await expect(page.getByRole("status").first()).toHaveText("Ready");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Schedules" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No schedules yet.")).toBeVisible();

  const field = page.getByRole("textbox", { name: "When and what" });
  await field.fill("every weekday 8:30 read the inbox notes");
  await page.getByRole("combobox", { name: "Run as" }).selectOption("turn");
  await page.getByRole("combobox", { name: "If missed" }).selectOption("skip");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const first = page.getByRole("article").filter({ hasText: "read the inbox notes" });
  await expect(first).toContainText('cron "30 8 * * 1-5" Europe/London');
  await expect(first).toContainText("active");
  await expect(first).toContainText("turn");
  expect(engine.whens[0].zone).toBe("Europe/London");
  const info = page.getByRole("region", { name: "Command information" });
  await expect(info).toContainText(/Next: \w{3} 08:30, \w{3} 08:30, \w{3} 08:30\./);
  await info.getByRole("button", { name: "Close command information" }).click();

  // The composer saves at once too, and says what membr read.
  await page.goto(hub.server.url.href + "#chat");
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("/schedule friday 17:00 send the invoice");
  await box.press("Enter");
  await expect(page.getByRole("region", { name: "Command information" })).toContainText("Scheduled once");

  await page.getByRole("link", { name: "Schedules" }).click();
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  const invoice = cards.filter({ hasText: "send the invoice" });
  await invoice.getByRole("button", { name: "Pause" }).click();
  await expect(invoice).toContainText("paused");
  await invoice.getByRole("button", { name: "Resume" }).click();
  await expect(invoice).toContainText("active");

  await invoice.getByRole("button", { name: "Delete" }).click();
  await expect(cards).toHaveCount(1);

  engine.epochs[0].options.schedules!.create({ text: "send the invoice", when: { kind: "once", at: "2026-11-13T17:00:00.000Z" }, run: "turn", missed: "once" });
  await expect(cards).toHaveCount(2);
  const added = cards.filter({ hasText: "set by membr" });
  await expect(added).toContainText("active");
  if (shots) await page.screenshot({ path: path.join(shots, "schedules-page.png") });
  await added.getByRole("button", { name: "Delete" }).click();
  await expect(cards).toHaveCount(1);
  expect(errors).toEqual([]);
  await page.close();
  console.log("PASS The Schedules page adds, pauses, resumes and deletes schedules, the composer adds one at once, and the agent's schedule is active at once.");
} finally {
  await browser?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
}
