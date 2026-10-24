// rule C3: the client core imports no DOM and no terminal code. Imports are
// held to an allow list, so a terminal module of any name fails; DOM globals
// are caught by compiling the core with no DOM lib and no ambient types.
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const CORE = import.meta.dir;
const TSC = Bun.resolveSync("typescript/bin/tsc", CORE);
const ALLOWED = (spec: string) => spec.startsWith(".") || spec === "@membr/protocol";

// `project` holds a tsconfig.json like the core's, with its code in src/
async function violations(project: string): Promise<string[]> {
  const found: string[] = [];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(project)) {
    for (const { path: spec } of transpiler.scanImports(fs.readFileSync(path.join(project, file), "utf8"))) {
      if (!ALLOWED(spec)) {
        found.push(`${file} imports ${spec}`);
      }
    }
  }
  const tsc = Bun.spawnSync([TSC, "-p", project], { stdout: "pipe", stderr: "pipe" });
  if (tsc.exitCode !== 0) {
    found.push(tsc.stdout.toString() + tsc.stderr.toString());
  }
  return found;
}

// a core-like project inside the core package, so it resolves the workspace
// packages the same way the core does
const fixtures: string[] = [];
function fixture(source: string): string {
  const dir = fs.mkdtempSync(path.join(CORE, ".boundary-"));
  fixtures.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json", include: ["src"] }));
  fs.writeFileSync(path.join(dir, "src", "model.ts"), source);
  return dir;
}

afterAll(() => {
  for (const dir of fixtures) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the client core imports no DOM and no terminal code", async () => {
  expect(await violations(CORE)).toEqual([]);
});

test("the core may import the protocol", async () => {
  expect(await violations(fixture(`import type {} from "@membr/protocol";\nexport {};\n`))).toEqual([]);
});

test("a DOM global fails the check", async () => {
  const found = await violations(fixture(`export const title = () => document.title;\n`));
  expect(found.join("\n")).toContain("Cannot find name 'document'");
});

test("a terminal module fails the check", async () => {
  for (const mod of ["node:readline", "node:tty", "ink"]) {
    expect(await violations(fixture(`import * as term from "${mod}";\nexport { term };\n`))).toContain(`src/model.ts imports ${mod}`);
  }
});
