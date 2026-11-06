# membr

One chat with an agent that never ends: UniiChat's memory design, with Claude
Code as the engine through the Claude Agent SDK, on your own `claude` login.

## Run the server

Install [Bun](https://bun.sh), then:

```sh
bun install
bun run serve              # same as: bun packages/server/src/main.ts serve
```

`membr serve` listens on `127.0.0.1:8788`. Open that address to chat in your
browser. Use `--port N` to change the port. The server builds the Preact assets
on the first page request. `bun run build:web` also builds them in `packages/web/dist`.

Local connections need no token. For access from another device, use
`--host ADDRESS` with the server's Tailscale or network address. Open the
sign-in link that the server prints. It sets an HttpOnly cookie and removes
the token from the address bar. The page follows your OS light or dark setting.

`membr serve --tailscale` also puts the server on your tailnet. It runs
`tailscale serve` to forward HTTPS on the machine's `ts.net` name and the same
port to `127.0.0.1`, and prints that address. Tailnet requests through it need
no sign-in. The `tailscale serve` setting stays after membr stops, and the next
run uses it again. Turn it off with `tailscale serve --https=PORT off`.

`make run` installs the packages when they changed and runs
`membr serve --tailscale`. Pass more options in `ARGS`, for example
`make run ARGS="--port 9000"`.

It keeps its data in `~/.membr`, or in the directory that `MEMBR_DIR` names.
One server at a time can use a data directory. A second server on the same
directory exits with status 1 and names the process that holds the lock.

## Configure the server

The server reads `config.json` in the data directory. All keys are optional:

```json
{
  "home": "~/Documents/vault",
  "rules": "~/.membr/rules.md",
  "after": "git -C ~/Documents/vault commit -qam membr || true"
}
```

- `home` is the directory that the agent works in. Claude Code loads the
  harness from it: `CLAUDE.md`, the `.claude/` settings, skills, plugins and
  `.mcp.json`. A relative path starts at the data directory. If you do not set
  `home`, the agent works in the directory that you start the server in.
- `rules` is a file. The server adds its text after the system prompt. A
  relative path starts at the data directory.
- `after` is a shell command. The server runs it after each turn.

`membr serve --home PATH` and the `MEMBR_HOME` variable also set the home. The
`--home` flag comes first, then `MEMBR_HOME`, then the file. `MEMBR_RULES` and
`MEMBR_AFTER` replace `rules` and `after`. If the home is not a directory, the
server does not start.

To read `config.json` again while the server runs, type `/reload` in a client,
or send `SIGHUP` to the server:

```sh
kill -HUP PID
```

The startup line and the `lock` file in the data directory give the PID. A new
`after` command applies at once. A new `home` or new rules apply in a new
epoch. If a turn runs, the new epoch starts when the turn ends. The server
writes a note in the chat that tells the agent what changed. The first turn in
the new epoch reads the full view without the prompt cache, so it costs more.
If the file has an error, the server keeps the old config. `/reload` shows the
error, and after `SIGHUP` all clients show it.

## Run membr as a service

Scheduled runs fire only while the server runs. On macOS, `membr service
install` makes launchd start the server at login and start it again after a
crash:

```sh
membr service install --tailscale
```

The command takes the same options as `membr serve` (`--port`, `--host`,
`--tailscale`, `--home`) and checks them. It writes
`~/Library/LaunchAgents/dev.membr.serve.plist` and loads it. The service keeps
your `PATH`, `MEMBR_DIR` and `MEMBR_CLAUDE_CLI` from the shell that you run the
command in, because launchd starts with a short `PATH` and the server needs
`claude` (and `tailscale`) on it. A relative `--home` becomes an absolute path.
Run the command again to change the options.

The server writes its output to `serve.log` in the data directory. The "sign in
at" line is in that file:

```sh
grep "sign in" ~/.membr/serve.log
```

Other commands:

- `membr service status` shows if the service is loaded, its PID, and the paths
  of the plist and the log.
- `membr service reload` sends `SIGHUP`, which reads `config.json` again.
- `membr service uninstall` stops the service and deletes the plist.

launchd starts the server again after an exit that is not a clean exit. That
includes a crash and a start that fails, and it waits 10 seconds between starts.
A server that you stop with `SIGTERM` stays stopped.

One server can use one data directory. `make run` cannot run beside the
service on the same data directory, because the lock stops the second server.
The service keeps trying, so it starts when `make run` ends. To use `make run`
at once, run `membr service uninstall` first, or set another `MEMBR_DIR`.

## Chat in the terminal

```sh
bun packages/server/src/main.ts term        # or: membr term
```

`membr term` connects to `ws://127.0.0.1:8788/ws`. To use a different
server, give its address or the sign-in link that `membr serve` printed, or
pass the token with `--token TOKEN`.

- Enter sends a message. Shift+Enter, Ctrl+J, or a `\` at the end of the
  line adds a new line.
- Type `/` to see the commands and skills, and use Tab to complete one.
- Press o, a or d to answer an approval.
- Esc stops the turn, and Ctrl+C quits.

The memory tree, the agents view, imports and images are only in the web
view.

## Install the standalone binary

Install Bun and run `bun install`, then build the binary:

```sh
bun run build
```

The build writes one executable to `dist/membr`. Copy that file to a directory
on your `PATH`, then run `membr serve`. The binary contains the web view and
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

Connect to `/ws`. The server prints a sign-in link with its bearer token.
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
