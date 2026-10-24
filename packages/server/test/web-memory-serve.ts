import fs from "node:fs";
import { main } from "../src/main.ts";
import { seedMemory } from "./memory.ts";
import { END, FakeEngine } from "./engine.ts";

const dir = process.env.MEMBR_DIR;
if (!dir) throw new Error("MEMBR_DIR must name an empty test directory");
if (!fs.existsSync(dir + "/view.json")) await seedMemory(dir, 8);
await main(new FakeEngine((epoch, message) => epoch.emit({ kind: "text", text: message.text === "long reply" ? "Long final answer. ".repeat(80) : "A new reply." }, END)));
