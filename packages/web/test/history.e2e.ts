import { chromium, expect, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveHub } from "../../server/src/hub.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";

const dir = mkdtempSync(path.join(tmpdir(), "membr-history-browser-"));
const answer = "The full reply stays in the chat. " + "More detail. ".repeat(60);
const engine = new FakeEngine((epoch, message) => epoch.emit({ kind: "text", text: message.text === "First turn" ? answer : "Second reply." }, END));
let hub: ReturnType<typeof serveHub> | undefined;
let browser: Browser | undefined;
try {
  hub = serveHub({ dir, port: 0, engine });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(hub.server.url.href);
  await expect(page.getByRole("status")).toHaveText("Ready");
  const chat = page.getByRole("main", { name: "Chat", exact: true });
  for (const text of ["First turn", "Second turn"]) {
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat).toContainText(text === "First turn" ? answer : "Second reply.");
    await expect(page.getByRole("status")).toHaveText("Ready");
  }
  await expect(chat, "Starting another turn must retain the earlier full reply.").toContainText(answer);
  await expect(chat).not.toContainText("not summarized yet");
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Ready");
  await expect(chat, "Reload must retain the earlier full reply.").toContainText(answer);
  await expect(chat).not.toContainText("not summarized yet");
  expect(errors).toEqual([]);
  console.log("PASS A long reply stays whole after the next turn and reload.");
} finally {
  await browser?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
}
