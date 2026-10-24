import fs from "node:fs";
import { Log } from "../src/log.ts";
import { Tree } from "../src/tree.ts";
import { Memory } from "../src/memory.ts";
import { FakeEngine } from "./engine.ts";

export async function seedMemory(dir: string, count = 500, secret = "ARCHIVE-PHRASE-731") {
  const log = new Log(dir);
  const entries = Array.from({ length: count }, (_, i) => log.append("user", i === 3 ? `The archive phrase is ${secret}.` : `Historical message ${i}. ` + "An ordinary note about the day's work. ".repeat(3)));
  const tree = new Tree(dir, log, new FakeEngine());
  try {
    await tree.settle(count, AbortSignal.timeout(10000));
    const memory = new Memory(log, tree, dir);
    fs.writeFileSync(dir + "/view.json", JSON.stringify({ lines: memory.roots(), pick: { model: "sonnet", effort: "low", fast: false }, goal: null }));
    return entries;
  } finally { tree.close(); }
}
