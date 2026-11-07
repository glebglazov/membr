// Drives the real `membr URL` in a tmux pane against the real hub over a fake Engine, and asserts on the screen text.
// MEMBR_BIN=dist/membr runs the compiled binary instead of the sources.
import path from "node:path";
import { END, FakeEngine } from "../../server/test/engine.ts";
import { startHub } from "./hub.ts";

const root = path.join(import.meta.dir, "../../..");
const socket = `membr-term-e2e-${process.pid}`;
const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout.toString();
const screen = () => tmux("capture-pane", "-p", "-t", "e2e").replace(/\s+$/g, "");
// One key press per write, as a typist produces; a chunk like "text\r" would be read as a paste.
const keys = (...args: string[]) => { for (const arg of args) { tmux("send-keys", "-t", "e2e", arg); Bun.sleepSync(30); } };

async function waitFor(what: string, check: (text: string) => boolean): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const text = screen();
    if (check(text)) return text;
    await Bun.sleep(25);
  }
  console.log(screen());
  throw new Error(`Timed out waiting for ${what}`);
}
const show = (title: string, text: string) => console.log(`\n=== ${title} ===\n${text}`);

const engine = new FakeEngine((epoch, message) => {
  if (message.text.startsWith("/review")) {
    epoch.emit(
      { kind: "tool", id: "t1", name: "Read", input: { file_path: "src/app.ts" } },
      { kind: "echo", id: "t1", text: "file contents ".repeat(50), error: false },
      { kind: "text", text: "Reviewed src/app.ts. No problems found." },
      { ...END, reply: "Reviewed src/app.ts. No problems found.", usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 }, context: { used: 42_000, window: 200_000 } },
    );
  } else if (message.text === "long") {
    const text = Array.from({ length: 60 }, (_, n) => `long line ${n}`).join("\n");
    epoch.emit({ kind: "text", text }, { ...END, reply: text });
  } else epoch.emit({ kind: "delta", text: "Thinking about it" });
});
engine.compactUsage = { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 };
engine.skills = [{ name: "review", description: "Review a change", argumentHint: "<path>" }];
const server = await startHub(engine);

const command = process.env.MEMBR_BIN ? [path.resolve(process.env.MEMBR_BIN)] : ["bun", path.join(root, "packages/server/src/main.ts")];
tmux("-f", "/dev/null", "new-session", "-d", "-s", "e2e", "-x", "100", "-y", "30", "-c", root, ["env", "EDITOR='vim -u NONE -N'", ...command, server.url].join(" "),
  // As in a tmux that sends Shift+Enter and other modified keys only to an app that asks for them.
  ";", "set", "-s", "extended-keys", "on", ";", "set", "-s", "extended-keys-format", "csi-u");
try {
  show("connected", await waitFor("Ready", (t) => t.includes("Ready")));

  keys("/");
  show("typing /", await waitFor("the command menu", (t) => t.includes("/goal <message>") && t.includes("Set a goal")));
  keys("rev");
  show("typing /rev", await waitFor("the skill alone", (t) => t.includes("/review <path>") && t.includes("Review a change") && !t.includes("/goal")));
  keys("Tab");
  await waitFor("the completed name", (t) => t.includes("> /review") && !t.includes("Review a change"));
  keys("src/app.ts", "Enter");
  const turn = await waitFor("the skill turn", (t) => t.includes("Reviewed src/app.ts. No problems found.") && t.includes("epoch 42k / 160k (26%)"));
  show("after /review src/app.ts", turn);
  if (engine.epochs[0].messages[0].text !== "/review src/app.ts") throw new Error("The skill did not reach the agent as a say act");
  if (!turn.includes("> Made 1 tool call: Read")) throw new Error("The tool call is not collapsed into a brief");

  keys("please run /rev");
  show("typing mid-prompt", await waitFor("the skill alone", (t) => t.includes("/review <path>") && !t.includes("/goal")));
  keys("Tab");
  await waitFor("the name in place", (t) => t.includes("> please run /review") && !t.includes("Review a change"));
  keys("C-u");
  await waitFor("the composer to clear", (t) => !t.includes("please run"));
  keys("first line");
  keys("S-Enter");
  keys("second line");
  show("multi-line composer", await waitFor("two lines", (t) => t.includes("> first line") && t.includes("second line")));
  keys("Enter");
  show("busy turn", await waitFor("the busy turn", (t) => t.includes("Thinking about it") && t.includes("Working")));
  keys("Escape");
  for (let i = 0; i < 100 && engine.epochs[0].interrupts === 0; i++) await Bun.sleep(25);
  if (engine.epochs[0].interrupts !== 1) throw new Error("Escape did not stop the turn");
  if (engine.epochs[0].messages[1].text !== "first line\nsecond line") throw new Error(`Wrong multi-line message: ${engine.epochs[0].messages[1].text}`);

  const decision = engine.epochs[0].options.ask!("Bash", { command: "rm -rf build" }, new AbortController().signal);
  show("approval", await waitFor("the approval", (t) => t.includes("Allow Bash?") && t.includes("[d] deny")));
  keys("d");
  if (await decision !== false) throw new Error("Deny did not reach the engine");
  await waitFor("the approval to close", (t) => !t.includes("Allow Bash?"));

  keys("long", "Enter");
  await waitFor("the long reply", (t) => t.includes("long line 59") && t.includes("Ready"));
  // A wheel-up report as the terminal sends it, then a key: the transcript scrolls and nothing of the report is typed.
  tmux("send-keys", "-t", "e2e", "-H", ..."\x1b[<64;10;10M".split("").map((c) => c.charCodeAt(0).toString(16)));
  show("wheel up", await waitFor("the scroll", (t) => t.includes("scrolled up 3") && !t.includes("long line 59")));
  keys("C-x", "g");
  await waitFor("Ctrl+X g to go to the bottom", (t) => t.includes("long line 59") && !t.includes("scrolled up") && !/^> g/m.test(t));
  keys("Up");
  const recalled = await waitFor("the recalled message", (t) => /^> long$/m.test(t));
  if (recalled.includes("[<")) throw new Error("The mouse report reached the composer");
  keys("C-e", "Space", "word", "M-b");
  keys("x");
  show("recall and Option+b", await waitFor("x before the last word", (t) => /^> long xword$/m.test(t)));
  // The screen capture drops trailing spaces: after Ctrl+Backspace the composer holds "long xword more ".
  keys("C-e", " more words", "C-BSpace");
  await waitFor("Ctrl+Backspace to erase a word", (t) => /^> long xword more$/m.test(t));
  keys("M-BSpace");
  show("Ctrl and Option with Backspace", await waitFor("Option+Backspace to erase a word", (t) => /^> long xword$/m.test(t)));

  // Ctrl+G opens the editor on the composer text; the text saved in vim comes back to the composer.
  keys("C-e", "C-u", "edit me", "C-g");
  await waitFor("vim", (t) => t.includes("message.txt") || t.includes("~"));
  keys("A", " in vim", "Escape", ":wq", "Enter");
  show("after the editor", await waitFor("the edited text", (t) => /^> edit me in vim$/m.test(t) && t.includes("Ready")));

  keys("C-c");
  for (let i = 0; i < 100 && tmux("list-panes", "-a").trim() !== ""; i++) await Bun.sleep(50);
  if (tmux("list-sessions").includes("e2e")) throw new Error("Ctrl-C did not quit membr");
  console.log("\nterm e2e passed");
} finally {
  tmux("kill-server");
  await server.close();
  server.remove();
}
process.exit(0);
