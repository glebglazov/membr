import { expect, test } from "bun:test";
import path from "node:path";

test("the web renderer builds for the browser", async () => {
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "src/main.ts")], target: "browser" });
  expect(build.logs).toEqual([]);
  expect(build.success).toBe(true);
});
