# membr

One chat with an agent that never ends: UniiChat's memory design, with Claude
Code as the engine through the Claude Agent SDK, on your own `claude` login.

## Start membr

Install [Bun](https://bun.sh), then:

```sh
bun install
bun packages/server/src/main.ts      # or: membr, after you install the binary
```

`membr` opens the chat in this terminal. If no server runs, membr starts one
and waits until it listens. On macOS, launchd runs the server, so the server
also starts at login and after a crash, and schedules fire when no terminal is
open. On other systems, run `membr serve` in a terminal, then
`membr ws://127.0.0.1:8788/ws` in another one.

The server listens on `127.0.0.1:8788`. Open that address to chat in your
browser. The page follows your OS light or dark setting. The server builds the
Preact assets on the first page request. `bun run build:web` also builds them
in `packages/web/dist`. To change the address, set `port`, `host` or
`tailscale` in `config.json` (see [Configure the server](#configure-the-server)).

Local connections need no token. For access from another device, set `host` to
the server's Tailscale or network address. Open the sign-in link that
`membr status` prints. It sets an HttpOnly cookie and removes the token from
the address bar.

With `"tailscale": true`, the server is also on your tailnet. It runs
`tailscale serve` to forward HTTPS on the machine's `ts.net` name and the same
port to `127.0.0.1`. `membr status` shows that address. Tailnet requests
through it need no sign-in. The `tailscale serve` setting stays after membr
stops, and the next run uses it again. Turn it off with
`tailscale serve --https=PORT off`.

These are the commands:

- `membr` opens the chat, and starts the server first if it does not run.
- `membr URL [--token TOKEN]` connects to another server and starts nothing.
  The URL is the server's `ws://` or `http://` address, or the sign-in link
  that `membr status` prints on that machine.
- `membr reload` reads `config.json` again. It prints the result. If the file
  has an error, it prints the error and exits with status 1.
- `membr status` shows the PID, the address, the tailnet address, the sign-in
  link, the launchd agent and the path of the log.
- `membr stop` stops the server and removes the launchd agent. Then nothing
  starts the server until the next `membr`, also not a login. It also stops a
  server that `make run` started.
- `membr serve` runs the server in the foreground. launchd and `make run` use
  this command. It takes no options.

In the terminal chat, Enter sends a message. Shift+Enter, Ctrl+J, or a `\` at
the end of the line adds a new line. Type `/` to see the commands and skills,
and use Tab to complete one. Press o, a or d to answer an approval. Esc stops
the turn, and Ctrl+C quits. The memory tree, the agents view, imports and
images are only in the web view.

membr keeps its data in `~/.membr`, or in the directory that `MEMBR_DIR`
names. One server at a time can use a data directory. A second server on the
same directory exits with status 1 and names the process that holds the lock.
`membr` uses a server that runs already, also one that `make run` started.

Each data directory has its own launchd agent: `dev.membr.serve` for
`~/.membr`, and `dev.membr.serve.` with 8 hexadecimal characters for another
directory. The agent's plist is in `~/Library/LaunchAgents`. It keeps your
`PATH`, `MEMBR_DIR` and `MEMBR_CLAUDE_CLI` from the shell that runs `membr`,
because launchd starts with a short `PATH` and the server needs `claude` (and
`tailscale`) on it. When no server runs, `membr` writes the plist again if it
changed, for example after you move the repository or use a shell with another
`PATH`. membr never stops a server that runs to do this. To use a new build,
run `membr stop`, then `membr`.

The server writes its output to `serve.log` in the data directory. If the
server does not start within 15 seconds, `membr` prints the end of that log.
launchd starts the server again after an exit that is not a clean exit, and
waits 10 seconds between starts. That includes a crash and a start that fails,
for example when Tailscale is not up yet after login.

`make run` installs the packages when they changed and runs `membr serve` in
the terminal. It cannot run beside a launchd server on the same data
directory, because the lock stops the second server. Run `membr stop` first,
or set another `MEMBR_DIR`.

## Configure the server

The server reads `config.json` in the data directory. All keys are optional:

```json
{
  "home": "~/Documents/vault",
  "rules": "rules.md",
  "after": "git -C ~/Documents/vault commit -qam membr || true",
  "approvalTimeout": "10m",
  "port": 8788,
  "host": "127.0.0.1",
  "tailscale": true
}
```

- `home` is the directory that the agent works in. Claude Code loads the
  harness from it: `CLAUDE.md`, the `.claude/` settings, skills, plugins and
  `.mcp.json`. A relative path starts at the data directory. If you do not set
  `home`, the agent works in the directory that the server starts in. For a
  server that launchd runs, that is the data directory. If `home` is not a
  directory, the server does not start.
- `rules` is a file. The server adds its text after the system prompt. A
  relative path starts at the data directory.
- `after` is a shell command. The server runs it after each turn.
- `approvalTimeout` is how long a scheduled run waits for an approval. After
  that time, membr denies the tool call and writes a note in the chat. Write a
  number and a unit: `90s`, `10m` or `2h`. The default is `10m`, and the
  maximum is `24h`. An approval in a turn that you started waits until you
  answer it.
- `port` is the port that the server listens on. The default is `8788`.
- `host` is the address that the server listens on. The default is
  `127.0.0.1`.
- `tailscale` puts the server on your tailnet when it is `true`. The default is
  `false`. It needs `host` to be `127.0.0.1`.

To read `config.json` again while the server runs, run `membr reload`, or type
`/reload` in a client. `SIGHUP` to the server also reads it again. Then all
clients show an error in the file.

A new `port`, `host` or `tailscale` applies at once. The server moves to the
new address, and a turn that runs continues. Open clients lose the connection,
so open the chat again at the new address. If the server cannot listen on the
new address, it keeps the old config and `membr reload` shows why. A new
`after` command applies at once. A new `home` or new rules apply in a new
epoch. If a turn runs, the new epoch starts when the turn ends. The server
writes a note in the chat that tells the agent what changed. The first turn in
the new epoch reads the full view without the prompt cache, so it costs more.
If the file has an error, the server keeps the old config. `membr reload` and
`/reload` show the error.

Large tool output stays in the epoch until the next summary batch. When a turn
ends with the epoch at 80% or more of the model's context window, the next
turn starts in a new epoch. If a turn makes the epoch too large for the model,
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
needs no other project files. It stores data in `~/.membr`, or in the directory
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

Connect to `/ws`. `membr status` prints a sign-in link with the bearer token.
Supply that token in `Authorization: Bearer TOKEN`, the `token` query parameter,
the `token` cookie, or the hello message. If you supply more than one token,
all must match. The token stays in the data directory with mode `0600`.

Send hello first:

```json
{"type":"hello","version":"1.0","kind":"term","device":null,"token":"TOKEN"}
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
The server sends that text to the agent as it is, with no notes added.

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
{"type":"act","id":"s-1","act":"schedule","schedule":{"text":"read the notes","when":{"kind":"cron","expr":"30 8 * * 1-5","zone":"Europe/London"},"run":"agent","missed":"once"}}
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
