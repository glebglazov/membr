import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pick } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { TestClient } from "./test/client.ts";
import { FakeEngine } from "./test/engine.ts";
import { defaultStore } from "./test/config.ts";

const hubs: ReturnType<typeof serveHub>[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
const OPUS: Pick = { model: "opus", effort: "max", fast: true };
const HAIKU: Pick = { model: "haiku", effort: "low", fast: false };

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function serve(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-pick-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const engine = new FakeEngine();
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  return { ...hub, dir, engine };
}

async function connect(hub: ReturnType<typeof serve>) {
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return client;
}

test("a pick reaches the live epoch once and updates every client", async () => {
  const hub = serve();
  const a = await connect(hub);
  const b = await connect(hub);
  const epoch = hub.engine.epochs[0];
  a.act({ type: "act", act: "say", id: "running", text: "Keep working" });
  await a.wait("answer");
  await b.wait("state", 0, (event) => event.state.busy);
  const marks = [a.events.length, b.events.length];
  const pick = { type: "act", act: "pick", id: "opus", pick: OPUS } as const;
  a.act(pick);
  b.act(pick);
  const answer = await a.wait("answer", marks[0]);
  expect(answer).toEqual({ type: "answer", id: "opus", ok: true, entry: null });
  expect(await b.wait("answer", marks[1])).toEqual(answer);
  for (const [i, client] of [a, b].entries()) {
    const changed = await client.wait("state", marks[i]);
    expect(changed.state.pick).toEqual(OPUS);
    expect(changed.state.busy).toBe(true);
    expect(client.events.slice(marks[i]).filter((event) => event.type === "state")).toHaveLength(1);
    expect(client.events.slice(marks[i]).filter((event) => event.type === "entry")).toHaveLength(0);
  }
  expect(hub.engine.epochs).toHaveLength(1);
  expect(epoch.picks).toEqual([OPUS]);
  expect(epoch.options.pick).toEqual({ model: "sonnet", effort: "high", fast: false });
  expect(epoch.closed).toBe(false);
  const late = await connect(hub);
  expect((await late.wait("state")).state.pick).toEqual(OPUS);
});

test("an invalid offered model leaves the live and saved pick unchanged", async () => {
  const hub = serve();
  const client = await connect(hub);
  client.act({ type: "act", act: "pick", id: "valid", pick: OPUS });
  await client.wait("answer");
  const mark = client.events.length;
  const invalid = { type: "act", act: "pick", id: "invalid", pick: { ...HAIKU, model: "not-offered" } } as const;
  client.act(invalid);
  const answer = await client.wait("answer", mark);
  expect(answer).toEqual({ type: "answer", id: "invalid", ok: false, reason: "Model not-offered is not offered" });
  expect(client.events.slice(mark).some((event) => event.type === "state")).toBe(false);
  expect(hub.engine.epochs[0].picks).toEqual([OPUS]);
  hub.close();
  const after = serve(hub.dir);
  const recovered = await connect(after);
  expect(after.engine.epochs[0].options.pick).toEqual(OPUS);
  expect((await recovered.wait("state")).state.pick).toEqual(OPUS);
  recovered.act({ ...invalid, pick: HAIKU });
  expect(await recovered.wait("answer")).toEqual(answer);
  expect(after.engine.epochs[0].picks).toHaveLength(0);
});

test("restart opens a new epoch with the saved pick and replays its first answer", async () => {
  const before = serve();
  const a = await connect(before);
  const act = { type: "act", act: "pick", id: "saved", pick: HAIKU } as const;
  a.act(act);
  const answer = await a.wait("answer");
  before.close();
  const after = serve(before.dir);
  const b = await connect(after);
  expect(after.engine.epochs[0].options.pick).toEqual(HAIKU);
  expect((await b.wait("state")).state.pick).toEqual(HAIKU);
  b.act({ ...act, pick: OPUS });
  expect(await b.wait("answer")).toEqual(answer);
  expect(after.engine.epochs[0].picks).toHaveLength(0);
  expect(b.events.filter((event) => event.type === "entry")).toHaveLength(0);
});

for (const [field, value] of [["effort", "invalid"], ["fast", "yes"]] as const) {
  test(`an invalid pick ${field} gets a saved error answer and changes no pick`, async () => {
    const before = serve();
    const client = await connect(before);
    client.act({ type: "act", act: "pick", id: "valid", pick: OPUS });
    await client.wait("answer");
    const mark = client.events.length;
    client.socket.send(JSON.stringify({ type: "act", act: "pick", id: "invalid", pick: { ...HAIKU, [field]: value } }));
    const answer = await client.wait("answer", mark);
    expect(answer).toMatchObject({ type: "answer", id: "invalid", ok: false, reason: expect.any(String) });
    expect(client.events.slice(mark).some((event) => event.type === "state" || event.type === "error")).toBe(false);
    expect(before.engine.epochs[0].picks).toEqual([OPUS]);
    await before.close();
    const after = serve(before.dir);
    const recovered = await connect(after);
    expect((await recovered.wait("state")).state.pick).toEqual(OPUS);
    expect(after.engine.epochs[0].options.pick).toEqual(OPUS);
    recovered.act({ type: "act", act: "pick", id: "invalid", pick: HAIKU });
    expect(await recovered.wait("answer")).toEqual(answer);
    expect(after.engine.epochs[0].picks).toEqual([]);
  });
}

test("concurrent picks apply in order while stop remains available", async () => {
  const hub = serve();
  const a = await connect(hub);
  const b = await connect(hub);
  const epoch = hub.engine.epochs[0];
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  epoch.onPick = async (pick) => {
    if (pick.model === OPUS.model) await first.promise;
    else second.resolve();
  };
  a.act({ type: "act", act: "say", id: "work", text: "Work" });
  await a.wait("answer");
  a.act({ type: "act", act: "pick", id: "first", pick: OPUS });
  await a.wait("answer", 0, (event) => event.id === "first");
  b.act({ type: "act", act: "pick", id: "second", pick: HAIKU });
  await b.wait("answer");
  expect(epoch.picks).toEqual([OPUS]);
  const mark = a.events.length;
  a.act({ type: "act", act: "stop", id: "stop", subagent: null });
  await a.wait("answer", mark);
  await a.wait("state", mark, (event) => !event.state.busy);
  expect(epoch.interrupts).toBe(1);
  expect(epoch.picks).toEqual([OPUS]);
  first.resolve();
  await second.promise;
  expect(epoch.picks).toEqual([OPUS, HAIKU]);
  const late = await connect(hub);
  expect((await late.wait("state")).state.pick).toEqual(HAIKU);
});

test("a failed control closes the epoch and skips queued controls", async () => {
  const hub = serve();
  const client = await connect(hub);
  const epoch = hub.engine.epochs[0];
  const control = Promise.withResolvers<void>();
  epoch.onPick = () => control.promise;
  client.act({ type: "act", act: "pick", id: "first", pick: OPUS });
  await client.wait("answer");
  client.act({ type: "act", act: "pick", id: "second", pick: HAIKU });
  await client.wait("answer", 0, (event) => event.id === "second");
  control.reject(new Error("The flags could not be applied"));
  expect((await client.wait("error")).reason).toBe("The flags could not be applied");
  expect(epoch.closed).toBe(true);
  client.act({ type: "act", act: "say", id: "after-failure", text: "Do not send" });
  expect(await client.wait("answer", 0, (event) => event.id === "after-failure")).toEqual({ type: "answer", id: "after-failure", ok: false, reason: "The flags could not be applied" });
  expect(client.events.filter((event) => event.type === "error")).toHaveLength(1);
  expect(epoch.messages).toHaveLength(0);
  expect(epoch.picks).toEqual([OPUS]);
  hub.close();
  const after = serve(hub.dir);
  await connect(after);
  expect(after.engine.epochs[0].options.pick).toEqual(HAIKU);
});

test("close skips pending controls and ignores a late control rejection", async () => {
  const hub = serve();
  const client = await connect(hub);
  const epoch = hub.engine.epochs[0];
  const control = Promise.withResolvers<void>();
  epoch.onPick = () => control.promise;
  client.act({ type: "act", act: "pick", id: "first", pick: OPUS });
  await client.wait("answer");
  client.act({ type: "act", act: "pick", id: "second", pick: HAIKU });
  await client.wait("answer", 0, (event) => event.id === "second");
  hub.close();
  control.reject(new Error("Closed control"));
  const after = serve(hub.dir);
  await connect(after);
  expect(after.engine.epochs[0].options.pick).toEqual(HAIKU);
  expect(epoch.picks).toEqual([OPUS]);
});

for (const source of ["stop", "stream"] as const) {
  test(`a late ${source} error preserves the first pick failure`, async () => {
    const hub = serve();
    const client = await connect(hub);
    const epoch = hub.engine.epochs[0];
    const control = Promise.withResolvers<void>();
    const interrupt = Promise.withResolvers<void>();
    epoch.onPick = () => control.promise;
    epoch.onInterrupt = () => interrupt.promise;
    if (source === "stream") {
      const close = epoch.close.bind(epoch);
      epoch.close = () => { epoch.fail(new Error("The stream closed")); close(); };
    }
    client.act({ type: "act", act: "say", id: "work", text: "Work" });
    await client.wait("answer");
    client.act({ type: "act", act: "pick", id: "pick", pick: OPUS });
    await client.wait("answer", 0, (event) => event.id === "pick");
    if (source === "stop") {
      client.act({ type: "act", act: "stop", id: "stop", subagent: null });
      await client.wait("answer", 0, (event) => event.id === "stop");
    }
    control.reject(new Error("The flags could not be applied"));
    await client.wait("error");
    if (source === "stop") interrupt.reject(new Error("The epoch closed during stop"));
    client.act({ type: "act", act: "say", id: "after-failure", text: "Do not send" });
    expect(await client.wait("answer", 0, (event) => event.id === "after-failure")).toEqual({
      type: "answer", id: "after-failure", ok: false, reason: "The flags could not be applied",
    });
    expect(client.events.filter((event) => event.type === "error")).toHaveLength(1);
  });
}

test("pick recovery follows revision when daily files sort in reverse order", async () => {
  const before = serve();
  const client = await connect(before);
  for (const [id, pick] of [["first", OPUS], ["second", HAIKU]] as const) {
    client.act({ type: "act", act: "pick", id, pick });
    await client.wait("answer", 0, (event) => event.id === id);
  }
  before.close();
  const main = path.join(defaultStore(before.dir), "main");
  const files = fs.readdirSync(main);
  const records = files.flatMap((file) => fs.readFileSync(path.join(main, file), "utf8").trim().split("\n"));
  expect(records).toHaveLength(2);
  for (const file of files) fs.rmSync(path.join(main, file));
  fs.writeFileSync(path.join(main, "2026-10-23.jsonl"), records[0] + "\n");
  fs.writeFileSync(path.join(main, "2026-10-22.jsonl"), records[1] + "\n");
  const after = serve(before.dir);
  const recovered = await connect(after);
  expect(after.engine.epochs[0].options.pick).toEqual(HAIKU);
  expect((await recovered.wait("state")).state.pick).toEqual(HAIKU);
  recovered.act({ type: "act", act: "pick", id: "third", pick: OPUS });
  await recovered.wait("answer");
  after.close();
  const again = serve(before.dir);
  await connect(again);
  expect(again.engine.epochs[0].options.pick).toEqual(OPUS);
});
