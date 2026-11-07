import fs from "node:fs";
import path from "node:path";
import { replaceFile } from "./durable.ts";
import { dlopen, read } from "bun:ffi";

function systemLock() {
  const flock = { args: ["i32", "i32"], returns: "i32" } as const;
  if (process.platform === "darwin") return dlopen("/usr/lib/libSystem.B.dylib", { flock, __error: { args: [], returns: "ptr" } });
  const symbols = { flock, __errno_location: { args: [], returns: "ptr" } } as const;
  try { return dlopen("libc.so.6", symbols); }
  catch { return dlopen("libc.so", symbols); }
}
const native = systemLock();
const errno = "__error" in native.symbols ? native.symbols.__error : native.symbols.__errno_location;
const LOCK_EX = 2;
const LOCK_NB = 4;

// url is empty while the server starts, and tailnet is set when tailscale serve forwards to it.
export type Holder = { pid: number; url: string; tailnet?: string };

export type Lock = { update(): void; release(): void };

export type Taken = { lock: Lock } | { heldBy: Holder };

export async function lock(dir: string, holder: () => Holder): Promise<Taken> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "lock");
  // All contenders must lock the same inode, so this file stays after release.
  const guard = fs.openSync(path.join(dir, "lock.guard"), "a", 0o600);
  try {
    while (native.symbols.flock(guard, LOCK_EX | LOCK_NB) !== 0) {
      const pointer = errno();
      if (pointer === null) throw new Error("The system did not return errno");
      const code = read.i32(pointer);
      if (code !== 4 && code !== (process.platform === "darwin" ? 35 : 11)) throw new Error(`Cannot lock ${dir}: errno ${code}`);
      const heldBy = owner(file);
      if (heldBy) {
        fs.closeSync(guard);
        return { heldBy };
      }
      await Bun.sleep(10);
    }
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSocket()) {
      throw new Error(`Legacy socket lock at ${file}. Stop the old server and remove this socket before starting membr.`);
    }
    const update = () => replaceFile(file, JSON.stringify(holder()));
    update();
    return { lock: {
      update,
      release() {
        try { fs.rmSync(file, { force: true }); }
        finally { fs.closeSync(guard); }
      },
    } };
  } catch (error) {
    fs.closeSync(guard);
    throw error;
  }
}

// The live server of a base directory, read without taking the lock.
export function holder(dir: string): Holder | null {
  return owner(path.join(dir, "lock"));
}

function owner(file: string): Holder | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.url !== "string" || (value.tailnet !== undefined && typeof value.tailnet !== "string")) throw new Error(`Invalid lock holder in ${file}`);
    process.kill(value.pid, 0);
    return value;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return null;
    throw error;
  }
}
