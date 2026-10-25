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
// The web assets go in as a define in this process: on the command line they outgrow the argument limit.
const build = await Bun.build({
  entrypoints: [path.join(root, "packages/server/src/main.ts")],
  target: "bun",
  minify: true,
  compile: { outfile: output },
  define: { EMBEDDED_WEB: JSON.stringify(embeddedWeb), MEMBR_STANDALONE: "true" },
});
if (!build.success) throw new AggregateError(build.logs, "membr did not build");
console.log(`Built ${output}`);
