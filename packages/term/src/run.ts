import { createElement } from "react";
import { render } from "ink";
import { App } from "./app.ts";
import { terminalInput } from "./terminal.ts";
import { connectSession } from "./session.ts";

export const DEFAULT_URL = "ws://127.0.0.1:8788/ws";
// Accepts the server's web address as well, so the sign-in link that membr status prints works, token included.
export function socketUrl(address: string): { url: string; token: string | null } {
  const url = new URL(address);
  if (url.protocol === "http:" || url.protocol === "https:") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`membr needs a ws:// or http:// address, not "${address}"`);
  if (url.pathname === "/") url.pathname = "/ws";
  const token = url.searchParams.get("token");
  url.search = "";
  return { url: url.href, token };
}

export async function runTerm(options: { url?: string; token?: string | null }): Promise<void> {
  const { url, token } = socketUrl(options.url ?? DEFAULT_URL);
  if (!process.stdin.isTTY) throw new Error("membr needs a terminal on its input");
  const session = connectSession({ url, token: options.token ?? token });
  const terminal = terminalInput(process.stdin, process.stdout);
  try {
    const app = render(createElement(App, { session, wheel: terminal.wheel, editor: terminal.edit }), { stdin: terminal.stdin, kittyKeyboard: { mode: "auto" } });
    await app.waitUntilExit();
  } finally {
    terminal.close();
    session.close();
  }
}
