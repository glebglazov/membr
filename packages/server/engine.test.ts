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
