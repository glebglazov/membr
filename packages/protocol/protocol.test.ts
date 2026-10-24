import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("the protocol has no runtime dependencies", async () => {
  const pkg = await Bun.file(path.join(import.meta.dir, "package.json")).json();
  expect(pkg.dependencies ?? {}).toEqual({});
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(import.meta.dir)) {
    const source = fs.readFileSync(path.join(import.meta.dir, file), "utf8");
    for (const { path: spec } of transpiler.scanImports(source)) {
      expect(spec).toStartWith(".");
    }
  }
});

test("state events parse optional epoch usage and reject invalid counts", async () => {
  const { parseEvent } = await import("./src/index.ts");
  const state = { busy: false, wait: "", goal: null, pick: null, agents: [], usage: null };
  const usage = { input: 100, cacheRead: 700, cacheWrite: 200, output: 50 };
  expect(parseEvent({ type: "state", state })).toEqual({ type: "state", state });
  expect(parseEvent({ type: "state", state: { ...state, epoch: usage } })).toEqual({ type: "state", state: { ...state, epoch: usage } });
  expect(() => parseEvent({ type: "state", state: { ...state, epoch: { ...usage, input: -1 } } })).toThrow("Expected a nonnegative integer");
});
