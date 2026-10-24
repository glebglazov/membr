// the Engine is the only module that imports the Agent SDK, so a fake Engine
// can stand in for Claude Code everywhere else
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "../..");
const SDK = "@anthropic-ai/claude-agent-sdk";

test("only the Engine imports the Agent SDK", () => {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const importers: string[] = [];
  for (const file of new Bun.Glob("packages/*/**/*.{ts,tsx}").scanSync(ROOT)) {
    if (file.includes("node_modules")) {
      continue;
    }
    // a shebang line is not TypeScript, and scanImports rejects it
    const imports = transpiler.scanImports(fs.readFileSync(path.join(ROOT, file), "utf8").replace(/^#!.*/, ""));
    if (imports.some(({ path: spec }) => spec === SDK || spec.startsWith(SDK + "/"))) {
      importers.push(file);
    }
  }
  expect(importers).toEqual(["packages/server/src/engine.ts"]);
});

test("every injected SDK message is synthetic and prefixed while typed user text stays plain", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test/engine-wire.ts")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const wire = JSON.parse(stdout);
  expect(wire.calls[0].permissionMode).toBe("auto");
  expect(wire.permission).toEqual({ behavior: "allow", updatedInput: { command: "echo hello" } });
  expect(wire.signalPassed).toBe(true);
  const messages = wire.calls.flatMap((call: { messages: unknown[] }) => call.messages);
  expect(messages.map((message: { isSynthetic: boolean; message: { content: string } }) => ({ synthetic: message.isSynthetic, text: message.message.content }))).toEqual([
    { synthetic: true, text: "[membr]\nchat view" },
    { synthetic: true, text: "[membr]\n[Agent] report" },
    { synthetic: true, text: "[membr]\ngoal check" },
    { synthetic: false, text: "The user typed this" },
    { synthetic: true, text: "[membr]\ncompaction input" },
  ]);
});

test("goal checks use one isolated Haiku turn and propagate query failure", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test/engine-goal-wire.ts")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const wire = JSON.parse(stdout);
  expect(wire.met).toBe(true);
  expect(wire.failure).toBe("goal check failed: unavailable");
  expect(wire.calls).toHaveLength(2);
  for (const call of wire.calls) {
    expect(call).toMatchObject({ model: "haiku", tools: [], settingSources: [], persistSession: false, maxTurns: 1, abortController: true });
    expect(call.systemPrompt).toContain("Answer yes if the chat shows the goal fully satisfied now");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].isSynthetic).toBe(true);
    expect(call.messages[0].message.content.startsWith("[membr]\n<chat>")).toBe(true);
  }
  expect(wire.calls[0].messages[0].message.content).toContain("The goal:\n\nFinish the job");
});

test("the Engine registers zoom and date and sends their text, errors and images through MCP", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test/engine-memory-wire.ts")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const wire = JSON.parse(stdout);
  expect(wire.registered).toEqual([
    { name: "zoom", description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. With an agent's name as id, give that agent's whole chat. A long text comes in pages from character at, saying where to go on." },
    { name: "date", description: "The date and time of message id." },
  ]);
  expect(wire.allowed).toEqual(["mcp__memory__zoom", "mcp__memory__date"]);
  expect(wire.answers).toEqual([
    { content: [{ type: "text", text: "3,1,0" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], isError: false },
    { content: [{ type: "text", text: "No line 99+1. Roots: 0+4." }], isError: true },
    { content: [{ type: "text", text: "date 3" }] },
  ]);
});
