# membr

Chats with agents that never end: UniiChat's memory design, with Claude Code
as the engine through the Claude Agent SDK, on your own `claude` login. One
server holds many agents. Each agent has its own memory, its own system prompt
and its own home, which gives it its own skills and MCP servers.

## Start membr

Install [Bun](https://bun.sh), then:

```sh
bun install
bun packages/server/src/main.ts      # or: membr, after you install the binary
```

`membr` opens the chat with the agent `default` in this terminal.
`membr research` opens the chat with the agent `research`. If no server runs,
membr starts one and waits until it listens. On macOS, launchd runs the
server, so the server also starts at login and after a crash, and schedules
fire when no terminal is open. On other systems, run `membr server run` in a
terminal, then `membr ws://127.0.0.1:8788/membr/default/ws` in another one.

The server listens on `127.0.0.1:8788`. Open `http://127.0.0.1:8788/membr/` in
your browser to see the agents, and `http://127.0.0.1:8788/membr/research/` to
chat with one. The header of the chat has a list to change to another agent.
The page follows your OS light or dark setting. The server builds the Preact
assets on the first page request. `bun run build:web` also builds them in
`packages/web/dist`. To change the address, set `port`, `host` or `tailscale`
in `config.json` (see [Configure the server](#configure-the-server)).

Local connections need no token. For access from another device, set `host` to
the server's Tailscale or network address. Open the sign-in link that
`membr server status` prints. It sets an HttpOnly cookie for all agents and
removes the token from the address bar.

With `"tailscale": true`, the server is also on your tailnet, at
`https://<machine>.ts.net/membr/<name>/`. membr runs
`tailscale serve --https=443 --set-path=/membr` to forward that path to
`127.0.0.1`. `membr server status` shows the address of each agent. Tailnet
requests through it need no sign-in. The `tailscale serve` setting stays after
membr stops, and the next run uses it again. Turn it off with
`tailscale serve --https=443 --set-path=/membr off`.

These are the commands:

- `membr [AGENT]` opens the chat with an agent, `default` when you give no
  name, and starts the server first if it does not run.
- `membr URL [--token TOKEN]` connects to another server and starts nothing.
  The URL is the server's `ws://` or `http://` address, or the sign-in link
  that `membr server status` prints on that machine. A URL with
  `/membr/NAME` opens that agent; any other URL opens `default`.
- `membr agent list` shows each agent, whether it works on a turn now, its
  home and the first line of its prompt.
- `membr agent new NAME` adds the agent to `config.json`, opens the file in
  `$VISUAL` or `$EDITOR` so that you write its prompt, and reloads the server.
- `membr server start` starts the server with no chat.
- `membr server reload` reads `config.json` again. It prints the result. If
  the file has an error, it prints the error and exits with status 1.
- `membr server status` shows the PID, the address, the tailnet address, the
  sign-in link, the address of each agent, the launchd agent and the path of
  the log.
- `membr server stop` stops the server and removes the launchd agent. Then
  nothing starts the server until the next `membr`, also not a login. It also
  stops a server that `make run` started.
- `membr server run` runs the server in the foreground. launchd and
  `make run` use this command. It takes no options.

In the terminal chat, Enter sends a message. Shift+Enter, Ctrl+J, or a `\` at
the end of the line adds a new line. Ctrl+G opens the text in `$VISUAL`, or
`$EDITOR`, or `vim`. When you save and quit, the text comes back to the
composer. Type `/` to see the commands and skills, and use Tab to complete one.
A skill can be anywhere in the message. A command works only at the start.
Up on the first line shows the message you sent before. Down on the last line
goes forward, and then gives back the text you typed. Ctrl or Option with Left
or Right moves one word. Cmd with Left or Right goes to the start or the end of
the line. Ctrl or Option with Backspace erases one word, and Cmd+Backspace
erases to the start of the line. The mouse wheel, Page Up and Page Down scroll the chat. Ctrl+X and
then g goes back to the bottom. Because membr reads the mouse, hold Option
(iTerm2, Terminal) or Shift (Ghostty, kitty, WezTerm) to select text. Press o,
a or d to answer an approval. Esc stops the turn, and Ctrl+C quits. The memory
tree, the subagent logs, imports and images are only in the web view.

membr keeps its data in `~/.local/share/membr`, the base directory, or in the
directory that `MEMBR_DIR` names. The base directory holds `config.json`, the
token, the lock, `serve.log`, and one directory for each agent under
`agents/`. One server at a time can use a base directory. A second server on
the same directory exits with status 1 and names the process that holds the
lock. `membr` uses a server that runs already, also one that `make run`
started.

Before membr held many agents, it kept its data in `~/.membr`. The first
server that starts in the default base directory moves that data one time:
the chat becomes the agent `default`, and `config.json` changes to the new
form (see [Configure the server](#configure-the-server)). If the base
directory has a `config.json` already, for example one that a dotfiles tool
wrote, membr keeps it and does not use the old one. If an old server
still runs on `~/.membr`, the new server stops with a message. Run
`membr server stop` with the old build, then `membr`.

Each base directory has its own launchd agent: `dev.membr.serve` for
`~/.local/share/membr`, and `dev.membr.serve.` with 8 hexadecimal characters
for another directory. The agent's plist is in `~/Library/LaunchAgents`. It
keeps your `PATH`, `MEMBR_DIR` and `MEMBR_CLAUDE_CLI` from the shell that runs
`membr`, because launchd starts with a short `PATH` and the server needs
`claude` (and `tailscale`) on it. When no server runs, `membr` writes the plist
again if it changed, for example after you move the repository or use a shell
with another `PATH`. membr never stops a server that runs to do this. To use a
new build, run `membr server stop`, then `membr`.

The server writes its output to `serve.log` in the base directory. If the
server does not start within 15 seconds, `membr` prints the end of that log.
launchd starts the server again after an exit that is not a clean exit, and
waits 10 seconds between starts. That includes a crash and a start that fails,
for example when Tailscale is not up yet after login.

`make run` installs the packages when they changed and runs
`membr server run` in the terminal. It cannot run beside a launchd server on
the same base directory, because the lock stops the second server. Run
`membr server stop` first, or set another `MEMBR_DIR`.

## Configure the server

The server reads `config.json` in the base directory. All keys are optional:

```json
{
  "port": 8788,
  "host": "127.0.0.1",
  "tailscale": true,
  "agents": {
    "default": {
      "home": "~/Documents/vault"
    },
    "research": {
      "prompt": [
        "You research papers for me.",
        "Write a one-page summary of each paper."
      ],
      "approvalTimeout": "30m"
    }
  }
}
```

- `port` is the port that the server listens on. The default is `8788`.
- `host` is the address that the server listens on. The default is
  `127.0.0.1`.
- `tailscale` puts the server on your tailnet when it is `true`. The default is
  `false`. It needs `host` to be `127.0.0.1`.
- `agents` has one entry for each agent. The key is the agent's name: a letter,
  then letters, digits, `-` or `_`, 64 characters at most. `server`, `agent`
  and `help` are membr commands, so they cannot be names. The agent `default`
  exists also when it has no entry.

The keys of an agent:

- `prompt` is the agent's system prompt, for example its task. Write a string,
  or a list of strings that membr joins with new lines. membr adds it after its
  own prompt, which teaches the agent to read its memory.
- `home` is the directory that the agent works in. Claude Code loads the
  harness from it: `CLAUDE.md`, the `.claude/` settings, skills, plugins and
  `.mcp.json`. A relative path starts at the base directory. If you do not set
  `home`, it is `agents/<name>/home/` in the base directory, so you can give a
  new agent its own skills and MCP servers there. If `home` is not a
  directory, the server does not start.
- `approvalTimeout` is how long a scheduled run waits for an approval. After
  that time, membr denies the tool call and writes a note in the chat. Write a
  number and a unit: `90s`, `10m` or `2h`. The default is `10m`, and the
  maximum is `24h`. An approval in a turn that you started waits until you
  answer it.

The agent's own files, its store, are in `agents/<name>/` in the base
directory, outside its home. No key moves them. Two agents can have the same
home.

To read `config.json` again while the server runs, run `membr server reload`,
or type `/reload` in any chat. `SIGHUP` to the server also reads it again. Then
all clients show an error in the file.

A new `port`, `host` or `tailscale` applies at once. The server moves to the
new address, and a turn that runs continues. Open clients lose the connection,
so open the chat again at the new address. If the server cannot listen on the
new address, it keeps the old config and `membr server reload` shows why. A new
agent entry starts the agent at once. A removed entry stops the agent and
closes its clients; its files stay in `agents/<name>/`. A new `approvalTimeout`
applies at once. A new `home` or `prompt` applies in a new epoch of that agent
only. If a turn runs, the new epoch starts when the turn ends. The server
writes a note in the agent's chat that tells the agent what changed. The first
turn in the new epoch reads the full view without the prompt cache, so it costs
more. If the file has an error, the server keeps the old config.
`membr server reload` and `/reload` show the error.

Large tool output stays in the epoch until the next summary batch. When a turn
ends with the epoch at 150k tokens or more, the next turn starts in a new
epoch. Past that size each request costs more and the model reads its context
less well. For a model with a window under 187,500 tokens, the limit is 80% of
the window, so the next turn still fits. If a turn makes the epoch too large for the model,
the turn fails with "Prompt is too long". membr then starts a new epoch and
writes a note in the chat. Send the message again. membr does not send it
again for you, because the turn's tool calls would run a second time.

## Schedule runs

A schedule starts a run at a set time, one time or again and again, when
nobody is at the screen. Type `/schedule` and the time and the task in plain
words:

```
/schedule every weekday 8:30 read the inbox notes and write a summary
```

membr finds the time words, and shows the cron and the time zone of your client
and the next three fire times. Press `a` in the terminal, or Accept on the web,
to keep the schedule. The task is your own words without the time words. A
fire sends it as your message, word for word.

- The web client has a Schedules page next to Chat and Memory. It can preview,
  accept, pause, resume and delete schedules. You can also set two options on
  it. "Run as" is a subagent (the default) or a turn in the main chat. "If
  missed" is "once" (the default) or "skip".
- `/schedules` lists the schedules. `/pause`, `/resume`, `/unschedule` and
  `/accept` take an id or a number from that list.
- A subagent run sends its report to the chat. A turn waits until the current
  turn ends. Fires of one schedule that come while the chat is busy become one
  run.
- If the server did not run at a fire time, or the Mac was asleep, "once" runs
  the newest missed fire one time, and a note says that it is late. "skip"
  writes a note and does not run it.
- The agent can propose a schedule with its `schedule` tool. It does not run
  until you accept it, and its fires come as membr's messages, not as yours.
  The agent can cancel only its own schedules.
- Fires happen only while the server runs. On macOS, launchd keeps it running
  (see [Start membr](#start-membr)).

## Install the standalone binary

Install Bun and run `bun install`, then build the binary:

```sh
bun run build
```

The build writes one executable to `dist/membr`. Copy that file to a directory
on your `PATH`, then run `membr`. The binary contains the web view and
needs no other project files. It stores data in `~/.local/share/membr`, or in the directory
that `MEMBR_DIR` names.

Install Claude Code and sign in on the host. The binary runs `claude` from your
`PATH`. Set `MEMBR_CLAUDE_CLI` if the executable has a different path.

## Run the tests

```sh
bun test
```

Run this from the repository root. It runs the tests of all packages,
including the check that the client core imports no DOM and no terminal code.

To run the browser checks, install Chromium once after `bun install`:

```sh
bunx playwright install chromium
```

Then run the browser checks with one command from the repository root:

```sh
bun run test:web
```

The checks start the real server with a fake Engine in a temporary data
directory. They check a live turn in two tabs, approval answers across tabs,
folder imports with estimates, pause and resume,
and light and dark layouts at desktop width and 390 px. They make no model calls.

The Engine contract tests run Claude Code on your plan, so `bun test` skips
them. To run them, set `MEMBR_REAL_SDK=1`:

```sh
MEMBR_REAL_SDK=1 bun test packages/server/engine.contract.test.ts
```

They write their measurements to `docs/p0-results.json`. The P0 report,
`docs/p0-report.md`, gives the result of each check.

## Packages

- `packages/protocol` holds the typed traffic between clients and the server.
- `packages/core` is the client core. It turns protocol events into a view
  model, with no DOM and no terminal code.
- `packages/web` is the web renderer. It draws the client core's view model.
- `packages/server` is the `membr` entry point and the server. Its Engine,
  `src/engine.ts`, is the only code that imports the Agent SDK.

## WebSocket protocol

Connect to `/membr/<name>/ws` for an agent. `/ws` is the agent `default`.
`membr server status` prints a sign-in link with the bearer token.
Supply that token in `Authorization: Bearer TOKEN`, the `token` query parameter,
the `token` cookie, or the hello message. If you supply more than one token,
all must match. The token stays in the base directory with mode `0600`.

Send hello first:

```json
{"type":"hello","version":"2.0","kind":"term","device":null,"token":"TOKEN"}
```

The server replays logged `entry` events, then sends `ready`. A different major
version gets `refused` with a reason. Both `web` and `term` use the same protocol.
A token supplied by the connection allows `"token":null` in hello. A local
connection to a loopback address also permits `"token":null`. Browser requests
must use the same origin as the page.

Send a message with an act id that remains the same across retries:

```json
{"type":"act","id":"message-1","act":"say","text":"Hello"}
```

Every connected client gets the same `entry`. The sender gets an `answer` with
its act id and the entry index. The server writes the entry and answer together
before it sends either event. A repeat act returns the first answer, including
after a restart. It never writes a second message for that id.

To read `config.json` again, send a `reload` act:

```json
{"type":"act","id":"reload-1","act":"reload"}
```

If the file has an error, the answer has `"ok":false` and the reason.

Before `ready`, the server sends a `skills` event. It lists the skills of the
server's harness, each with `name`, `description` and `argumentHint`:

```json
{"type":"skills","skills":[{"name":"review","description":"Review a change","argumentHint":"<file>"}]}
```

The server sends the event again when the list changes. Each event replaces the
earlier list. To run a skill, send a `say` act whose text starts with `/name`.
A skill named elsewhere in the text runs too, through the Skill tool.
The server sends that text to the agent as it is, with no notes added.

Before `ready`, the server also sends an `agents` event with every agent of the
server, and sends it again to all clients when an agent starts or ends a turn:

```json
{"type":"agents","agents":[{"name":"default","busy":false,"about":""},{"name":"research","busy":true,"about":"You research papers for me."}]}
```

`about` is the first line of the agent's prompt. `GET /membr/agents.json` gives
the same list.

Before `ready`, the server also sends a `schedules` event, and it sends the
event again after each change and each fire. Each event replaces the earlier
list. A schedule has `id`, `text`, `when` (`{"kind":"once","at":ISO}` or
`{"kind":"cron","expr":"30 8 * * 1-5","zone":"Europe/London"}`), `run`,
`missed`, `author`, `phase`, `since`, `next` (up to three ISO times) and
`last`. To turn plain words into a `when`, send a `when` read with the
client's time zone:

```json
{"type":"read","id":"when-1","read":"when","text":"every weekday 8:30 read the notes","zone":"Europe/London"}
```

The answer is a `when` event with the same id, the `when`, the task `text`
without the time words, and `next`. A text that membr cannot read gets an
`error` event with that id. Four acts change schedules:

```json
{"type":"act","id":"s-1","act":"schedule","schedule":{"text":"read the notes","when":{"kind":"cron","expr":"30 8 * * 1-5","zone":"Europe/London"},"run":"subagent","missed":"once"}}
{"type":"act","id":"s-2","act":"accept","schedule":"k3x9q2"}
{"type":"act","id":"s-3","act":"pause","schedule":"k3x9q2","paused":true}
{"type":"act","id":"s-4","act":"unschedule","schedule":"k3x9q2"}
```

Reads use their own request ids:

```json
{"type":"read","id":"tree-1","read":"roots"}
{"type":"read","id":"message-1","read":"zoom","part":{"l":0,"i":0}}
```

A `read` event returns the request id, `parts` and `entries`. Level zero names
one message. Higher levels name a block of `2 ** l` messages at `i * 2 ** l`.
`packages/protocol/src/index.ts` defines all message types and their boundary
parsers. The reusable S1 test client is
`packages/server/test/client.ts`.
