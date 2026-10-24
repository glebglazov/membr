// Image storage and fitting adapted from UniiChat Memory.ts at 0500bf6.
// Copyright 2026 Higher Order Company. Apache-2.0. See licenses/UniiChat.txt.
import fs from "node:fs";
import path from "node:path";
import { syncDirectory } from "./durable.ts";

export const IMAGE_COUNT = 20;
const FIT = 1568;
const IMAGE = 2 ** 20;
const PIXELS = 2 ** 28;
const PIECE = 2 ** 20;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
export type Image = { data: string; mimeType: typeof TYPES[keyof typeof TYPES] };

export function imagePath(dir: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) throw new Error("Invalid image name");
  return path.join(dir, "docs", "images", name);
}

// how a message's images read in the text the model sees, one line each
export function imageMarks(names: readonly string[]): string {
  return names.map((name) => `\n[image docs/images/${name}]`).join("");
}

export function readImage(dir: string, name: string): Image {
  const file = imagePath(dir, name);
  const fit = fs.existsSync(file + ".jpg");
  const extension = fit ? "jpg" : name.split(".").pop();
  const mimeType = Object.entries(TYPES).find(([key]) => key === extension)?.[1];
  if (!mimeType) throw new Error("Invalid image type");
  return { data: fs.readFileSync(file + (fit ? ".jpg" : "")).toString("base64"), mimeType };
}

function write(file: string, bytes: Uint8Array): void {
  if (fs.existsSync(file)) return;
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export async function storeImage(dir: string, bytes: Buffer, declared: string): Promise<string> {
  const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
    : /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString()) ? "gif"
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (!extension || TYPES[extension] !== declared) throw new Error("Choose a PNG, JPEG, GIF, or WebP image with a matching file type.");
  const image = new Bun.Image(bytes);
  const size = await image.metadata();
  if (size.width * size.height > PIXELS) throw new Error("The image has too many pixels.");
  const hash = new Bun.CryptoHasher("sha256");
  for (let at = 0; at < bytes.length; at += PIECE) {
    hash.update(bytes.subarray(at, at + PIECE));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const name = hash.digest("hex").slice(0, 16) + "." + extension;
  const file = imagePath(dir, name);
  const k = Math.min(1, FIT / Math.max(size.width, size.height));
  const fit = (k < 1 || bytes.length > IMAGE) && size.width * size.height <= PIXELS;
  const model = fit ? await image.resize(Math.round(size.width * k), Math.round(size.height * k)).jpeg({ quality: 85 }).bytes() : null;
  if (!fit) await image.resize(1, 1).jpeg().bytes();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (model) write(file + ".jpg", model);
  write(file, bytes);
  syncDirectory(path.dirname(file));
  return name;
}
