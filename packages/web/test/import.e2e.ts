import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-import-browser-"));
const folder = path.join(dir, "projects"); fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, "session.jsonl"), Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", uuid: `m-${i}`, sessionId: "browser", timestamp: "2026-10-01T12:00:00Z", cwd: "/project", message: { content: `Past message ${i} ` + "x".repeat(700) } })).join("\n") + "\n");
let release!: () => void;
const held = new Promise<void>((resolve) => { release = resolve; });
class Engine extends FakeEngine {
  calls = 0;
  override async compact() { this.calls++; await held; return "Past session summary."; }
}
const engine = new Engine((epoch) => epoch.emit({ kind: "text", text: "The live turn finished." }, END));
const hub = serveHub({ dir: path.join(dir, "memory"), port: 0, engine });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(hub.server.url.href);
  await expect(page.getByRole("status")).toHaveText("Ready");
  await page.getByText("Import past sessions", { exact: true }).click();
  await page.getByLabel("Session folder", { exact: true }).setInputFiles(folder);
  await expect(page.getByLabel("Import estimate")).toContainText("20 new messages");
  await expect(page.getByLabel("Import estimate")).toContainText("compaction calls");
  expect(engine.calls).toBe(0);
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause import", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume import", exact: true })).toBeVisible();
  const calls = engine.calls; release();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Answer during import.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("main", { name: "Chat", exact: true })).toContainText("The live turn finished.");
  expect(engine.calls).toBe(calls);
  const second = await context.newPage(); await second.goto(hub.server.url.href);
  await second.getByText("Import past sessions", { exact: true }).click();
  await expect(second.getByRole("button", { name: "Resume import", exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Resume import", exact: true }).click();
  await expect(page.getByText(/20 messages, complete/)).toBeVisible();
  await expect(second.getByText(/20 messages, complete/)).toBeVisible();
  await page.getByLabel("Session folder", { exact: true }).setInputFiles(folder);
  await expect(page.getByLabel("Import estimate")).toContainText("0 new messages");
  await expect(page.getByRole("button", { name: "Start import", exact: true })).toBeDisabled();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  for (const [index, [source, fixture]] of [
    ["claude.ai", "claude-ai"],
    ["chatgpt", "chatgpt"],
  ].entries()) {
    await page.getByLabel("Session source", { exact: true }).selectOption(source);
    const fixtures = path.join(import.meta.dir, "../../server/test/fixtures");
    await page.getByLabel("Website export", { exact: true }).setInputFiles(path.join(fixtures, fixture + ".zip"));
    await expect(page.getByLabel("Import estimate")).toContainText("4 new messages");
    await page.getByRole("button", { name: "Start import", exact: true }).click();
    await expect(page.getByText(/4 messages, complete/)).toHaveCount(index + 1);
    await page.getByLabel("Website export", { exact: true }).setInputFiles(path.join(fixtures, fixture + ".json"));
    await expect(page.getByLabel("Import estimate")).toContainText("0 new messages");
    await expect(page.getByRole("button", { name: "Start import", exact: true })).toBeDisabled();
  }
  await page.getByLabel("Website export", { exact: true }).setInputFiles(path.join(import.meta.dir, "../../server/test/fixtures/chatgpt-zip64.zip"));
  await expect(page.getByLabel("Import estimate")).toContainText("0 new messages");
  const validZip = fs.readFileSync(path.join(import.meta.dir, "../../server/test/fixtures/chatgpt.zip"));
  const directory = validZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const unsupported = Buffer.from(validZip); unsupported.writeUInt16LE(99, directory + 10);
  const encrypted = Buffer.from(validZip); encrypted.writeUInt16LE(1, directory + 8);
  const tooLarge = Buffer.from(validZip); tooLarge.writeUInt32LE(33 * 2 ** 20, directory + 24);
  const missing = Buffer.from(validZip.toString("latin1").replaceAll("conversations.json", "conversationx.json"), "latin1");
  for (const [buffer, reason] of [
    [unsupported, "compression method is not supported"],
    [encrypted, "Encrypted ZIP files are not supported"],
    [tooLarge, "32 MB of conversations JSON"],
    [missing, "No conversations.json"],
  ] as const) {
    await page.getByLabel("Website export", { exact: true }).setInputFiles({ name: "invalid.zip", mimeType: "application/zip", buffer });
    await expect(page.getByRole("alert").filter({ hasText: reason })).toBeVisible();
  }
  await page.getByLabel("Website export", { exact: true }).setInputFiles({ name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("PK broken ZIP") });
  await expect(page.getByRole("alert")).toContainText("ZIP file has no end record");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log("PASS folder picker, estimate before calls, import, pause, live turn, reconnect, shared resume, duplicate estimate, website ZIP/JSON imports, invalid ZIP, light/dark phone layout");
} finally {
  release(); await browser.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true });
}
