// ZIP reader adapted from UniiChat Import.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Licensed under Apache-2.0.
// See licenses/UniiChat.txt.
const LIMIT = 32 * 2 ** 20;

export async function readExport(file: Blob): Promise<string> {
  if (await file.slice(0, 2).text() !== "PK") {
    if (file.size > LIMIT) throw new Error("Choose at most 32 MB of conversations JSON.");
    return file.text();
  }
  const view = async (at: number, size: number): Promise<DataView> => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at + size > file.size) throw new Error("The ZIP file is incomplete.");
    return new DataView(await file.slice(at, at + size).arrayBuffer());
  };
  const tail = await view(Math.max(0, file.size - 65577), Math.min(file.size, 65577));
  let end = tail.byteLength - 22;
  while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 || end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) end--;
  if (end < 0) throw new Error("The ZIP file has no end record.");
  if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) throw new Error("Split ZIP files are not supported.");
  const wide = end >= 20 && tail.getUint32(end - 20, true) === 0x07064b50;
  const z64 = wide ? await view(Number(tail.getBigUint64(end - 12, true)), 56) : null;
  if (z64 && z64.getUint32(0, true) !== 0x06064b50) throw new Error("The ZIP64 end record is invalid.");
  const count = z64 ? Number(z64.getBigUint64(32, true)) : tail.getUint16(end + 10, true);
  const size = z64 ? Number(z64.getBigUint64(40, true)) : tail.getUint32(end + 12, true);
  const from = z64 ? Number(z64.getBigUint64(48, true)) : tail.getUint32(end + 16, true);
  const dir = await view(from, size);
  for (let p = 0, k = 0; k < count; k++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== 0x02014b50) throw new Error("The ZIP directory is invalid.");
    const nameSize = dir.getUint16(p + 28, true), extraSize = dir.getUint16(p + 30, true), commentSize = dir.getUint16(p + 32, true);
    const next = p + 46 + nameSize + extraSize + commentSize;
    if (next > dir.byteLength) throw new Error("The ZIP directory is incomplete.");
    const name = new TextDecoder().decode(new Uint8Array(dir.buffer, p + 46, nameSize));
    if (name === "conversations.json" || name.endsWith("/conversations.json")) {
      if (dir.getUint16(p + 8, true) & 1) throw new Error("Encrypted ZIP files are not supported.");
      const method = dir.getUint16(p + 10, true);
      if (method !== 0 && method !== 8) throw new Error("The ZIP compression method is not supported.");
      let x = p + 46 + nameSize;
      const extraEnd = x + extraSize;
      while (x + 4 <= extraEnd && dir.getUint16(x, true) !== 1) x += 4 + dir.getUint16(x + 2, true);
      let slot = x + 4;
      const sizes = [p + 24, p + 20, p + 42].map((at) => {
        const n = dir.getUint32(at, true);
        if (n !== 0xffffffff) return n;
        if (x + 4 > extraEnd || slot + 8 > extraEnd || slot + 8 > x + 4 + dir.getUint16(x + 2, true)) throw new Error("The ZIP64 entry is incomplete.");
        const value = Number(dir.getBigUint64(slot, true)); slot += 8; return value;
      });
      const [unpacked, packed, at] = sizes;
      if (!Number.isSafeInteger(unpacked) || unpacked > LIMIT) throw new Error("Choose at most 32 MB of conversations JSON.");
      const head = await view(at, 30);
      if (head.getUint32(0, true) !== 0x04034b50) throw new Error("The ZIP file header is invalid.");
      const start = at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      if (!Number.isSafeInteger(packed) || packed < 0 || start + packed > file.size) throw new Error("The ZIP entry is incomplete.");
      const data = file.slice(start, start + packed);
      const stream = method === 8 ? data.stream().pipeThrough(new DecompressionStream("deflate-raw")) : data.stream();
      const reader = stream.getReader(), chunks: ArrayBuffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > LIMIT || bytes > unpacked) throw new Error("The ZIP entry exceeds its declared size or 32 MB.");
          chunks.push(new Uint8Array(chunk.value).buffer);
        }
      } finally { await reader.cancel(); }
      if (bytes !== unpacked) throw new Error("The ZIP entry is incomplete.");
      return new Blob(chunks).text();
    }
    p = next;
  }
  throw new Error("No conversations.json in the ZIP file.");
}
