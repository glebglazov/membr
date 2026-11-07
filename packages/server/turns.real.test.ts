import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";

test.skipIf(process.env.MEMBR_REAL_SDK !== "1")("S1 real Engine answers a message over the protocol", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-real-turn-"));
  const hub = serveHub({ dir, port: 0, epoch: { cwd: dir, pick: { model: "sonnet", effort: "low", fast: false } } });
  let client: TestClient | undefined;
  try {
    client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
    await client.wait("ready");
    const mark = client.events.length;
    client.act({ type: "act", act: "say", id: "real-smoke", text: "Reply with exactly MEMBR-TURN-OK. Do not call any tools." });
    expect((await client.wait("answer", mark)).ok).toBe(true);
    const reply = await client.wait("entry", mark, (event) => event.entry.kind === "unii", 180_000);
    expect(reply.entry.text).toContain("MEMBR-TURN-OK");
    await client.wait("state", mark, (event) => !event.state.busy, 180_000);
    expect(client.events.some((event) => event.type === "live")).toBe(true);
    expect(client.events.filter((event) => event.type === "error")).toEqual([]);
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, "epochs.json"), "utf8"));
    expect(Object.values(sessions)).toHaveLength(1);
    console.log(JSON.stringify({ reply: reply.entry.text, live: true, sessions, dataDirectory: dir }));
  } finally {
    client?.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 240_000);

test.skipIf(process.env.MEMBR_REAL_SDK !== "1")("S1 real stop cancels queued input and keeps the epoch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-real-stop-"));
  const hub = serveHub({ dir, port: 0, epoch: { cwd: dir, pick: { model: "sonnet", effort: "low", fast: false } } });
  let client: TestClient | undefined;
  try {
    client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
    await client.wait("ready");
    client.act({ type: "act", act: "say", id: "long", text: "Run the Bash command `sleep 20; echo FINISHED-SLEEP` once. After it ends, reply FINISHED-SLEEP." });
    await client.wait("entry", 0, (event) => event.entry.kind === "tool" && JSON.parse(event.entry.text).name === "Bash", 180_000);
    const mark = client.events.length;
    client.act({ type: "act", act: "say", id: "queued", text: "After the sleep, reply QUEUED-SHOULD-NOT-RUN." });
    client.act({ type: "act", act: "stop", id: "stop", subagent: null });
    await client.wait("answer", mark, (event) => event.id === "stop");
    await client.wait("state", mark, (event) => !event.state.busy, 180_000);
    const next = client.events.length;
    client.act({ type: "act", act: "say", id: "after", text: "Reply exactly AFTER-STOP-OK. Do not call tools." });
    const reply = await client.wait("entry", next, (event) => event.entry.kind === "unii" && event.entry.text.includes("AFTER-STOP-OK"), 180_000);
    await client.wait("state", next, (event) => !event.state.busy, 180_000);
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, "epochs.json"), "utf8"));
    expect(Object.values(sessions)).toHaveLength(1);
    expect(client.events.filter((event) => event.type === "error")).toEqual([]);
    expect(client.events.some((event) => event.type === "entry" && event.entry.kind === "unii" && event.entry.text.includes("QUEUED-SHOULD-NOT-RUN"))).toBe(false);
    console.log(JSON.stringify({ reply: reply.entry.text, sameEpochAfterStop: true, sessions, dataDirectory: dir }));
  } finally {
    client?.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
