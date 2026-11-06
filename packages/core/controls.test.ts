import { expect, test } from "bun:test";
import { act, answering, cacheShare, complete, createModel, effectivePick, hear, HELP } from "./src/index.ts";
import { parseClientMessage, type Act, type Pick, type State } from "@membr/protocol";

const pick: Pick = { model: "sonnet", effort: "high", fast: false };
const state: State = { busy: false, wait: "", goal: null, pick, agents: [], usage: null };
function ready() { return hear(hear(createModel(), { type: "state", state }), { type: "ready", version: "1.0" }); }
function send(text: string) { return act(ready(), { type: "send", id: "command", text }); }

test("S2 goal commands set and send the exact goal, halt clears it, and both acts resend once", () => {
  const text = "Keep  these spaces.\n\n  Preserve this line.";
  const result = send(`/goal ${text}`);
  expect(result.acts).toEqual([
    { type: "act", act: "goal", id: "command", text },
    { type: "act", act: "say", id: "command:say", text },
  ]);
  for (const message of result.acts) expect(parseClientMessage(message)).toEqual(message);
  expect(act(result.model, { type: "send", id: "command", text: `/goal ${text}` }).acts).toEqual([]);
  const offline = hear(result.model, { type: "offline" });
  expect(act(offline, { type: "flush" }).acts).toEqual([]);
  expect(act(hear(offline, { type: "ready", version: "1.0" }), { type: "flush" }).acts).toEqual(result.acts);
  expect(send("/halt").acts).toEqual([{ type: "act", act: "goal", id: "command", text: null }]);
  const longest = act(ready(), { type: "send", id: "a".repeat(252), text: "/goal Work" });
  for (const message of longest.acts) expect(parseClientMessage(message)).toEqual(message);
  expect(act(ready(), { type: "send", id: "a".repeat(256), text: "/goal Work" }).model.error).not.toBeNull();
});

test("S2 stop commands address all work or one named agent", () => {
  expect(send("/stop").acts).toEqual([{ type: "act", act: "stop", id: "command", agent: null }]);
  expect(send("/stop Scout").acts).toEqual([{ type: "act", act: "stop", id: "command", agent: "Scout" }]);
});

test("S2 model, effort, and speed commands use the latest pending pick", () => {
  let model = ready();
  const commands = ["/model opus", "/effort max", "/speed fast", "/speed normal"];
  const picks: Pick[] = [
    { model: "opus", effort: "high", fast: false }, { model: "opus", effort: "max", fast: false },
    { model: "opus", effort: "max", fast: true }, { model: "opus", effort: "max", fast: false },
  ];
  for (const [index, text] of commands.entries()) {
    const result = act(model, { type: "send", id: `pick-${index}`, text });
    expect(result.acts).toEqual([{ type: "act", act: "pick", id: `pick-${index}`, pick: picks[index] }]);
    model = result.model;
  }
  expect(effectivePick(model)).toEqual(picks[3]);
  const bar = act(model, { type: "pick", id: "bar", change: { model: "haiku" } });
  expect(effectivePick(bar.model)).toEqual({ model: "haiku", effort: "max", fast: false });
  model = hear(bar.model, { type: "answer", id: "bar", ok: false, reason: "Pick refused." });
  expect(model.error).toBe("Pick refused.");
  expect(effectivePick(model)).toEqual(picks[3]);
});

test("S2 bare pick commands and help show local information without sending a message", () => {
  for (const command of ["/model", "/effort", "/speed", "/help"]) {
    const result = send(command);
    expect(result.acts).toEqual([]);
    expect(result.model.pending.size).toBe(0);
    expect(result.model.info).not.toBeNull();
  }
  const help = send("/help");
  expect(help.model.info).toBe(HELP);
  for (const command of ["/goal", "/halt", "/stop", "/model", "/effort", "/speed", "/fold", "/tree", "/help"]) expect(help.model.info).toContain(command);
  expect(act(help.model, { type: "dismiss-info" }).model.info).toBeNull();
});

test("S2 fold and tree commands use memory reads without a chat act", () => {
  const folded = send("/fold");
  expect(folded.model.folded).toBe(true);
  expect(folded.acts).toEqual([]);
  expect(folded.reads[0]?.read).toBe("roots");
  expect(act(folded.model, { type: "send", id: "again", text: "/fold" }).model.folded).toBe(false);
  const tree = send("/tree");
  expect(tree.model.page).toBe("tree");
  expect(tree.acts).toEqual([]);
  expect(tree.reads[0]?.read).toBe("roots");
});

test("S2 invalid commands show a dismissible error and never reach the model", () => {
  for (const text of ["/unknown", "/goal", "/halt extra", "/stop two names", "/model bad", "/effort extreme", "/speed quick", "/fold extra", "/tree extra", "/help extra"]) {
    const result = send(text);
    expect(result.acts).toEqual([]);
    expect(result.reads).toEqual([]);
    expect(result.model.error).not.toBeNull();
    expect(act(result.model, { type: "dismiss-error" }).model.error).toBeNull();
  }
  expect(send("A normal message").acts).toEqual([{ type: "act", act: "say", id: "command", text: "A normal message" }]);
});

test("S2 approval cards keep tool input, wait for shared closure, and resend each answer unchanged", () => {
  for (const choice of ["once", "always", "deny"] satisfies Extract<Act, { act: "answer" }>["choice"][]) {
    let model = hear(ready(), { type: "ask", id: "approval", tool: "Bash", input: { command: "pwd" } });
    expect(model.approvals.get("approval")?.input).toEqual({ command: "pwd" });
    const answer = act(model, { type: "answer", id: "answer", approval: "approval", choice });
    expect(answer.acts).toEqual([{ type: "act", act: "answer", id: "answer", approval: "approval", choice }]);
    expect(answering(answer.model, "approval")).toBe(true);
    expect(answer.model.approvals.size).toBe(1);
    expect(act(answer.model, { type: "answer", id: "duplicate", approval: "approval", choice }).acts).toEqual([]);
    model = hear(hear(answer.model, { type: "offline" }), { type: "connecting" });
    expect(model.approvals.size).toBe(0);
    model = hear(model, { type: "ask", id: "approval", tool: "Bash", input: { command: "pwd" } });
    model = hear(model, { type: "ready", version: "1.0" });
    expect(act(model, { type: "flush" }).acts).toEqual(answer.acts);
    model = hear(model, { type: "ask-closed", id: "approval" });
    expect(model.approvals.size).toBe(0);
    model = hear(model, { type: "answer", id: "answer", ok: true, entry: null });
    expect(model.pending.size).toBe(0);
    expect(act(model, { type: "answer", id: "late", approval: "approval", choice }).acts).toEqual([]);
  }
});

test("S2 a peer answer and legacy approval event use the same card state", () => {
  const asked = hear(ready(), { type: "approval", id: "legacy", tool: "Read", input: { path: "file" } });
  expect(asked.approvals.get("legacy")?.tool).toBe("Read");
  expect(hear(asked, { type: "ask-closed", id: "legacy" }).approvals.size).toBe(0);
});

test("S2 cache share uses the latest completed turn and includes cache writes", () => {
  const first = { input: 100, cacheRead: 700, cacheWrite: 200, output: 50 };
  let model = hear(ready(), { type: "state", state: { ...state, usage: first } });
  expect(cacheShare(model.state.usage)).toBe(0.7);
  model = hear(model, { type: "state", state: { ...model.state, busy: true } });
  expect(cacheShare(model.state.usage)).toBe(0.7);
  model = hear(model, { type: "state", state: { ...state, usage: { ...first, cacheRead: 0 } } });
  expect(cacheShare(model.state.usage)).toBe(0);
  expect(cacheShare(null)).toBeNull();
  expect(cacheShare({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5 })).toBeNull();
});

test("a skill command goes to the agent as typed, and membr commands keep their names", () => {
  const skills = [
    { name: "pdf", description: "Read a PDF.", argumentHint: "<file>" },
    { name: "help", description: "A skill that membr's /help hides.", argumentHint: "" },
    { name: "pstack:poteto-mode", description: "Work in poteto's style.", argumentHint: "" },
  ];
  const model = hear(ready(), { type: "skills", skills });
  expect(act(model, { type: "send", id: "s", text: "  /pdf report.pdf  " }).acts).toEqual([{ type: "act", act: "say", id: "s", text: "/pdf report.pdf" }]);
  expect(act(model, { type: "send", id: "h", text: "/help" }).acts).toEqual([]);
  expect(act(model, { type: "send", id: "u", text: "/nope" }).model.error).toBe("Unknown command /nope. Use /help.");
  expect(complete(model, "/p").map((c) => c.name)).toEqual(["/pdf", "/pstack:poteto-mode", "/stop", "/speed", "/help"]);
  expect(complete(model, "/poteto").map((c) => c.name)).toEqual(["/pstack:poteto-mode"]);
  expect(complete(model, "/pdf x")).toEqual([]);
  expect(complete(model, "/").filter((c) => c.name === "/help")).toHaveLength(1);
});
