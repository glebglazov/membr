import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DISALLOWED_TOOLS, scheduleTool } from "./src/engine.ts";
import type { ScheduleTools } from "./src/schedules.ts";

test("every scheduling tool the SDK declares is disallowed", () => {
  const sdk = path.dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
  const declared = [...fs.readFileSync(path.join(sdk, "sdk-tools.d.ts"), "utf8").matchAll(/^export interface (\w+)Input\b/gm)].map((match) => match[1]!);
  const scheduling = declared.filter((name) => /^(Cron|Schedule|RemoteTrigger)/.test(name));
  expect(scheduling).toContain("CronCreate");
  expect(DISALLOWED_TOOLS).toEqual(expect.arrayContaining(scheduling));
});

function tools(): ScheduleTools & { specs: unknown[] } {
  const specs: unknown[] = [];
  return { specs, create: (spec) => { specs.push(spec); return "Proposed schedule abc123."; }, list: () => "No schedules.", cancel: (id) => `Cancelled schedule ${id}.` };
}
type Tool = ReturnType<typeof scheduleTool>;
type Input = Partial<Parameters<Tool["handler"]>[0]> & { action: "create" | "list" | "cancel" };
async function call(tool: Tool, input: Input) {
  const result = await tool.handler({ text: undefined, when: undefined, run: undefined, missed: undefined, id: undefined, ...input }, {});
  const first = result.content[0];
  return { text: first?.type === "text" ? first.text : undefined, isError: result.isError === true };
}

test("the schedule tool defaults run to agent and missed to once", async () => {
  const fake = tools();
  const tool = scheduleTool(fake);
  const when = { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" } as const;
  expect(z.object(tool.inputSchema).safeParse({ action: "create", text: "Read the inbox.", when }).success).toBe(true);
  expect((await call(tool, { action: "create", text: "Read the inbox.", when })).text).toBe("Proposed schedule abc123.");
  expect(fake.specs).toEqual([{ text: "Read the inbox.", when, run: "agent", missed: "once" }]);
});

test("the schedule tool refuses a cron with no zone, and a create with no text or when, as text the model can read", async () => {
  const fake = tools();
  const tool = scheduleTool(fake);
  expect(z.object(tool.inputSchema).safeParse({ action: "create", text: "x", when: { kind: "cron", expr: "0 * * * *" } }).success).toBe(false);
  for (const input of [{ action: "create", when: { kind: "once", at: "2026-11-09T09:00:00.000Z" } }, { action: "create", text: "x" }, { action: "cancel" }] as const) {
    const result = await call(tool, input);
    expect(result.isError).toBe(true);
    expect(result.text).toBeTruthy();
  }
  expect(fake.specs).toEqual([]);
  expect((await call(tool, { action: "cancel", id: "abc123" })).text).toBe("Cancelled schedule abc123.");
});
