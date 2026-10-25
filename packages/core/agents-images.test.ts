import { expect, test } from "bun:test";
import { act, createModel, hear, type Attachment } from "./src/index.ts";
import { parseEvent, type Entry } from "@membr/protocol";

const entry = (i: number, text: string): Entry => ({ i, text, kind: "unii", date: "2026-10-24T12:00:00Z", from: { machine: "server", seq: i } });
const image: Attachment = { id: "image-1", name: "screen.png", type: "image/png", data: "aW1hZ2U=" };
function ready() { return hear(createModel(), { type: "ready", version: "1.0" }); }

test("S2 agent tabs keep independent live logs, refresh on switching, and recover finished agents", () => {
  let model = hear(ready(), parseEvent({ type: "state", state: { busy: true, wait: "", goal: null, pick: null, agents: ["Agent1"], agentNames: ["Agent1", "Agent2"], usage: null } }));
  model = hear(model, { type: "entry", entry: entry(0, "Main answer") });
  model = hear(model, { type: "agent-entry", name: "Agent1", entry: entry(0, "Agent answer") });
  model = hear(model, { type: "live", agent: "Agent1", text: "Next " });
  model = hear(model, { type: "live", agent: "Agent1", text: "part" });
  model = hear(model, { type: "live", agent: null, text: "Main partial" });
  expect(model.entries.get(0)?.text).toBe("Main answer");
  expect(model.live).toBe("Main partial");
  let selected = act(model, { type: "agent", name: "Agent1" });
  expect(selected.model.agent).toBe("Agent1");
  expect(selected.model.agents.get("Agent1")?.live).toBe("Next part");
  expect(selected.reads[0]).toMatchObject({ read: "agent", name: "Agent1" });
  model = hear(selected.model, { type: "read", id: selected.reads[0].id, entries: [entry(0, "Agent answer"), entry(1, "Tool answer")], live: "Next part", parts: [], lines: [] });
  expect(model.agents.get("Agent1")?.entries.size).toBe(2);
  expect(model.entries.size).toBe(1);
  model = hear(model, { type: "agent-entry", name: "Agent1", entry: entry(2, "Next part") });
  expect(model.agents.get("Agent1")?.live).toBe("");
  selected = act(model, { type: "agent", name: "Agent2" });
  expect(selected.reads.at(-1)).toMatchObject({ read: "agent", name: "Agent2" });
  expect(act(selected.model, { type: "agent", name: null }).model.agent).toBeNull();
  expect(act(model, { type: "agent", name: "Missing" }).model).toBe(model);
  model = hear(hear(model, { type: "offline" }), { type: "connecting" });
  model = hear(model, { type: "ready", version: "1.0" });
  const refresh = act(model, { type: "flush" }).reads.find((read) => read.read === "agent" && read.name === "Agent1");
  expect(refresh).toBeDefined();
  expect(model.agents.get("Agent1")?.live).toBe("");
  expect([...model.agents.keys()]).toEqual(["Agent1", "Agent2"]);
});

test("S2 image attachment state removes previews and retries the same upload without a WebSocket say", () => {
  let model = act(ready(), { type: "attach", images: [image, { ...image, id: "remove", name: "remove.png" }] }).model;
  model = act(model, { type: "detach", id: "remove" }).model;
  expect(model.attachments).toEqual([image]);
  const sent = act(model, { type: "send", id: "image-only", text: "" });
  expect(sent.acts).toEqual([]);
  expect(sent.uploads).toEqual([{ id: "image-only", text: "", images: [image] }]);
  expect(sent.model.attachments).toEqual([]);
  expect(sent.model.pending.has("image-only")).toBe(true);
  expect(act(sent.model, { type: "send", id: "image-only", text: "" }).uploads).toEqual([]);
  model = hear(sent.model, { type: "offline" });
  expect(act(model, { type: "flush" }).uploads).toEqual([]);
  model = hear(hear(model, { type: "connecting" }), { type: "ready", version: "1.0" });
  const retry = act(model, { type: "flush" });
  expect(retry.acts).toEqual([]);
  expect(retry.uploads).toEqual(sent.uploads);
  model = hear(model, { type: "answer", id: "image-only", ok: true, entry: 0 });
  expect(model.pending.size).toBe(0);
  expect(model.uploads.size).toBe(0);
  expect(act(model, { type: "flush" }).uploads).toEqual([]);
});

test("S2 attachment failures keep the draft and command input cannot discard images", () => {
  let model = act(ready(), { type: "attach", images: [image] }).model;
  const command = act(model, { type: "send", id: "help", text: "/help" });
  expect(command.model.error).toContain("Remove images");
  expect(command.model.attachments).toEqual([image]);
  expect(command.acts).toEqual([]);
  expect(act(model, { type: "attach", images: [{ ...image, type: "image/svg+xml" }] }).model.attachments).toEqual([image]);
  expect(act(model, { type: "attach", images: Array.from({ length: 20 }, () => image) }).model.error).toContain("at most 20");
  model = act(hear(model, { type: "offline" }), { type: "send", id: "offline-image", text: "A picture" }).model;
  expect(model.uploads.get("offline-image")?.images).toEqual([image]);
  model = hear(model, { type: "answer", id: "offline-image", ok: false, reason: "The image is invalid." });
  expect(model.error).toBe("The image is invalid.");
  expect(model.uploads.size).toBe(0);
});
