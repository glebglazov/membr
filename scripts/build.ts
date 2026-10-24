import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const webDir = path.join(root, "packages/web/dist");
const output = path.join(root, "dist/membr");
const embeddedWeb = Object.fromEntries(await Promise.all(
  (await readdir(webDir)).map(async (name) => [
    name === "index.html" ? "/" : "/" + name,
    await readFile(path.join(webDir, name), "utf8"),
  ]),
));

await mkdir(path.dirname(output), { recursive: true });
const build = Bun.spawn([
  process.execPath,
  "build",
  "--compile",
  "--minify",
  `--define=EMBEDDED_WEB=${JSON.stringify(embeddedWeb)}`,
  "--define=MEMBR_STANDALONE=true",
  path.join(root, "packages/server/src/main.ts"),
  `--outfile=${output}`,
], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) throw new Error("membr did not build");
console.log(`Built ${output}`);
