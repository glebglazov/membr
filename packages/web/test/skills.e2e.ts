import { chromium, expect, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

const dir = mkdtempSync(path.join(tmpdir(), "membr-skills-browser-"));
const shots = process.env.MEMBR_SHOTS;
const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Done." }, END));
engine.skills = [
  { name: "probe-echo", description: "Echo the arguments back to the user", argumentHint: "<text>" },
  { name: "review", description: "Review the current change for bugs and style problems before it is merged", argumentHint: "" },
  { name: "goal", description: "A skill that membr's own /goal command hides", argumentHint: "" },
];
let hub: ReturnType<typeof serveHub> | undefined;
let browser: Browser | undefined;
try {
  hub = serveHub({ dir, port: 0, engine });
  browser = await chromium.launch();
  for (const scheme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, colorScheme: scheme });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(hub.server.url.href);
    await expect(page.getByRole("status")).toHaveText("Ready");
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    const menu = page.getByRole("listbox", { name: "Commands" });
    await box.click();
    await box.pressSequentially("/");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: /^\/probe-echo/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /^\/goal/ })).toHaveCount(1);
    const fits = await menu.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0; });
    expect(fits, "The menu fits the 390 px viewport.").toBe(true);
    if (shots) await page.screenshot({ path: path.join(shots, `skills-${scheme}.png`) });
    await box.pressSequentially("pro");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await box.press("Tab");
    await expect(menu).toBeHidden();
    await expect(box).toHaveValue("/probe-echo ");
    await box.pressSequentially(`banana-${scheme}`);
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("article.message.user").last()).toHaveText(new RegExp(`You\\s*/probe-echo banana-${scheme}`));
    await expect(page.getByRole("status")).toHaveText("Ready");
    expect(engine.epochs[0].messages.at(-1)?.text).toBe(`/probe-echo banana-${scheme}`);

    await box.fill("");
    await box.pressSequentially("/re");
    await expect(menu).toBeVisible();
    await box.press("Escape");
    await expect(menu).toBeHidden();
    await box.fill("");
    await box.pressSequentially("/");
    await box.press("ArrowDown");
    await expect(menu.getByRole("option", { selected: true })).toContainText("/halt");
    await menu.getByRole("option", { name: /^\/review/ }).click();
    await expect(box).toHaveValue("/review ");
    await box.fill("");
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log("PASS The composer offers skills for / and completes with Tab, click and arrows in light and dark.");
} finally {
  await browser?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
}
