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

It keeps its data in `~/.membr`, or in the directory that `MEMBR_DIR` names.
One server at a time can use a data directory. A second server on the same
directory exits with status 1 and names the process that holds the lock.

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
