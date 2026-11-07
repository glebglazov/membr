import { chromium, expect, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";
import { testConfig } from "../../server/test/config.ts";

const dir = mkdtempSync(path.join(tmpdir(), "membr-agents-browser-"));
const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Done." }, END));
let hub: ReturnType<typeof serveHub> | undefined;
let browser: Browser | undefined;
try {
  hub = serveHub({ dir, port: 0, engine, config: () => testConfig(dir, [{ name: "default" }, { name: "research", prompt: "You research papers.\nWrite a summary." }]) });
  const base = hub.server.url.href;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(base + "membr/");
  await expect(page.getByRole("link", { name: "default" })).toBeVisible();
  await expect(page.getByText("You research papers.")).toBeVisible();
  await page.getByRole("link", { name: "research" }).click();
  await expect(page).toHaveURL(base + "membr/research/");
  await expect(page.getByRole("status").first()).toHaveText("Ready");
  await expect(page).toHaveTitle("membr · research");

  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello research");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("main", { name: "Chat", exact: true }).getByText("Done.")).toBeVisible();
  const research = await (await page.request.get(base + "membr/research/export")).json() as { messages: { text: string }[] };
  const fallback = await (await page.request.get(base + "membr/default/export")).json() as { messages: { text: string }[] };
  if (!research.messages.some((entry) => entry.text === "Hello research")) throw new Error("The message did not reach the research agent's store.");
  if (fallback.messages.some((entry) => entry.text === "Hello research")) throw new Error("The message reached the default agent too.");

  const switcher = page.getByRole("combobox", { name: "Agent" });
  await expect(switcher).toHaveValue("research");
  await switcher.selectOption("default");
  await expect(page).toHaveURL(base + "membr/default/");
  await expect(page.getByRole("status").first()).toHaveText("Ready");
  await expect(page.getByText("Hello research")).toHaveCount(0);
  if (errors.length) throw new Error("Page errors: " + errors.join("; "));
  console.log("PASS The agent list opens an agent at /membr/<name>/, its messages stay in its own store, and the switcher moves to another agent.");
} finally {
  await browser?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
}
