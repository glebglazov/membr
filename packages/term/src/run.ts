import { createElement } from "react";
import { render } from "ink";
import { App } from "./app.ts";
import { connectSession } from "./session.ts";

export const DEFAULT_URL = "ws://127.0.0.1:8788/ws";
export const TERM_USAGE = `usage: membr term [url] [--token TOKEN]

Opens the membr chat in this terminal. The url is the server's WebSocket
address, ${DEFAULT_URL} by default; an http(s) address of the server also works.
Local connections need no token. For a remote server, give the sign-in link
that membr serve printed, or pass its token with --token.

Keys: Enter sends, Shift+Enter or Ctrl+J or a trailing \\ adds a line, Tab takes
the chosen / completion, Up and Down move through it, PageUp and PageDown scroll,
Esc stops the turn, Ctrl+C quits.`;

// Accepts the server's web address as well, so the sign-in link that membr serve prints works, token included.
export function socketUrl(address: string): { url: string; token: string | null } {
  const url = new URL(address);
  if (url.protocol === "http:" || url.protocol === "https:") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`membr term needs a ws:// or http:// address, not "${address}"`);
  if (url.pathname === "/") url.pathname = "/ws";
  const token = url.searchParams.get("token");
  url.search = "";
  return { url: url.href, token };
}

export async function runTerm(options: { url?: string; token?: string }): Promise<void> {
  const { url, token } = socketUrl(options.url ?? DEFAULT_URL);
  if (!process.stdin.isTTY) throw new Error("membr term needs a terminal on its input");
  const session = connectSession({ url, token: options.token ?? token });
  const app = render(createElement(App, { session }), { kittyKeyboard: { mode: "auto" } });
  await app.waitUntilExit();
  session.close();
}
