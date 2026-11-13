import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { complete, createModel, hear } from "@membr/core";
import { App } from "../src/app.ts";
import { EMPTY_COMPOSER, edit, insert, layout } from "../src/composer.ts";
import { openEditor, terminalInput, type MouseEvent } from "../src/terminal.ts";
import { markdown, wrap } from "../src/transcript.ts";
import { connectSession, type Session } from "../src/session.ts";
import { PassThrough } from "node:stream";
import { END, FakeEngine, type FakeEpoch } from "../../server/test/engine.ts";
import { startHub } from "./hub.ts";
import { Log } from "../../server/src/log.ts";
import { PAGE } from "../../server/src/view.ts";
import { defaultStore } from "../../server/test/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const none = { start: 0, commands: [] };

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function open(engine: FakeEngine) {
  const server = await startHub(engine);
  const session = connectSession({ url: server.url, token: null, delays: [50] });
  const screen = render(createElement(App, { session }));
  cleanups.push(() => screen.unmount(), () => session.close(), () => server.close(), () => server.remove());
  return { server, session, screen };
}

async function until<T>(check: () => T | false | undefined, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const frame = (screen: ReturnType<typeof render>) => screen.lastFrame() ?? "";
const type = async (screen: ReturnType<typeof render>, text: string) => { for (const char of text) { screen.stdin.write(char); await Bun.sleep(5); } };

test("typing / offers membr commands and skills, Tab takes one, Enter sends the skill as a say act", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "Reviewing now" }, { ...END, reply: "Reviewing now" }));
  engine.skills = [{ name: "review", description: "Review a change", argumentHint: "<path>" }];
  const { screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");

  await type(screen, "/");
  await until(() => frame(screen).includes("/goal <message>"), "the menu");
  await type(screen, "rev");
  await until(() => frame(screen).includes("/review <path>") && !frame(screen).includes("/goal"), "the menu to narrow to the skill");
  screen.stdin.write("\t");
  await until(() => frame(screen).includes("> /review") && !frame(screen).includes("Review a change"), "the completed name");
  await type(screen, "src/app.ts");
  screen.stdin.write("\r");

  await until(() => engine.epochs[0]?.messages.length, "the message to reach the engine");
  expect(engine.epochs[0].messages[0].text).toBe("/review src/app.ts");
  await until(() => frame(screen).includes("> /review src/app.ts") && frame(screen).includes("Reviewing now"), "the turn on screen");
});

test("a membr command runs locally: /help shows the commands and sends nothing", async () => {
  const engine = new FakeEngine();
  const { screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");
  await type(screen, "/help");
  screen.stdin.write("\r");
  await until(() => frame(screen).includes("/halt  Clear the goal"), "the help text");
  expect(engine.epochs[0]?.messages ?? []).toEqual([]);
});

test("Escape stops a busy turn, and the status line follows the turn", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "delta", text: "Thinking aloud" }));
  const { screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");
  await type(screen, "work");
  screen.stdin.write("\r");
  await until(() => frame(screen).includes("Working") && frame(screen).includes("Thinking aloud"), "the busy turn");
  screen.stdin.write("\x1b");
  await until(() => engine.epochs[0].interrupts > 0, "the interrupt");
});

test("an approval is answered with a key and the tool call goes ahead", async () => {
  const engine = new FakeEngine();
  const { screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");
  const ask = engine.epochs[0].options.ask!;
  const decision = ask("Bash", { command: "echo hello" }, new AbortController().signal);
  await until(() => frame(screen).includes("Allow Bash?") && frame(screen).includes("echo hello"), "the approval");
  screen.stdin.write("o");
  expect(await decision).toBe(true);
  await until(() => !frame(screen).includes("Allow Bash?"), "the approval to close");
});

test("a lost connection shows offline, then reconnects and resends the pending act on ready", async () => {
  const first = await startHub(new FakeEngine((epoch) => epoch.emit(END)));
  const session = connectSession({ url: first.url, token: null, delays: [50] });
  cleanups.push(() => session.close(), () => first.remove());
  await until(() => session.model().connection === "ready", "ready");
  await first.close();
  await until(() => session.model().connection !== "ready", "the drop");
  session.input({ type: "send", id: "kept", text: "sent while offline" });
  expect(session.model().pending.has("kept")).toBe(true);

  const engine = new FakeEngine((epoch) => epoch.emit(END));
  const second = await startHub(engine, { dir: first.dir, port: first.port });
  cleanups.push(() => second.close());
  await until(() => engine.epochs[0]?.messages.length, "the pending act to arrive after the reconnect");
  expect(engine.epochs[0].messages[0].text).toBe("sent while offline");
  await until(() => session.model().connection === "ready" && !session.model().pending.has("kept"), "the act to be answered");
});

test("composer keys: newline variants, backslash continuation, paste, and menu navigation", () => {
  const model = hear(createModel(), { type: "skills", skills: [{ name: "quest", description: "Quest", argumentHint: "" }] });
  let composer = insert(EMPTY_COMPOSER, "a");
  composer = edit(composer, { input: "", return: true, shift: true }, none).composer;
  composer = edit(composer, { input: "b" }, none).composer;
  composer = edit(composer, { input: "j", ctrl: true }, none).composer;
  composer = edit(composer, { input: "c\\" }, none).composer;
  composer = edit(composer, { input: "", return: true }, none).composer;
  expect(composer.text).toBe("a\nb\nc\n");
  expect(edit(composer, { input: "", return: true }, none).submit).toBe("a\nb\nc\n");

  composer = insert(EMPTY_COMPOSER, "/qu");
  const menu = complete(model, composer.text, composer.cursor);
  expect(menu.commands[0].name).toBe("/quest");
  expect(edit(composer, { input: "", tab: true }, menu).composer.text).toBe("/quest ");

  const middle = { ...insert(EMPTY_COMPOSER, "please run /qu then"), cursor: 14 };
  const offered = complete(model, middle.text, middle.cursor);
  expect(offered.commands.map((command) => command.name)).toEqual(["/quest"]);
  const taken = edit(middle, { input: "", tab: true }, offered).composer;
  expect(taken.text).toBe("please run /quest then");
  expect(taken.cursor).toBe(18);
});

test("up and down walk the sent messages and give back the draft; up and down move inside a multi-line message first", () => {
  const history = ["first", "one\ntwo"];
  const press = (composer: typeof EMPTY_COMPOSER, key: "upArrow" | "downArrow") => edit(composer, { input: "", [key]: true }, none, history).composer;
  let composer = insert(EMPTY_COMPOSER, "draft");
  composer = press(composer, "upArrow");
  expect(composer.text).toBe("one\ntwo");
  composer = press(composer, "upArrow");
  expect(composer.text).toBe("first");
  composer = press(composer, "upArrow");
  expect(composer.text).toBe("first");
  composer = press(composer, "downArrow");
  expect(composer).toMatchObject({ text: "one\ntwo", cursor: 7 });
  composer = press(composer, "upArrow");
  expect(composer).toMatchObject({ text: "one\ntwo", cursor: 3 });
  composer = press(composer, "downArrow");
  composer = press(composer, "downArrow");
  expect(composer).toMatchObject({ text: "draft", recall: null });
  expect(press(EMPTY_COMPOSER, "downArrow")).toEqual(EMPTY_COMPOSER);

  const menu = { start: 0, commands: [{ name: "/help", hint: "", description: "Help" }, { name: "/halt", hint: "", description: "Halt" }] };
  const recalled = edit(EMPTY_COMPOSER, { input: "", upArrow: true }, none, ["/help"]).composer;
  expect(edit(recalled, { input: "", downArrow: true }, menu, ["/help"]).composer.text).toBe("");
  expect(edit(insert(EMPTY_COMPOSER, "/h"), { input: "", downArrow: true }, menu, ["/help"]).composer).toMatchObject({ text: "/h", pick: 1 });
});

test("Ctrl, Option and Cmd with left and right move by word and to the line's ends", () => {
  const at = (cursor: number) => ({ ...insert(EMPTY_COMPOSER, "say hello  world\nnext"), cursor });
  const move = (cursor: number, press: Parameters<typeof edit>[1]) => edit(at(cursor), press, none).composer.cursor;
  expect(move(16, { input: "", leftArrow: true, ctrl: true })).toBe(11);
  expect(move(11, { input: "", leftArrow: true, meta: true })).toBe(4);
  expect(move(11, { input: "b", meta: true })).toBe(4);
  expect(move(4, { input: "", rightArrow: true, ctrl: true })).toBe(9);
  expect(move(9, { input: "f", meta: true })).toBe(16);
  expect(move(16, { input: "", rightArrow: true, meta: true })).toBe(21);
  expect(move(7, { input: "", leftArrow: true, super: true })).toBe(0);
  expect(move(7, { input: "", rightArrow: true, super: true })).toBe(16);
  expect(move(7, { input: "", leftArrow: true })).toBe(6);
});

test("Ctrl, Option and Cmd with Backspace erase a word back and to the line's start", async () => {
  const at = (cursor: number) => ({ ...insert(EMPTY_COMPOSER, "first\nsay hello  world"), cursor });
  const erase = (cursor: number, press: Parameters<typeof edit>[1]) => edit(at(cursor), press, none).composer;
  expect(erase(22, { input: "", backspace: true, ctrl: true })).toMatchObject({ text: "first\nsay hello  ", cursor: 17 });
  expect(erase(17, { input: "", backspace: true, meta: true })).toMatchObject({ text: "first\nsay world", cursor: 10 });
  expect(erase(15, { input: "", backspace: true, super: true })).toMatchObject({ text: "first\n  world", cursor: 6 });
  expect(erase(22, { input: "", backspace: true })).toMatchObject({ text: "first\nsay hello  worl", cursor: 21 });

  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream;
  const terminal = terminalInput(stdin, { write: () => true } as unknown as NodeJS.WriteStream);
  cleanups.push(() => terminal.close());
  const keys: string[] = [];
  terminal.stdin.on("data", (chunk) => keys.push(String(chunk)));
  stdin.write("a\bb\x7f");
  await until(() => keys.join("") === "a\x1b[127;5ub\x7f", "Ctrl+H as Ctrl+Backspace");
});

test("Up in an empty composer brings back the last message sent, and Enter sends it again", async () => {
  const engine = new FakeEngine((epoch) => epoch.emit({ kind: "text", text: "ok" }, { ...END, reply: "ok" }));
  const { screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");
  await type(screen, "hello there");
  screen.stdin.write("\r");
  await until(() => frame(screen).includes("  ok") && frame(screen).includes("Ready"), "the reply");
  screen.stdin.write("\x1b[A");
  await until(() => frame(screen).includes("> hello there"), "the recalled message");
  screen.stdin.write("\r");
  await until(() => engine.epochs[0]?.messages.length === 2, "the second send");
  expect(engine.epochs[0].messages[1].text).toBe("hello there");
});

test("the mouse wheel scrolls the transcript, new lines leave the screen in place, and the jump line goes back to the bottom", async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream;
  const written: string[] = [];
  const stdout = { write: (text: string) => written.push(text) } as unknown as NodeJS.WriteStream;
  const mouse = terminalInput(stdin, stdout);
  cleanups.push(() => mouse.close());
  const keys: string[] = [], events: MouseEvent[] = [];
  mouse.stdin.on("data", (chunk) => keys.push(String(chunk)));
  mouse.mouse((event) => events.push(event));
  stdin.write("a\x1b[<64;10;5Mb\x1b[<65;10;5M\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<");
  stdin.write("80;1;1Mc");
  await until(() => keys.join("") === "abc", "the keys");
  expect(events).toEqual([{ kind: "wheel", lines: 3 }, { kind: "wheel", lines: -3 }, { kind: "click", row: 1 }, { kind: "wheel", lines: 3 }]);
  expect(written.join("")).toContain("\x1b[?1006h\x1b[>4;2m");
  mouse.close();
  expect(written.join("")).toContain("\x1b[?1006l");

  const long = (text: string) => `${text} reply\n` + Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\n");
  const reply = (epoch: FakeEpoch, text: string) => epoch.emit({ kind: "text", text: long(text) }, { ...END, reply: long(text) });
  // The reply to "later" waits, so it comes in while the reader is scrolled up.
  const engine = new FakeEngine((epoch, message) => { if (message.text !== "later") reply(epoch, message.text); });
  const server = await startHub(engine);
  const session = connectSession({ url: server.url, token: null, delays: [50] });
  let send: ((event: MouseEvent) => void) | null = null;
  const scroll = (lines: number) => send!({ kind: "wheel", lines });
  const app = render(createElement(App, { session, mouse: (listener) => { send = listener; return () => { send = null; }; } }));
  cleanups.push(() => app.unmount(), () => session.close(), () => server.close(), () => server.remove());
  await until(() => frame(app).includes("Ready"), "ready");
  await type(app, "ping");
  app.stdin.write("\r");
  await until(() => frame(app).includes("line 39") && !frame(app).includes("ping reply"), "the reply at the bottom");
  for (let i = 0; i < 20; i++) scroll(3);
  await until(() => frame(app).includes("ping reply") && !frame(app).includes("line 39") && frame(app).includes("↓ Jump to bottom · Ctrl+X g"), "the top of the reply");
  for (let i = 0; i < 20; i++) scroll(-3);
  await until(() => frame(app).includes("line 39") && !frame(app).includes("Jump to bottom"), "the bottom again");

  for (let i = 0; i < 20; i++) scroll(3);
  await until(() => frame(app).includes("Jump to bottom"), "the scroll up again");
  app.stdin.write("\x18");
  await Bun.sleep(20);
  app.stdin.write("g");
  await until(() => frame(app).includes("line 39") && !frame(app).includes("Jump to bottom"), "Ctrl+X g to go to the bottom");
  expect(frame(app)).not.toContain("> g");

  await type(app, "later");
  app.stdin.write("\r");
  await until(() => engine.epochs[0]?.messages.length === 2, "the second message");
  for (let i = 0; i < 20; i++) scroll(3);
  await until(() => frame(app).includes("ping reply") && frame(app).includes("Jump to bottom"), "the top of the chat");
  const screen = () => frame(app).split("\n").slice(0, 10).join("\n");
  const before = screen();
  reply(engine.epochs[0], "later");
  await until(() => [...session.model().entries.values()].some((entry) => entry.text.startsWith("later reply")) && frame(app).includes("↓ Jump to bottom (new messages) · Ctrl+X g"), "the reply below the screen");
  expect(screen(), "the lines on screen stay when the reply comes in below them").toBe(before);
  const row = frame(app).split("\n").findIndex((line) => line.includes("Jump to bottom")) + 1;
  const jumpLine = frame(app).split("\n")[row - 1].trimEnd();
  const left = jumpLine.length - jumpLine.trimStart().length, right = frame(app).split("\n").find((line) => line.startsWith("─"))!.length - jumpLine.length;
  expect(Math.abs(left - right), "the jump line is in the middle of the row").toBeLessThanOrEqual(1);
  send!({ kind: "click", row: row + 1 });
  await Bun.sleep(50);
  expect(frame(app), "a click on another row does nothing").toContain("Jump to bottom");
  send!({ kind: "click", row });
  await until(() => frame(app).includes("line 39") && !frame(app).includes("Jump to bottom"), "a click on the jump line to go to the bottom");
});

test("scrolling to the top of a long chat loads the older page and leaves the same lines on screen", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "membr-term-long-"));
  const log = new Log(defaultStore(dir));
  const count = PAGE * 2 + 30, name = (i: number) => `Message ${String(i).padStart(4, "0")}`;
  for (let i = 0; i < count; i++) log.append(i % 2 ? "unii" : "user", name(i));
  const server = await startHub(new FakeEngine(), { dir });
  const session = connectSession({ url: server.url, token: null, delays: [50] });
  let send: ((event: MouseEvent) => void) | null = null;
  const scroll = (lines: number) => send!({ kind: "wheel", lines });
  const app = render(createElement(App, { session, mouse: (listener) => { send = listener; return () => { send = null; }; } }));
  cleanups.push(() => app.unmount(), () => session.close(), () => server.close(), () => server.remove());
  await until(() => frame(app).includes(name(count - 1)), "the latest message");
  expect(session.model().from).toBe(count - PAGE);
  scroll(100_000);
  await until(() => frame(app).includes("Jump to bottom") && !frame(app).includes(name(count - 1)), "the top of the loaded chat");
  const top = frame(app);
  await until(() => session.model().from < count - PAGE, "the older page");
  await Bun.sleep(100);
  expect(frame(app), "the same lines stay on screen after the page loads").toBe(top);
  await until(() => { scroll(100_000); return frame(app).includes(name(0)); }, "the first message");
  expect(session.model().from).toBe(0);
});

test("Ctrl+G edits the composer text in the editor and puts the saved text back", async () => {
  const engine = new FakeEngine();
  const server = await startHub(engine);
  const session = connectSession({ url: server.url, token: null, delays: [50] });
  const opened: string[] = [];
  const app = render(createElement(App, { session, editor: (text) => { opened.push(text); return text + "\nfrom the editor"; } }));
  cleanups.push(() => app.unmount(), () => session.close(), () => server.close(), () => server.remove());
  await until(() => frame(app).includes("Ready"), "ready");
  await type(app, "draft");
  app.stdin.write("\x07");
  await until(() => frame(app).includes("> draft") && frame(app).includes("  from the editor"), "the edited text");
  expect(opened).toEqual(["draft"]);

  const previous = process.env.VISUAL;
  process.env.VISUAL = "printf ' saved\\n' >>";
  try { expect(openEditor("draft")).toBe("draft saved"); } finally { if (previous === undefined) delete process.env.VISUAL; else process.env.VISUAL = previous; }
  process.env.VISUAL = "false";
  try { expect(openEditor("draft")).toBeNull(); } finally { if (previous === undefined) delete process.env.VISUAL; else process.env.VISUAL = previous; }
});

test("membr accepts the sign-in link that membr status prints", async () => {
  const { socketUrl } = await import("../src/run.ts");
  expect(socketUrl("https://host.ts.net:8788/?token=abc")).toEqual({ url: "wss://host.ts.net:8788/ws", token: "abc", agent: "default" });
  expect(socketUrl("ws://127.0.0.1:8788/ws")).toEqual({ url: "ws://127.0.0.1:8788/ws", token: null, agent: "default" });
  expect(socketUrl("https://host.ts.net/membr/research")).toEqual({ url: "wss://host.ts.net/membr/research/ws", token: null, agent: "research" });
  expect(socketUrl("http://127.0.0.1:8788/membr/research/?token=t")).toEqual({ url: "ws://127.0.0.1:8788/membr/research/ws", token: "t", agent: "research" });
});


test("/schedule saves the schedule at once, shows the time membr read, and /schedules lists it", async () => {
  const engine = new FakeEngine();
  engine.onWhen = async () => ({ when: { kind: "cron", expr: "30 8 * * 1-5", zone: "Europe/London" }, phrase: "every weekday 8:30" });
  const { session, screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");
  await type(screen, "/schedule every weekday 8:30 read the inbox notes");
  screen.stdin.write("\r");
  await until(() => frame(screen).includes('Scheduled cron "30 8 * * 1-5" Europe/London, as a subagent: read the inbox notes'), "the saved schedule");
  expect(frame(screen)).toMatch(/Next: \w{3} 08:30, \w{3} 08:30, \w{3} 08:30\. Use \/unschedule to delete it\./);
  expect(engine.whens[0].text).toBe("every weekday 8:30 read the inbox notes");
  expect(session.model().schedules).toMatchObject([{ phase: "active", author: "user" }]);
  await type(screen, "/schedules");
  screen.stdin.write("\r");
  await until(() => frame(screen).includes("1. "), "the numbered list");
  expect(session.model().info).toMatch(/^1\. \w+  cron "30 8 \* \* 1-5" Europe\/London  active, subagent/);
});

test("/pause and /resume act on a listed schedule", async () => {
  const engine = new FakeEngine();
  engine.onWhen = async () => ({ when: { kind: "cron", expr: "0 9 * * *", zone: "UTC" }, phrase: "daily at 9" });
  const { session, screen } = await open(engine);
  await until(() => frame(screen).includes("Ready"), "ready");
  await type(screen, "/schedule daily at 9 check mail");
  screen.stdin.write("\r");
  await until(() => session.model().schedules.length === 1, "the schedule");
  await type(screen, "/pause 1");
  screen.stdin.write("\r");
  await until(() => session.model().schedules[0].phase === "paused", "the pause");
  await type(screen, "/resume 1");
  screen.stdin.write("\r");
  await until(() => session.model().schedules[0].phase === "active", "the resume");
});

test("the composer moves a word that does not fit to the next row, and cuts only a word longer than the row", () => {
  const rows = (text: string, cursor: number, width: number) => layout({ ...EMPTY_COMPOSER, text, cursor }, width).map((line) => line.cursor ? `${line.before}[${line.at}]${line.after}` : line.before);
  expect(rows("say the end", 11, 5)).toEqual(["say ", "the ", "end[ ]"]);
  expect(rows("abc the", 7, 5)).toEqual(["abc ", "the[ ]"]);
  expect(rows("hello world", 0, 5), "A word that fills the row hides the space after it.").toEqual(["[h]ello", "world"]);
  expect(rows("hello world", 5, 5), "The cursor on that hidden space shows on its own row.").toEqual(["hello", "[ ]", "world"]);
  expect(rows("hello world", 6, 5)).toEqual(["hello", "[w]orld"]);
  expect(rows("abcdefgh ij", 11, 5)).toEqual(["abcde", "fgh ", "ij[ ]"]);
  expect(rows("abcde\nfg", 5, 5), "A full row that ends a line keeps the cursor inside the width.").toEqual(["abcde", "[ ]", "fg"]);
});

test("a reply draws **bold** and `code` without their markers, and wraps by the text it shows", () => {
  const drawn = (text: string, width: number) => markdown(text, width, "plain").map((line) => line.spans!.map((span) => span.bold && span.code ? `<B${span.text}B>` : span.bold ? `<b${span.text}b>` : span.code ? `<c${span.text}c>` : span.text).join(""));
  expect(drawn("Run **the tests** with `bun test` now", 40)).toEqual(["  Run <bthe testsb> with <cbun testc> now"]);
  expect(drawn("**one two three four**", 12), "Markers do not count toward the width.").toEqual(["  <bone twob>", "  <bthree fourb>"]);
  expect(drawn("**use `x` here**", 40)).toEqual(["  <buse b><BxB><b hereb>"]);
  expect(drawn("```\na **b** `c`\n```\n**d**", 40), "Text in a code block keeps its markers.").toEqual(["  ```", "  <ca **b** `c`c>", "  ```", "  <bdb>"]);
  expect(drawn("2 ** 3 and a lone ` stay", 40)).toEqual(["  2 ** 3 and a lone ` stay"]);
  expect(wrap("  a  b " + "x".repeat(7) + " c", 5), "Plain wrapping keeps its old rows.").toEqual(["a  b", "xxxxx", "xx c"]);
});
