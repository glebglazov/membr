import { expect, test } from "bun:test";
import { act, createModel, hear } from "./src/index.ts";
import { parseEvent, type Event } from "@membr/protocol";
import recorded from "./test/turn.json";

const entry = (i: number, kind: "user" | "unii" | "tool" | "echo", text: string): Event => ({ type: "entry", entry: { i, kind, text, date: "2026-10-24T12:00:00.000Z", from: { machine: "server", seq: i } } });
const turn = recorded.map(parseEvent);

test("S2 renders a complete recorded protocol turn", () => {
  let model = createModel();
  model = act(model, { type: "send", id: "say-1", text: "Check the folder" }).model;
  for (const event of turn) {
    model = hear(model, parseEvent(JSON.parse(JSON.stringify(event))));
    if (event.type === "live" && event.text === "check.") expect(model.live).toBe("I will check.");
  }
  expect([...model.entries.values()].map(({ kind, text }) => [kind, text])).toEqual(turn.filter((event) => event.type === "entry").map((event) => [event.entry.kind, event.entry.text]));
  expect(model.connection).toBe("ready");
  expect(model.live).toBe("");
  expect(model.pending.size).toBe(0);
  expect(model.state.busy).toBe(false);
  expect(model.state.usage?.output).toBe(10);
});

test("S2 replays entries and resends an unanswered act with its original id", () => {
  let model = hear(createModel(), { type: "ready", version: "1.0" });
  const sent = act(model, { type: "send", id: "lost-answer", text: "Only once" });
  expect(sent.acts).toEqual([{ type: "act", act: "say", id: "lost-answer", text: "Only once" }]);
  model = hear(sent.model, entry(0, "user", "Only once"));
  model = hear(model, { type: "live", text: "Old partial", agent: null });
  model = hear(model, { type: "offline" });
  const queued = act(model, { type: "send", id: "offline", text: "Next" });
  expect(queued.acts).toEqual([]);
  model = hear(queued.model, { type: "connecting" });
  expect(act(model, { type: "flush" }).acts).toEqual([]);
  model = hear(model, entry(0, "user", "Only once"));
  model = hear(model, { type: "live", text: "Current partial", agent: null });
  model = hear(model, { type: "ready", version: "1.0" });
  expect(model.entries.size).toBe(1);
  expect(model.live).toBe("Current partial");
  expect(act(model, { type: "flush" }).acts.map((message) => message.id)).toEqual(["lost-answer", "offline"]);
  model = hear(model, { type: "answer", id: "lost-answer", ok: true, entry: 0 });
  model = hear(model, { type: "answer", id: "offline", ok: false, reason: "The turn is stopping" });
  model = hear(hear(model, { type: "offline" }), { type: "ready", version: "1.0" });
  expect(act(model, { type: "flush" }).acts).toEqual([]);
  expect(model.error).toBe("The turn is stopping");
});
