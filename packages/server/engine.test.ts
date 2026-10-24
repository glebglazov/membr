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
