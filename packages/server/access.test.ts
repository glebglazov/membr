import { expect, test } from "bun:test";
import { access, admit, type Access } from "./src/access.ts";

const TOKEN = "secret";
const LOOPBACK = "127.0.0.1";
const REMOTE = "192.168.1.20";
const tailnet = { "tailscale-user-login": "me@example.com", "x-forwarded-proto": "https" };
const upgrade = { upgrade: "websocket" };

const cases: [string, string, string, Record<string, string>, Access][] = [
  ["loopback", "http://127.0.0.1:4000/", LOOPBACK, {}, { kind: "local", origin: "http://127.0.0.1:4000", secureCookie: false }],
  ["localhost", "http://localhost:4000/", "::1", {}, { kind: "local", origin: "http://localhost:4000", secureCookie: false }],
  ["tailnet proxy", "http://mac.tail0.ts.net/", LOOPBACK, tailnet, { kind: "local", origin: "https://mac.tail0.ts.net", secureCookie: true }],
  ["tailnet proxy with its browser origin", "http://mac.tail0.ts.net:4000/ws", LOOPBACK, { ...tailnet, origin: "https://mac.tail0.ts.net:4000" }, { kind: "local", origin: "https://mac.tail0.ts.net:4000", secureCookie: true }],
  ["tailnet without Tailscale-User-Login", "http://mac.tail0.ts.net/", LOOPBACK, { "x-forwarded-proto": "https" }, { kind: "refused", status: 401, reason: "Bearer token required" }],
  ["tailnet headers from a remote peer", "http://mac.tail0.ts.net/", REMOTE, tailnet, { kind: "refused", status: 401, reason: "Bearer token required" }],
  ["tailnet with x-forwarded-proto not https", "http://mac.tail0.ts.net/", LOOPBACK, { ...tailnet, "x-forwarded-proto": "http" }, { kind: "refused", status: 401, reason: "Bearer token required" }],
  ["a wrong host on a loopback peer", "http://other.example/", LOOPBACK, {}, { kind: "refused", status: 401, reason: "Bearer token required" }],
  ["a wrong host with the token", "http://other.example/", LOOPBACK, { cookie: "token=secret" }, { kind: "token", origin: "http://other.example", secureCookie: false }],
  ["a token in the query", "http://192.168.1.5:4000/?token=secret", REMOTE, {}, { kind: "token", origin: "http://192.168.1.5:4000", secureCookie: false }],
  ["a token mismatch", "http://192.168.1.5:4000/", REMOTE, { authorization: "Bearer wrong" }, { kind: "refused", status: 401, reason: "Invalid bearer token" }],
  ["a token mismatch on loopback", "http://127.0.0.1:4000/", LOOPBACK, { cookie: "token=wrong" }, { kind: "refused", status: 401, reason: "Invalid bearer token" }],
  ["a malformed bearer header", "http://192.168.1.5:4000/", REMOTE, { authorization: "Basic secret" }, { kind: "refused", status: 401, reason: "Invalid bearer credentials" }],
  ["a deferred WebSocket", "http://192.168.1.5:4000/ws", REMOTE, upgrade, { kind: "deferred", origin: "http://192.168.1.5:4000", secureCookie: false }],
  ["a browser WebSocket with no token", "http://192.168.1.5:4000/ws", REMOTE, { ...upgrade, origin: "http://192.168.1.5:4000" }, { kind: "refused", status: 401, reason: "Bearer token required" }],
  ["a WebSocket upgrade off /ws", "http://192.168.1.5:4000/", REMOTE, upgrade, { kind: "refused", status: 401, reason: "Bearer token required" }],
  ["an origin mismatch", "http://127.0.0.1:4000/", LOOPBACK, { origin: "https://other.example" }, { kind: "refused", status: 403, reason: "Invalid origin" }],
  ["an http origin behind the tailnet proxy", "http://mac.tail0.ts.net/", LOOPBACK, { ...tailnet, origin: "http://mac.tail0.ts.net" }, { kind: "refused", status: 403, reason: "Invalid origin" }],
];

test.each(cases)("access: %s", (_, url, peer, headers, expected) => {
  expect(access(new Request(url, { headers }), peer, TOKEN)).toEqual(expected);
});

test("hello admits a deferred socket only with the token", () => {
  const local = { kind: "local", origin: "http://127.0.0.1:4000", secureCookie: false } as const;
  const deferred = { ...local, kind: "deferred" } as const;
  expect(admit(local, null, TOKEN)).toBe(true);
  expect(admit(local, "wrong", TOKEN)).toBe(false);
  expect(admit(deferred, null, TOKEN)).toBe(false);
  expect(admit(deferred, "wrong", TOKEN)).toBe(false);
  expect(admit(deferred, TOKEN, TOKEN)).toBe(true);
});
