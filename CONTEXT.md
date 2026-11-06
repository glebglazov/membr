# membr

membr is a chat with one agent whose memory keeps every message. A hub serves the chat to web clients on this machine, on the tailnet, and on the local network.

## Language

**Access**:
The way a request is allowed to reach the hub. It is local (this machine, or the tailnet through `tailscale serve`), token (the request carries the token), deferred (a WebSocket with no token, which must send the token in its hello), or refused.
_Avoid_: auth, permission, trust

**Turn**:
One input from the user or from membr, and the agent work that answers it, up to its end entry in the log.
_Avoid_: request, round

**Epoch**:
One engine session. It starts from the current view. A new epoch replaces it after a summary batch, after a change of home or rules, and when a turn ends with the session at 80% or more of the model's context window or over it.
_Avoid_: session, conversation

**Harness**:
The Claude Code settings, skills, plugins and MCP servers that the Engine loads from the server's working directory and the user's settings.
_Avoid_: config, environment

**Skill**:
A `/name` command from the harness. The agent runs it when the user's message starts with it. A skill with the name of a membr command is hidden behind that command. Built-in Claude Code commands are not skills, because they act on the session, which is an epoch.
_Avoid_: slash command, plugin

**Summary wait**:
The phase of a turn in which membr summarizes old messages before it starts a new epoch.

**Goal check**:
The step after a turn ends in which membr asks whether the goal is met, and starts a new turn when it is not.

**Journal**:
The append-only record files of one store (the log or the tree) under one directory, one file for each day. On open it reads every record, cuts off a half-written last line, and after that it can read any record by where it was written.
_Avoid_: storage, database, index
