# membr

membr is a set of chats with agents whose memory keeps every message. One hub serves every agent to web and terminal clients on this machine, on the tailnet, and on the local network.

## Language

**Agent**:
One chat that never ends, with a name, its own store, its own home and its own prompt. An agent exists when config.json has an entry for it under `agents`. The agent `default` always exists. Its web app is at `/membr/<name>/`.
_Avoid_: bot, persona, chat (for the whole thing)

**Subagent**:
A short run that an agent starts with its `spawn` tool for one task. It reports back to the agent that started it, and then it is gone.
_Avoid_: agent (for this), worker, child

**Base directory**:
The directory of the server: `~/.local/share/membr`, or the one that `MEMBR_DIR` names. It holds config.json, the token, the lock, serve.log, and the agent directories under `agents/`.
_Avoid_: data directory, membr home

**Store**:
One agent's own files: its log, tree, epochs, subagent logs and images. It is the agent directory `agents/<name>/` in the base directory. Only membr reads and writes it, and no setting moves it.
_Avoid_: data directory, home

**Home**:
The directory that the Engine of one agent runs in, and where Claude Code finds the harness. It is the agent's `home` key, or `agents/<name>/home/` when the key is not set.
_Avoid_: working directory, workspace, store

**Access**:
The way a request is allowed to reach the hub. It is local (this machine, or the tailnet through `tailscale serve`), token (the request carries the token), deferred (a WebSocket with no token, which must send the token in its hello), or refused.
_Avoid_: auth, permission, trust

**Turn**:
One input from the user or from membr, and the agent work that answers it, up to its end entry in the log.
_Avoid_: request, round

**Epoch**:
One engine session. It starts from the current view. A new epoch replaces it after a summary batch, after a change of the agent's home or prompt, and when a turn ends with the session at 150k tokens or more (80% of the model's context window, when that is less) or over the window. The status shows the epoch's size after its last turn, of that limit.
_Avoid_: session, conversation

**Harness**:
The Claude Code settings, skills, plugins and MCP servers that the Engine loads from the agent's home and the user's settings.
_Avoid_: config, environment

**Skill**:
A `/name` command from the harness. When the message starts with it, Claude Code runs it and the rest of the message is its arguments. Elsewhere in the message, the agent runs it with the Skill tool. Membr commands work only at the start of the message. A skill with the name of a membr command is hidden behind that command. Built-in Claude Code commands are not skills, because they act on the session, which is an epoch.
_Avoid_: slash command, plugin

**Compression**:
One Haiku call that writes one line of the tree: it compresses one message into a line, or merges two adjacent lines into one. A line is 512 bytes or less. A message, or a pair of lines, that fits in 512 bytes stays as it is, with no call. Compression runs in the background as messages come in. The Settings popover shows the tokens that all compressions sent to Haiku, and the share read from the cache.
_Avoid_: summarization, compaction (the code keeps UniiChat's names `compact` and compactor)

**Summary batch**:
The step that makes the view smaller. When the view is larger than 128 KB, membr replaces pairs of old lines with the line above them in the tree, oldest first, until the view is 64 KB or less. Then a new epoch starts from that view. It calls no model: it uses only lines that compression wrote.
_Avoid_: compaction, compression

**Summary wait**:
The phase of a turn in which membr waits for compression to write the lines that the summary batch needs, before it starts a new epoch.

**Schedule**:
A task text with a time (one ISO time, or a cron and a time zone name), stored in the log. It belongs to one agent, and runs as a turn of that agent or as a subagent. A schedule that the user makes speaks as the user. A schedule that the agent proposes speaks as membr, and runs only after the user accepts it.
_Avoid_: job, cron, timer, reminder

**Notebook**:
A small markdown text of at most 8192 bytes that holds what is true now: the user's preferences, standing decisions, and where things are. It belongs to one agent, and is stored in the log, one revision for each change. The agent changes it with its `notebook_edit` tool, and the user in the web client. It starts every epoch and every subagent's first message, before the view. The chat history is the record of what happened. The notebook is what stays true.
_Avoid_: memory file, notes

**Fire**:
One run of a schedule at one of its times. Its act id holds the schedule and the time, so a fire is never written two times. A fire that membr missed runs late one time, or is skipped.
_Avoid_: trigger, tick, occurrence

**Goal check**:
The step after a turn ends in which membr asks whether the goal is met, and starts a new turn when it is not.

**Journal**:
The append-only record files of one store (the log or the tree) under one directory, one file for each day. On open it reads every record, cuts off a half-written last line, and after that it can read any record by where it was written.
_Avoid_: storage, database, index
