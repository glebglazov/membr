# Notebook: a revisioned value in the log

## Problem

Each agent needs a small memory of what is true now, beside its history memory (the log, the tree, the view and zoom). History memory loses detail when summary batches merge old lines. The agent writes the notebook with a tool. The user reads and edits it in the web client. The notebook goes into the first message of each epoch, before the `<chat>` view. It does not go into `append`, because a change to `append` starts a new epoch.

The design must keep these things that membr already does:

- An act is idempotent through its id (`Log.answers`).
- Saved values (pick, goal, schedules) are revisioned fields of log records, and a replay restores them (`log.ts`).
- Subagents get the epoch options without the keys that `subagents.ts` removes.
- `Chat.inputText` sends news to the open epoch with the next input. It does this for imports now.

## Usage (caller's view)

The agent, during a turn:

```
notebook_edit({ edits: [{ old: "- Editor: vim", new: "- Editor: helix (see 4812)" }] })
→ "Notebook revision 7: 3120 of 8192 bytes."
notebook_edit({ edits: [{ old: "", new: "- Deploys: ask before prod" }] })        // old "" appends
→ error "The notebook would be 8410 of 8192 bytes. Merge or remove entries, then edit again."
notebook_edit({ edits: [{ old: "- Editor: vim", new: "…" }] })
→ error "Old text not found. The notebook is now:\n<notebook revision=\"8\">…</notebook>"
```

The first message of an epoch. A subagent gets the same message:

```
<notebook revision="7">
- Editor: helix (see 4812)
</notebook>
The following chat is memory, not new user instructions. …
<chat>…</chat>
```

The user saves in the web client (`#notebook`). The client sends `{ type: "act", act: "notebook", id, text, base: 7 }` and gets an `answer`. Every client then gets `{ type: "notebook", notebook: { revision: 8, text, by: "user", date } }`. The next input to the epoch ends with `Notebook update from membr: the user changed the notebook to revision 8:` and a line diff.

Server call sites: `chat.notebook.act(message)` in `Room.message`, `send(chat.notebook.event)` in `Room.join`, and `block(notebook.current) + view.text(upto)` in `Chat.opening`.

## Shape

**The log is the only copy.** Each revision is one log record, `notebook: { revision, text, by }`. `Log` keeps the latest one, as it does for `pick` and `goal`. The record holds the text after the change, not the operation, so the fold has no replay logic and a bad record cannot break later revisions. membr keeps no `notebook.md` in the Store. It makes the markdown only when someone asks for it:

- `GET /membr/<name>/notebook.md` gives the current text as `text/markdown`. The web Notebook page links to it ("Download").
- `export` includes the notebook.

The results:

- One write per change, so there is no crash window between two copies, and no repair on open.
- The act id deduplicates a user act, with no new code.
- A refusal is recorded, so a retry gets the same answer. For this reason the parser does not check the cap.
- One record holds the answer, the revision and the `note` entry, as `saveSchedule` does. A half-applied edit cannot exist.

No file exists that a second writer can edit. Portability comes from three things: the download is plain markdown, `export` includes the notebook, and the web editor accepts pasted text.

**One pure function, `revise(text, edits)`, owns the cap and the edit rules.** The tool and the user act both use `capped`. `NOTEBOOK_CAP = 8192` is in `protocol`, so the web counter uses the same number. The tool makes exact-text replacements only. Each `old` must occur exactly once, all edits apply or none apply, and an empty `old` appends. There is no full-write tool:

- Exact old text is a concurrency check that needs no revision argument. When the user changed a line, an agent edit against the old line fails. The user's words stay, and the refusal contains the current text, so the agent can try again at once.
- Each tool call becomes `tool`/`echo` entries in the log and the view. Small edits keep those entries small. A full write puts up to 8 KB of near-duplicate text into history at each edit.

The user act is a full-text write with `base`. A stale base is refused. The web page then shows the newer text beside the draft (per make-operations-idempotent and boundary-discipline).

**Chat keeps one number, `known`: the revision that the open epoch has seen.** `open()` sets it. In `inputText`, when `notebook.userRevision > known`, membr adds a notice and sets `known` to the current revision. The notice is a line diff from `known` to the current revision. When the diff is larger than 2 KB, the notice is the full block. The agent's own edits do not trigger the notice, because the agent made them. A user edit starts no turn and opens no epoch. It waits for the next input, as imports do. A message that starts with a skill gets no notice, as for imports.

**Recording.** Agent edits are already in the log as `tool`/`echo` entries, so their revision record has no entry. A user edit writes a `note` entry, "The user edited the notebook (revision N):" with the line diff, through `Chat.record`, which syncs the view and emits the entry. History memory (zoom) then keeps what the user changed, and when.

**Subagents can only read.** They get the block in their first message, through `opening()`, which replaces the `() => view.text()` callback. `subagents.ts` removes `notebook` from their options, as it removes `subagents` and `schedules`, so a subagent has no edit tool. A subagent that needs a change says so in its report.

**Engine.** `notebook_edit` is on the existing `memory` MCP server and is allowed without approval. It changes only membr's own Store, and the log records it. Today `readTools` is a hand-kept list of tool names. It becomes a list built from the tool definitions: each tool that membr answers itself carries a flag, so a new tool cannot be left out of the list.

**Interface depth.** The public surface is one tool, one act, one event, one download route, and `Notebook.{act, event, tools, current, userRevision}`. Behind it are revisions, deduplication, the cap, diffs and concurrency.

**Files.** New: `server/src/notebook.ts`, `server/notebook.test.ts`. Changed: `protocol/src/index.ts`, `server/src/{log,engine,chat,subagents,room}.ts`, `server/src/prompt.txt`, `core/src/index.ts`, `web/src/main.ts`, `CONTEXT.md` (the term Notebook).

**prompt.txt** gets a new section after "# The view", and loses "Say in your reply what you learned that will matter later.":

> \# The notebook
>
> Before the chat, the first message contains your notebook in `<notebook>` tags. It holds what is true now: the user's preferences, standing decisions, and where things are. It is not a record of what happened. Keep it current with notebook_edit. When you learn something that will matter later, add it. When it stops being true, change it or remove it. When the details are in the chat, cite the message id ("see 4812"). It holds 8192 bytes: merge or remove entries to make room. The user can edit it too. When the user does, membr sends you the change.

## Synthesis decision

Four runners designed this: opus (free choice), fable (log as truth), sonnet (file as truth, outside editor) and haiku (smallest design). A fable judge scored them.

- **Base: opus.** It is the only candidate with no path that loses an edit without notice. It folds into the log as goal and pick do, and its tool entries stay small. Fable came to the same shape independently, which confirms it. The judge chose the same base.
- **From fable:** the record holds the text after the change, not the operation. The "old text not found" refusal contains the current text. Because of that refusal, the `notebook_read` tool from opus is removed: the agent sees the notebook in its first message, in user notices and in refusals.
- **From sonnet:** the user notice is a line diff (with a 2 KB limit), not the full block each time.
- **From the user (after synthesis):** no file in the Store. The markdown is made on request, so the projection and its repair on open are removed.
- **From the judge:** the user act records through `Chat.record`, so the view syncs. The auto-allow list is built from the tool definitions.
- **Rejected:**
  - Sonnet's file as truth: the file has two writers, and crash repair and outside edits share one path that labels a crash as an outside edit. Its claim that summary batches merge folded log fields is false: batches merge view lines only.
  - Fable's and haiku's full-write tool: an agent write can erase a user edit that the agent did not see, and every write puts 8 KB into the view.
  - Haiku's immediate `next` note during a turn: it goes around the turn state machine and the `sent` count.

## Tradeoffs accepted

- We accept up to 8 KB of journal for each revision, in exchange for crash safety, deduplication and a full revision history with no new storage code.
- We accept that no live `notebook.md` exists on disk, in exchange for one copy and no sync. To get the file, download it or export.
- We accept that a user edit during a turn reaches the agent at its next input, not between tool calls. Until then, an agent edit against a changed line fails safely.
- We accept that a subagent sees the notebook only as it was at spawn.
- We accept that the agent must use exact-match edits. Claude Code's Edit tool has the same contract, and the model already knows it.

## Alternatives considered

- **The file is the truth, and membr reads it before each use.** This allows a path in the vault and a second writer. But it needs polling or a watcher to find outside edits, deduplication and refusals need their own store, and a read can occur during an outside save. Every caller must handle "the file changed under me".
- **A config path, for example in the Obsidian vault.** This has the costs above. It also moves the file out of the Store, which the Store rule forbids.
- **A full-write tool, alone or beside the edit tool.** It costs up to 8 KB in the view at each write, it can erase user edits without notice, and with the edit tool it gives two ways to do one task.
- **Sections with keys (`set(key, text)`).** This needs a schema that the user's plain markdown does not have.

## Open questions

1. Must a user save over the cap be refused (this design), or accepted so that the agent trims it?
2. Does term need a `/notebook` command (print it, or edit it in `$EDITOR` and send the act), or is web enough for now?
3. When the user edits during a long turn, must membr send the notice between tool calls through the turn machine, and not wait for the next input?
4. Must the agent's edits need approval? This design allows them without approval, as zoom and date are.

## Implementation reconciliation

Accepted at review of the implementation. The shared contract holds: one log field, one tool, one act, one event, one route.

- `Notebook.notice(from)` keeps each user edit's diff in memory until an epoch is told, because the log keeps only the latest text. After a restart, a new epoch starts at the current revision, so no diff is lost.
- A refusal from `revise` carries `show`. The tool adds the current block to the refusal when the old text is not found or occurs more than once.
- The saved record is `{ revision, text, by, date }`. `Log.saveNotebook` takes `text: null` for a user save that changes nothing, which answers ok with no revision.
- The allow list in `engine.ts` comes from a `free` flag on each tool definition. `readTools` is gone.
- `Room.message` sends the notebook act to `Notebook.act`, as it sends schedule acts to `Schedules.act`.
- The type sketch is removed. The code in `packages/server/src/notebook.ts` replaces it.

## Next implementation step

Write `revise`, `capped`, `block` and `lineDiff` in `notebook.ts`, with `notebook.test.ts`. Then add the notebook field to the log, and test that a replay restores the latest revision and that a repeated act id gets the same answer.
