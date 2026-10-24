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

test("main MCP registers spawn and tell while child input stays synthetic", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test/engine-agents-wire.ts")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const wire = JSON.parse(stdout);
  expect(wire.calls[0].tools.slice(2)).toEqual([
    { name: "spawn", description: "Start one subagent per task, in parallel, and return their names at once. Each one's report reaches you as a message \"[Name] report\" when it finishes. A subagent sees the view and the user's instructions, but knows what you want only from its task." },
    { name: "tell", description: "Send a message to an agent (a subagent or a computer task), by name. One at work reads it between its tool calls, and its report answers it; an idle one goes on from its chat, and its reply reaches you as a message \"[Name] reply\"." },
  ]);
  expect(wire.calls[0].allowed).toEqual(["mcp__memory__zoom", "mcp__memory__date", "mcp__memory__spawn", "mcp__memory__tell"]);
  expect(wire.calls[1].tools.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date"]);
  expect(wire.delegated).toEqual([{ tasks: ["Task"], effort: "high" }, { name: "Agent1", message: "More" }]);
  expect(wire.answers).toEqual([{ content: [{ type: "text", text: "Started Agent1." }] }, { content: [{ type: "text", text: "Sent." }] }]);
  expect(wire.calls[1].messages.map((message: { isSynthetic: boolean; message: { content: string } }) => [message.isSynthetic, message.message.content])).toEqual([
    [true, "[membr]\nview and saved agent chat"], [true, "[membr]\nAgent task"], [true, "[membr]\nAgent correction"],
  ]);
});

test("the Engine sends text and image-only inputs as SDK image blocks", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test/engine-images-wire.ts")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const messages = JSON.parse(stdout);
  expect(messages[1].message.content).toEqual([
    { type: "text", text: "Look" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "cGljdHVyZQ==" } },
  ]);
  expect(messages[2].message.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
  ]);
  expect(messages.slice(1).every((message: { isSynthetic: boolean }) => !message.isSynthetic)).toBe(true);
});
