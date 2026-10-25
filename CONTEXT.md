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
One engine session. It starts from the current view, and a new epoch replaces it after a summary batch.
_Avoid_: session, conversation

**Summary wait**:
The phase of a turn in which membr summarizes old messages before it starts a new epoch.

**Goal check**:
The step after a turn ends in which membr asks whether the goal is met, and starts a new turn when it is not.
