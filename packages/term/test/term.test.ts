import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { complete, createModel, hear } from "@membr/core";
import { App } from "../src/app.ts";
import { EMPTY_COMPOSER, edit, insert } from "../src/composer.ts";
import { connectSession, type Session } from "../src/session.ts";
import { END, FakeEngine } from "../../server/test/engine.ts";
import { startHub } from "./hub.ts";

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
  await until(() => frame(screen).includes("  /review src/app.ts") && frame(screen).includes("Reviewing now"), "the turn on screen");
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
  const model = hear(createModel(), { type: "skills", skills: [{ name: "plan", description: "Plan", argumentHint: "" }] });
  let composer = insert(EMPTY_COMPOSER, "a");
  composer = edit(composer, { input: "", return: true, shift: true }, []).composer;
  composer = edit(composer, { input: "b" }, []).composer;
  composer = edit(composer, { input: "j", ctrl: true }, []).composer;
  composer = edit(composer, { input: "c\\" }, []).composer;
  composer = edit(composer, { input: "", return: true }, []).composer;
  expect(composer.text).toBe("a\nb\nc\n");
  expect(edit(composer, { input: "", return: true }, []).submit).toBe("a\nb\nc\n");

  composer = insert(EMPTY_COMPOSER, "/p");
  const menu = complete(model, composer.text);
  expect(menu[0].name).toBe("/plan");
  expect(edit(composer, { input: "", tab: true }, menu).composer.text).toBe("/plan ");
});

test("membr term accepts the sign-in link that membr serve prints", async () => {
  const { socketUrl } = await import("../src/run.ts");
  expect(socketUrl("https://host.ts.net:8788/?token=abc")).toEqual({ url: "wss://host.ts.net:8788/ws", token: "abc" });
  expect(socketUrl("ws://127.0.0.1:8788/ws")).toEqual({ url: "ws://127.0.0.1:8788/ws", token: null });
});
