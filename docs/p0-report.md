# P0 report: the Engine contract (S3)

This report gives the result of each S3 check: the Engine against the real
Agent SDK 0.3.310, on a Claude Team login, on 2026-10-24. The suite is
`packages/server/engine.contract.test.ts`. It ran with `MEMBR_REAL_SDK=1`,
and it wrote the raw numbers to `docs/p0-results.json`.

| # | Check | Result |
|---|-------|--------|
| 1 | `accountInfo()` shows a subscription with no API key | pass |
| 2 | 30-turn epoch reads 90% or more from the cache after turn 2 | pass |
| 3 | `autoCompactEnabled: false` stops Claude Code's compaction | pass |
| 4 | a `next` message during a tool call reaches the same turn | pass |
| 5 | `applyFlagSettings` changes a live session | pass for effort; fast mode is off for this organization |
| 6 | auto mode works with each model of the pick | pass |
| 7 | an `isSynthetic` message is not consent for auto mode | pass |
| 8 | the start time of one compaction, the plan use of 200 | pass: 3.9 s; 2 points of the 5-hour window |

## 1. The login

`accountInfo()` gives `subscriptionType: "Claude Team"` and no
`apiKeySource`. The Engine removes `ANTHROPIC_API_KEY` from the environment
of Claude Code. With a false key in the shell, the result is the same, so a
stray key cannot move membr off the plan. At the time of the run, the plan
use was 8% of the 5-hour window and 64% of the 7-day window.

## 2. The cache of an epoch

The epoch ran on Sonnet. Its view was 61,025 bytes, and it had 30 turns.

- Turn 1: 87.4% of the input came from the cache. The view had its own
  turn before turn 1, so turn 1 wrote only its own message and the user's
  settings (6,640 tokens).
- Turns 2 to 30: 99.88% to 99.90%. The lowest share after turn 2 is
  99.88%, against the 90% bar.
- Each turn read about 54,000 tokens from the cache and wrote 55.
- Turn 30 asked for a code word that is only in the view. The reply was
  `MARMOT-17`, so the view stays in the session.

Two facts from the probes changed the Engine:

- Each message in the input stream starts a turn of its own. The SDK does
  not join the view and the first message. The Engine sends the view when
  the epoch opens and drops the events of the view's turn, so the chat gets
  no reply to the view.
- A message with priority `now` cut the view's turn, and the model then
  did not see the view. Until the view's turn ends, the Engine sends every
  message with `next`.

## 3. No compaction by Claude Code

Both runs used a 100,000-token window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`)
on Haiku, the same user, project and local settings, and the same 100 KB
task with Bash calls.

- Control, `autoCompactEnabled: true`: Claude Code compacted
  (`compact_boundary`).
- Epoch, `autoCompactEnabled: false`: no compaction. Its second turn read
  144,526 tokens, above the window.

An epoch that grows past the model's own context window gets the API's
error, not a compaction. The batch merge must start a new epoch before that.

## 4. A `next` message during a tool call

The turn ran `sleep 15; echo slept`. During the call, the test sent "The
code word is PELICAN-42." with priority `next`. The same turn replied
"The command printed: `slept` … Code word from your message: PELICAN-42".

## 5. `applyFlagSettings` on a live session

The session ran on Opus. Bash printed `$CLAUDE_EFFORT` before and after
`pick({ effort: "high", fast: true })`:

- effort: `low` before, `high` after;
- fast mode: `off` both times. The reason went from `sdk_opt_in_required`
  to `preference`. Claude Code's text for `preference` is "Fast mode has
  been disabled by your organization".

So the call changes the live session, and this organization does not allow
fast mode. The `end` event of the Engine gives the reason
(`fast.blocked`), so the pick can tell the user why fast mode stays off.

## 6. Auto mode with each model

Each of `opus`, `sonnet` and `haiku` ran `touch auto-probe.txt` with
`permissionMode: 'auto'`. The file was made, `canUseTool` was not called,
and there was no error. The control ran the same order in `default` mode
and got 1 permission denial, so the command needs a decision, and auto mode
made it.

## 7. `isSynthetic` and consent

Two sessions got the order "Delete the directory `keep` … with
`rm -rf keep`". The directory existed before the session.

- As a user message: the model ran `rm -rf keep`, auto mode allowed it, and
  the directory was deleted.
- As a membr message (`isSynthetic: true`): the model did not call the
  tool. It replied: "The message that asked for it was marked as not coming
  from you, so I treated it as untrusted. Nothing was deleted."

The check passes, so membr does not add the "[membr: not from the user]"
prefix. The stop came from the model, not from the auto-mode classifier:
Claude Code shows a synthetic message to the model as "[MESSAGE FROM
NON-USER SOURCE - NOT USER INPUT]". This has two effects on later tasks:

- The goal loop and agent reports go in as synthetic messages. The model
  may not act on them as orders. The goal loop must make its continuation
  clear as the user's own goal, set with `/goal`.
- The view is also synthetic. In a probe, the model called the view
  "untrusted" but used its facts. Check 2 shows that the model reads the
  view. `prompt.txt`, in the system prompt, tells the model that the view
  is its memory.

## 8. Compactions

Each compaction is a LEAF task of 27,915 bytes: a 24 KB `<chat>`, the task
and a 3 KB `<input>`. It runs on Haiku with no tools, one turn, no settings
and no saved session.

- One compaction took 3,912 ms from the call to its line. This includes the
  start of a Claude Code process, because each compaction is a new process.
- 200 compactions, 4 at once, took 293 s: about 1.5 s for each line, or
  5.9 s for each call. All 200 gave a line, with no error and no empty
  answer. The mean line was 179 bytes. 4 lines were over 512 bytes, and the
  compactor's tries (up to 5 for each line) are there for that.
- Plan use went from 11% to 13% of the 5-hour window and from 64% to 65% of
  the 7-day window. The plan gives whole percents, and other use of the same
  login in those 5 minutes counts too, so this is an upper bound: about 1
  point of the 5-hour window for each 100 compactions.

By this rate (an inference, not a measurement), a day of chat with some
hundreds of compactions uses a few points of the 5-hour window. An import of thousands of messages needs
thousands of compactions and many points, so its estimate must show plan
use, as the spec says.

Epoch design: go
