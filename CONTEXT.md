# membr

membr is a chat with one agent whose memory keeps every message. A hub serves the chat to web clients on this machine, on the tailnet, and on the local network.

## Language

**Access**:
The way a request is allowed to reach the hub. It is local (this machine, or the tailnet through `tailscale serve`), token (the request carries the token), deferred (a WebSocket with no token, which must send the token in its hello), or refused.
_Avoid_: auth, permission, trust
