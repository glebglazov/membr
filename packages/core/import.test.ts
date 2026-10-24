import { expect, test } from "bun:test";
import { act, createModel, hear } from "./src/index.ts";
import type { ImportInput } from "@membr/protocol";

test("an import estimate and acts use the shared reconnect queue", () => {
  const input: ImportInput = { source: "codex", path: "sessions", files: [{ name: "rollout.jsonl", text: "{}\n" }] };
  let model = act(createModel(), { type: "import-plan", id: "estimate", input }).model;
  expect(model.reads.size).toBe(1);
  model = hear(model, { type: "ready", version: "1.0" });
  expect(act(model, { type: "flush" }).reads).toEqual([{ type: "read", read: "import", id: "estimate", ...input }]);
  model = hear(model, { type: "import-estimate", id: "old", estimate: { messages: 20, sessions: 1, compactions: 10 } });
  expect(model.importPlan?.estimate).toBeNull();
  model = hear(model, { type: "import-estimate", id: "estimate", estimate: { messages: 3, sessions: 1, compactions: 5 } });
  const started = act(model, { type: "import-start", id: "run" });
  expect(started.acts).toEqual([{ type: "act", act: "import", id: "run", ...input }]);
  expect(act(hear(started.model, { type: "ready", version: "1.0" }), { type: "flush" }).acts).toEqual(started.acts);
  model = hear(started.model, { type: "answer", id: "run", ok: true, entry: null });
  expect(model.pending.size).toBe(0); expect(model.importPlan).toBeNull();
  model = hear(model, { type: "imports", imports: [{ id: "run", phase: "running", sessions: 1, messages: 3, compactions: 5 }] });
  expect(model.imports[0].phase).toBe("running");
  expect(act(model, { type: "import-go", id: "pause", run: "run", paused: true }).acts).toEqual([{ type: "act", act: "go", id: "pause", import: "run", paused: true }]);
});
