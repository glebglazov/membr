import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { readConfig, storeDir } from "./config.ts";
import { holder, lock } from "./lock.ts";
import { Log } from "./log.ts";

// An archive is a .tar.gz of the base directory's config.json and agents/, made and read by the system tar.
// A path inside it is relative to the base directory.

const ARCHIVE_ROUTE = "membr/membr.tar.gz";

// Each rule names files an archive leaves out. A rule about a name does not apply inside an agent's home: that is the user's own tree.
type Rule = Readonly<{ why: string; matches(parts: string[], inHome: boolean): boolean }>;
const named = (test: (name: string) => boolean) => (parts: string[], inHome: boolean) => !inHome && test(parts.at(-1)!);
const LEFT_OUT: readonly Rule[] = [
  { why: "the token is a credential, and lock, lock.guard and serve.log are the state of one process on one computer",
    matches: ([first]) => first !== "config.json" && first !== "agents" },
  { why: "a copy must get its own machine id, so that two live copies never write the same (machine, seq) pair",
    matches: named((name) => name === "machine") },
  { why: "epochs.json names Claude Code sessions that exist only on the old computer",
    matches: named((name) => name === "epochs.json") },
  { why: "watches.pids names processes of the old computer",
    matches: named((name) => name === "watches.pids") },
  { why: "a temporary file is half of a write that has not finished",
    matches: named((name) => name.endsWith(".tmp")) },
  { why: "a legacy index is rebuilt from the journal",
    matches: named((name) => name.endsWith(".index")) },
];

function kept(relative: string): boolean {
  const parts = relative.split(path.sep).filter(Boolean);
  const inHome = parts[0] === "agents" && parts[2] === "home";
  return !LEFT_OUT.some((rule) => parts.length > 0 && rule.matches(parts, inHome));
}

// Every store write of a server is synchronous, so no write lands during this call: the copy is one moment of the store.
export function snapshot(dir: string, into: string): void {
  fs.cpSync(dir, into, { recursive: true, verbatimSymlinks: true, filter: (source) => kept(path.relative(dir, source)) });
}

async function tar(args: string[]): Promise<void> {
  // COPYFILE_DISABLE stops bsdtar on macOS from adding ._ files for extended attributes.
  const proc = Bun.spawn(["tar", ...args], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "ignore", stderr: "pipe" });
  const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tar failed: ${error.trim()}`);
}

async function pack(staging: string, archive: string): Promise<void> {
  const names = fs.readdirSync(staging);
  if (names.length === 0) throw new Error("there is nothing to export: no config.json and no agents");
  await tar(["-czf", archive, "-C", staging, ...names]);
}

// What the hub answers on /membr/membr.tar.gz. The snapshot is taken before the first await.
export async function archiveResponse(dir: string): Promise<Response> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "membr-archive-"));
  const archive = path.join(work, "membr.tar.gz");
  try {
    snapshot(dir, path.join(work, "stage"));
    await pack(path.join(work, "stage"), archive);
    // An open file survives its unlink, so nothing is left behind however the download ends.
    const fd = fs.openSync(archive, "r");
    const size = fs.fstatSync(fd).size;
    fs.rmSync(work, { recursive: true, force: true });
    return new Response(Readable.toWeb(fs.createReadStream("", { fd })) as unknown as ReadableStream, {
      headers: { "Content-Type": "application/gzip", "Content-Length": String(size), "Cache-Control": "no-store" },
    });
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

async function download(url: string, token: string, into: string): Promise<void> {
  const response = await fetch(new URL(ARCHIVE_ROUTE, url), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`the server at ${url} refused the export: ${response.status} ${(await response.text()).trim()}`);
  await Bun.write(into, response);
}

async function snapshotWithoutServer(dir: string, into: string): Promise<void> {
  const taken = await lock(dir, () => ({ pid: process.pid, url: "" }));
  if ("heldBy" in taken) throw new Error(`a membr server took ${dir} (pid ${taken.heldBy.pid}). Run membr export again.`);
  try { snapshot(dir, into); } finally { taken.lock.release(); }
}

export async function exportArchive(dir: string, file: string): Promise<string[]> {
  if (!fs.existsSync(dir)) throw new Error(`no membr installation in ${dir}`);
  const target = path.resolve(file);
  if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new Error(`${target} exists already. Name a new file.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "membr-export-"));
  const partial = target + ".tmp";
  try {
    const running = holder(dir);
    if (running?.url) {
      await download(running.url, fs.readFileSync(path.join(dir, "token"), "utf8").trim(), partial);
    } else {
      await snapshotWithoutServer(dir, path.join(work, "stage"));
      await pack(path.join(work, "stage"), partial);
    }
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return [`membr: exported ${dir} to ${target}`, "membr: it holds config.json and the agents, with no token and no machine id"];
}

// Proves that the extracted tree is a store a server can open. Opening a log makes the machine file of this computer.
function check(extracted: string): number {
  const agents = path.join(extracted, "agents");
  const hasAgents = fs.statSync(agents, { throwIfNoEntry: false })?.isDirectory() ?? false;
  if (!hasAgents && !fs.existsSync(path.join(extracted, "config.json"))) throw new Error("it has no config.json and no agents/");
  const names = hasAgents ? fs.readdirSync(agents, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  for (const name of names) new Log(storeDir(extracted, name));
  return names.length;
}

export async function importArchive(dir: string, file: string): Promise<string[]> {
  const target = path.resolve(dir);
  if (holder(target)) throw new Error(`a membr server holds ${target}. Stop it with membr server stop first.`);
  const present = fs.statSync(target, { throwIfNoEntry: false });
  if (present && (!present.isDirectory() || fs.readdirSync(target).length > 0)) throw new Error(`${target} is not empty. membr import needs a new or empty base directory.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Beside the target, so that the final rename stays on one filesystem.
  const extracted = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}-import-`));
  let agents: number;
  try {
    try { await tar(["-xzf", path.resolve(file), "-C", extracted]); }
    catch (error) { throw new Error(`${file} is not a membr archive: ${error instanceof Error ? error.message : error}`); }
    try { agents = check(extracted); }
    catch (error) { throw new Error(`${file} is not a membr archive: ${error instanceof Error ? error.message : error}`); }
    if (present) fs.rmdirSync(target);
    fs.renameSync(extracted, target);
  } catch (error) {
    fs.rmSync(extracted, { recursive: true, force: true });
    throw error;
  }
  const lines = [`membr: imported ${file} into ${target} (${agents} ${agents === 1 ? "agent" : "agents"})`];
  try { readConfig(target); }
  catch (error) { lines.push(`membr: ${error instanceof Error ? error.message : error}`, "membr: fix config.json before membr starts the server"); }
  lines.push("membr: this computer gets its own token and machine ids, so the sign-in link changes. membr server status prints the new one.");
  return lines;
}
