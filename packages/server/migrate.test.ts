import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "./src/migrate.ts";

function legacyDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "membr-migrate-"));
  const legacy = path.join(root, "legacy");
  fs.mkdirSync(path.join(legacy, "main"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "docs", "agent"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "main", "2026-11-01.jsonl"), "{}\n");
  fs.writeFileSync(path.join(legacy, "docs", "agent", "reader.jsonl"), "");
  fs.writeFileSync(path.join(legacy, "machine"), "m1");
  fs.writeFileSync(path.join(legacy, "token"), "secret");
  fs.writeFileSync(path.join(legacy, "rules.md"), "Be brief.\n");
  fs.mkdirSync(path.join(root, "vault"));
  fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ port: 9000, tailscale: true, home: "../vault", rules: "rules.md", after: "git commit", approvalTimeout: "5m" }));
  return { root, legacy, base: path.join(root, "base") };
}

test("the legacy directory becomes the default agent, and its config maps to the agents map", async () => {
  const { root, legacy, base } = legacyDir();
  const notes = await migrate(base, legacy);
  const store = path.join(base, "agents", "default");
  expect(fs.readFileSync(path.join(store, "main", "2026-11-01.jsonl"), "utf8")).toBe("{}\n");
  expect(fs.readFileSync(path.join(store, "machine"), "utf8")).toBe("m1");
  expect(fs.existsSync(path.join(store, "docs", "agent", "reader.jsonl"))).toBe(true);
  expect(fs.readFileSync(path.join(base, "token"), "utf8")).toBe("secret");
  expect(fs.existsSync(path.join(store, "token"))).toBe(false);
  expect(fs.existsSync(path.join(store, "rules.md"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(base, "config.json"), "utf8"))).toEqual({
    port: 9000, tailscale: true,
    agents: { default: { home: path.join(root, "vault"), approvalTimeout: "5m", prompt: "Be brief." } },
  });
  expect(notes.join("\n")).toContain("dropped the after command");
});

test("a second run changes nothing, and a run with no legacy directory does nothing", async () => {
  const { legacy, base } = legacyDir();
  await migrate(base, legacy);
  const config = fs.readFileSync(path.join(base, "config.json"), "utf8");
  expect(await migrate(base, legacy)).toEqual([]);
  expect(fs.readFileSync(path.join(base, "config.json"), "utf8")).toBe(config);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "membr-migrate-"));
  expect(await migrate(path.join(fresh, "base"), path.join(fresh, "missing"))).toEqual([]);
  expect(fs.existsSync(path.join(fresh, "base"))).toBe(false);
});

test("a move that stopped halfway finishes on the next run", async () => {
  const { legacy, base } = legacyDir();
  const store = path.join(base, "agents", "default");
  fs.mkdirSync(store, { recursive: true });
  fs.renameSync(path.join(legacy, "machine"), path.join(store, "machine"));
  await migrate(base, legacy);
  expect(fs.existsSync(path.join(store, "main", "2026-11-01.jsonl"))).toBe(true);
  expect(fs.readFileSync(path.join(store, "machine"), "utf8")).toBe("m1");
  expect(fs.existsSync(path.join(base, "config.json"))).toBe(true);
});

test("a config.json that is in the base directory already stays, and the chat still moves", async () => {
  const { legacy, base } = legacyDir();
  fs.mkdirSync(base, { recursive: true });
  const own = JSON.stringify({ tailscale: true, agents: { default: { home: "/vault" } } });
  fs.writeFileSync(path.join(base, "config.json"), own);
  const notes = await migrate(base, legacy);
  expect(fs.readFileSync(path.join(base, "config.json"), "utf8")).toBe(own);
  expect(fs.existsSync(path.join(base, "agents", "default", "main", "2026-11-01.jsonl"))).toBe(true);
  expect(notes.join("\n")).toContain("was not used");
  expect(await migrate(base, legacy)).toEqual([]);
});

test("a default agent with a chat of its own stops the move, and nothing moves", async () => {
  const { legacy, base } = legacyDir();
  fs.mkdirSync(path.join(base, "agents", "default", "main"), { recursive: true });
  await expect(migrate(base, legacy)).rejects.toThrow("has a chat in");
  expect(fs.existsSync(path.join(legacy, "main", "2026-11-01.jsonl"))).toBe(true);
});
