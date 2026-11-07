import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTEBOOK_CAP, type Answer } from "@membr/protocol";
import { serveHub } from "./src/hub.ts";
import { Log } from "./src/log.ts";
import { block, lineDiff } from "./src/notebook.ts";
import { TestClient } from "./test/client.ts";
import { END, FakeEngine } from "./test/engine.ts";

const hubs: ReturnType<typeof serveHub>[] = [], clients: TestClient[] = [], dirs: string[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

async function serve(dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-notebook-")), engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Done." }, END))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const hub = serveHub({ dir, port: 0, engine });
  hubs.push(hub);
  const client = await TestClient.connect(hub.server.url.href.replace("http:", "ws:") + "ws", { token: hub.token });
  clients.push(client);
  await client.wait("ready");
  return { dir, hub, client, engine, main: engine.epochs.at(-1)!, edit: engine.epochs.at(-1)!.options.notebook!.edit };
}

let acts = 0;
async function save(client: TestClient, text: string, base: number, id = `notebook-${++acts}`): Promise<Answer> {
  const mark = client.events.length;
  client.socket.send(JSON.stringify({ type: "act", act: "notebook", id, text, base }));
  return await client.wait("answer", mark, (event) => event.id === id);
}

async function say(client: TestClient, text: string) {
  const mark = client.events.length, id = `say-${++acts}`;
  client.act({ type: "act", act: "say", id, text });
  await client.wait("answer", mark, (event) => event.id === id);
  await client.wait("state", mark, (event) => !event.state.busy);
}

const notebooks = (client: TestClient) => client.events.flatMap((event) => event.type === "notebook" ? [event.notebook] : []);
const revision = async (client: TestClient, n: number) => (await client.wait("notebook", 0, (event) => event.notebook.revision === n)).notebook;
const reason = (answer: Answer) => answer.ok ? "" : answer.reason;

test("an agent edit changes the text and answers with the revision and the size", async () => {
  const { edit, client } = await serve();
  expect(edit([{ old: "", new: "- Editor: vim" }])).toEqual({ text: `Notebook revision 1: 13 of ${NOTEBOOK_CAP} bytes.`, error: false });
  expect(edit([{ old: "vim", new: "helix" }, { old: "", new: "- Deploys: ask first" }])).toEqual({ text: `Notebook revision 2: 36 of ${NOTEBOOK_CAP} bytes.`, error: false });
  const seen = await client.wait("notebook", 0, (event) => event.notebook.revision === 2);
  expect(seen.notebook).toMatchObject({ text: "- Editor: helix\n- Deploys: ask first", by: "agent" });
  expect(edit([{ old: "helix", new: "helix" }]).text).toStartWith("Notebook unchanged at revision 2");
});

test("an edit over the cap is refused with the sizes, and the notebook stays", async () => {
  const { edit } = await serve();
  edit([{ old: "", new: "a".repeat(8000) }]);
  const refused = edit([{ old: "", new: "b".repeat(300) }]);
  expect(refused).toEqual({ text: `The notebook would be 8301 of ${NOTEBOOK_CAP} bytes. Merge or remove entries, then edit again.`, error: true });
  expect(edit([{ old: "b", new: "b" }]).text).toStartWith("Edit 1: Old text not found.");
});

test("the cap counts UTF-8 bytes, not characters", async () => {
  const { edit } = await serve();
  expect(edit([{ old: "", new: "é".repeat(4097) }]).error).toBe(true);
  expect(edit([{ old: "", new: "é".repeat(4096) }]).error).toBe(false);
});

test("old text that is not found is refused with the current block, so the agent retries at once", async () => {
  const { edit, client } = await serve();
  edit([{ old: "", new: "- Editor: vim" }]);
  await revision(client, 1);
  await save(client, "- Editor: neovim", 1);
  const refused = edit([{ old: "- Editor: vim", new: "- Editor: helix" }]);
  expect(refused.error).toBe(true);
  expect(refused.text).toBe('Edit 1: Old text not found.\nThe notebook is now:\n<notebook revision="2">\n- Editor: neovim\n</notebook>\n');
});

test("old text that occurs more than once is refused", async () => {
  const { edit } = await serve();
  edit([{ old: "", new: "- a: x\n- b: x" }]);
  const refused = edit([{ old: "x", new: "y" }]);
  expect(refused.error).toBe(true);
  expect(refused.text).toContain("Old text occurs 2 times");
});

test("edits apply all or none", async () => {
  const { edit, client } = await serve();
  edit([{ old: "", new: "one\ntwo" }]);
  expect(edit([{ old: "one", new: "1" }, { old: "three", new: "3" }]).text).toStartWith("Edit 2: Old text not found.");
  expect(await revision(client, 1)).toMatchObject({ text: "one\ntwo" });
  expect(notebooks(client).map((notebook) => notebook.revision)).not.toContain(2);
  expect(edit([{ old: "one", new: "two two" }, { old: "two two", new: "x" }, { old: "", new: "end" }]).error).toBe(false);
  expect((await revision(client, 2)).text).toBe("x\ntwo\nend");
});

test("an empty old appends on its own line", async () => {
  const { edit, client } = await serve();
  edit([{ old: "", new: "first" }]);
  edit([{ old: "", new: "second" }]);
  edit([{ old: "", new: "third\n" }, { old: "", new: "fourth" }]);
  expect((await revision(client, 3)).text).toBe("first\nsecond\nthird\nfourth");
});

test("a user save writes a revision, a note with the diff, and tells every client", async () => {
  const { client, edit } = await serve();
  edit([{ old: "", new: "- Editor: vim" }]);
  await revision(client, 1);
  const answer = await save(client, "- Editor: helix\n- Shell: fish", 1);
  expect(answer.ok).toBe(true);
  const event = await client.wait("notebook", 0, (event) => event.notebook.revision === 2);
  expect(event.notebook).toMatchObject({ by: "user", text: "- Editor: helix\n- Shell: fish" });
  const note = (await client.wait("entry", 0, (event) => event.entry.kind === "note")).entry;
  expect(note.text).toBe("The user edited the notebook (revision 2):\n- - Editor: vim\n+ - Editor: helix\n+ - Shell: fish");
  expect(answer).toEqual({ type: "answer", id: answer.id, ok: true, entry: note.i });
});

test("a save from a stale base is refused and saves nothing", async () => {
  const { client, edit } = await serve();
  edit([{ old: "", new: "agent line" }]);
  await revision(client, 1);
  const answer = await save(client, "my draft", 0);
  expect(reason(answer)).toBe("The notebook is at revision 1, and you edited revision 0.");
  expect(notebooks(client).at(-1)).toMatchObject({ revision: 1, text: "agent line" });
});

test("a save over the cap is refused, and a retry gets the same answer", async () => {
  const { client } = await serve();
  const big = "x".repeat(NOTEBOOK_CAP + 1);
  const first = await save(client, big, 0, "same");
  expect(reason(first)).toBe(`The notebook would be ${NOTEBOOK_CAP + 1} of ${NOTEBOOK_CAP} bytes. Merge or remove entries, then edit again.`);
  expect(await save(client, "small", 0, "same")).toEqual(first);
  expect(notebooks(client).at(-1)?.revision).toBe(0);
});

test("the same act id gives the same answer and writes one revision", async () => {
  const { client } = await serve();
  const first = await save(client, "once", 0, "dup");
  expect(await save(client, "once", 0, "dup")).toEqual(first);
  expect(notebooks(client).filter((notebook) => notebook.revision > 0)).toHaveLength(1);
  expect(client.events.filter((event) => event.type === "entry" && event.entry.kind === "note")).toHaveLength(1);
});

test("a save that changes nothing answers ok and writes no revision", async () => {
  const { client } = await serve();
  await save(client, "same", 0);
  const answer = await save(client, "same", 1);
  expect(answer).toMatchObject({ ok: true, entry: null });
  expect(notebooks(client).at(-1)?.revision).toBe(1);
});

test("a replay after reopening the log restores the latest revision", async () => {
  const { dir, client, edit } = await serve();
  edit([{ old: "", new: "one" }]);
  await revision(client, 1);
  await save(client, "two", 1);
  edit([{ old: "two", new: "three" }]);
  await hubs.pop()!.close();
  clients.splice(0).forEach((c) => c.close());
  const log = new Log(path.join(dir, "agents", "default"));
  expect(log.notebook).toMatchObject({ revision: 3, text: "three", by: "agent" });
  expect(log.notebookUser).toBe(2);
  const again = await serve(dir);
  expect(notebooks(again.client).at(-1)).toMatchObject({ revision: 3, text: "three" });
  expect(again.main.view).toStartWith('<notebook revision="3">\nthree\n</notebook>\nThe following chat is memory');
  expect(again.main.messages).toEqual([]);
});

test("the first message of an epoch starts with the notebook block, before the view", async () => {
  const { main } = await serve();
  expect(main.view).toStartWith(block({ revision: 0, text: "" }) + "The following chat is memory");
  expect(block({ revision: 0, text: "" })).toContain("Your notebook is empty");
});

test("a subagent gets the notebook block first and no notebook_edit tool", async () => {
  const { main, edit, engine } = await serve();
  edit([{ old: "", new: "- Editor: helix" }]);
  main.options.subagents!.spawn([{ name: "helper", task: "Find the answer" }]);
  const child = engine.epochs[1]!;
  expect(child.view).toStartWith('<notebook revision="1">\n- Editor: helix\n</notebook>\nThe following chat is memory');
  expect(child.options.notebook).toBeUndefined();
  expect(child.options.append).toContain("The notebook is read-only for you");
});

test("the user's edit reaches the epoch once, with the next input", async () => {
  const { client, main, edit } = await serve();
  await say(client, "first");
  await save(client, "- Editor: helix", 0);
  await say(client, "second");
  await say(client, "third");
  expect(main.messages.map((message) => message.text)).toEqual([
    "first",
    "second\n\nNotebook update from membr: the user changed the notebook to revision 1:\n+ - Editor: helix",
    "third",
  ]);
  edit([{ old: "helix", new: "neovim" }]);
  await say(client, "fourth");
  expect(main.messages.at(-1)?.text).toBe("fourth");
});

test("an agent edit sends no notice, and a user edit that follows is a diff from the text the epoch has", async () => {
  const { client, main, edit } = await serve();
  edit([{ old: "", new: "a\nb" }]);
  await revision(client, 1);
  await save(client, "a\nb\nc", 1);
  edit([{ old: "a", new: "A" }]);
  await say(client, "go");
  expect(main.messages[0]?.text).toBe("go\n\nNotebook update from membr: the user changed the notebook to revision 2:\n+ c");
});

test("a user edit over 2 KB reaches the epoch as the whole block", async () => {
  const { client, main } = await serve();
  const text = Array.from({ length: 100 }, (_, i) => `- line ${i} with some words`).join("\n");
  await save(client, text, 0);
  await say(client, "go");
  expect(main.messages[0]?.text).toBe(`go\n\nNotebook update from membr: the user changed the notebook to revision 1:\n${block({ revision: 1, text })}`);
});

test("the goal check gets the notebook block before the chat", async () => {
  const { client, engine, edit } = await serve();
  edit([{ old: "", new: "- Editor: helix" }]);
  client.act({ type: "act", act: "goal", id: "goal", text: "Finish" });
  await say(client, "start");
  expect(engine.checks[0]?.chat).toStartWith('<notebook revision="1">\n- Editor: helix\n</notebook>\n<chat>');
});

test("GET notebook.md gives the text as markdown, and export includes the notebook", async () => {
  const { hub, client, edit } = await serve();
  edit([{ old: "", new: "# Notes\n- Editor: helix" }]);
  await client.wait("notebook", 0, (event) => event.notebook.revision === 1);
  const response = await fetch(new URL("/membr/default/notebook.md", hub.server.url), { headers: { authorization: `Bearer ${hub.token}` } });
  expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="default-notebook.md"');
  expect(await response.text()).toBe("# Notes\n- Editor: helix");
  const exported = await (await fetch(new URL("/membr/default/export", hub.server.url), { headers: { authorization: `Bearer ${hub.token}` } })).json();
  expect(exported.notebook).toMatchObject({ revision: 1, text: "# Notes\n- Editor: helix" });
});

test("a line diff shows removed and added lines and drops the lines both sides share", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toBe("- b\n+ B\n+ d");
  expect(lineDiff("", "x")).toBe("+ x");
  expect(lineDiff("x", "")).toBe("- x");
});
