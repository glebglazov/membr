import { chromium, expect, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

const dir = mkdtempSync(path.join(tmpdir(), "membr-notebook-browser-"));
const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Done." }, END));
let hub: ReturnType<typeof serveHub> | undefined;
let browser: Browser | undefined;
try {
  hub = serveHub({ dir, port: 0, engine });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 800 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(hub.server.url.href + "#notebook");
  await expect(page.getByRole("status").first()).toHaveText("Ready");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Notebook" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("The notebook is empty.")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  const field = page.getByRole("textbox", { name: "Notebook text" });
  const size = page.getByRole("status", { name: "Notebook size" });
  await field.fill("# Notes\n- Editor: vim");
  await expect(size).toHaveText("21 / 8192");
  await field.fill("x".repeat(8193));
  await expect(size).toHaveText("8193 / 8192");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await field.fill("# Notes\n- Editor: vim");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(page.getByText("changed by you")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await field.fill("# Notes\n- Editor: vim\n- Shell: fish");
  engine.epochs[0].options.notebook!.edit([{ old: "vim", new: "helix" }]);
  const newer = page.getByRole("region", { name: "Newer notebook" });
  await expect(newer).toContainText("- Editor: helix");
  await expect(field).toHaveValue("# Notes\n- Editor: vim\n- Shell: fish");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Shell: fish")).toBeVisible();
  await expect(page.getByText("Revision 3")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(field).toHaveCount(0);
  const download = await page.request.get(hub.server.url.href + "notebook.md");
  expect(await download.text()).toBe("# Notes\n- Editor: vim\n- Shell: fish");
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute("href", "notebook.md");
  expect(errors).toEqual([]);
  await page.close();
  console.log("PASS The Notebook page renders, edits with a byte counter, refuses over the cap, shows a newer revision beside the draft, and downloads markdown.");
} finally {
  await browser?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
}
