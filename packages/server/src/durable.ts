// file writes that are on the disk when the call returns: each call fsyncs
// the file it changed, and a call that can create or rename a file also
// fsyncs its directory, so the name survives a crash too.
import fs from "node:fs";
import path from "node:path";

export function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// the offset in the file where `data` starts
export function appendFile(file: string, data: string | Uint8Array): number {
  const fd = fs.openSync(file, "a", 0o600);
  let at: number;
  try {
    at = fs.fstatSync(fd).size;
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
  return at;
}

// writes `file.tmp`, then renames it over `file`: a reader sees the old text
// or the new, never a part of one
export function replaceFile(file: string, text: string): void {
  const fd = fs.openSync(file + ".tmp", "w", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(file + ".tmp", file);
  syncDirectory(path.dirname(file));
}

export function truncateFile(file: string, length: number): void {
  const fd = fs.openSync(file, "r+");
  try { fs.ftruncateSync(fd, length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
