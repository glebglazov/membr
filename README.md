# membr

One chat with an agent that never ends: UniiChat's memory design, with Claude
Code as the engine through the Claude Agent SDK, on your own `claude` login.

## Run the server

Install [Bun](https://bun.sh), then:

```sh
bun install
bun run serve              # same as: bun packages/server/src/main.ts serve
```

`membr serve` listens on `127.0.0.1:8788`. Use `--port N` to change the port.
It keeps its data in `~/.membr`, or in the directory that `MEMBR_DIR` names.
One server at a time can use a data directory. A second server on the same
directory exits with status 1 and names the process that holds the lock.

## Run the tests

```sh
bun test
```

Run this from the repository root. It runs the tests of all packages,
including the check that the client core imports no DOM and no terminal code.

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
