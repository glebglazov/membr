// every client takes the protocol as is, so it has no runtime dependencies
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
