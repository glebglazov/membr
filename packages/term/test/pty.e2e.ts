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
      { ...END, reply: "Reviewed src/app.ts. No problems found.", usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 } },
    );
  } else epoch.emit({ kind: "delta", text: "Thinking about it" });
});
engine.compactUsage = { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 };
engine.skills = [{ name: "review", description: "Review a change", argumentHint: "<path>" }];
const server = await startHub(engine);

const command = process.env.MEMBR_BIN ? [path.resolve(process.env.MEMBR_BIN)] : ["bun", path.join(root, "packages/server/src/main.ts")];
tmux("new-session", "-d", "-s", "e2e", "-x", "100", "-y", "30", "-c", root, [...command, server.url].join(" "));
try {
  show("connected", await waitFor("Ready", (t) => t.includes("Ready")));

  keys("/");
  show("typing /", await waitFor("the command menu", (t) => t.includes("/goal <message>") && t.includes("Set a goal")));
  keys("rev");
  show("typing /rev", await waitFor("the skill alone", (t) => t.includes("/review <path>") && t.includes("Review a change") && !t.includes("/goal")));
  keys("Tab");
  await waitFor("the completed name", (t) => t.includes("> /review") && !t.includes("Review a change"));
  keys("src/app.ts", "Enter");
  const turn = await waitFor("the skill turn", (t) => t.includes("Reviewed src/app.ts. No problems found.") && t.includes("compression 100 sent, 90% cached"));
  show("after /review src/app.ts", turn);
  if (engine.epochs[0].messages[0].text !== "/review src/app.ts") throw new Error("The skill did not reach the agent as a say act");
  if (!turn.includes("> Made 1 tool call: Read")) throw new Error("The tool call is not collapsed into a brief");

  keys("first line");
  keys("C-j");
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
