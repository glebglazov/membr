// How a request may reach the hub. `deferred` is a token-less WebSocket upgrade from a non-browser client:
// its token must come in hello. `origin` is the origin the client sees, which is https behind `tailscale serve`.
export type Access =
  | { kind: "local" | "token" | "deferred"; origin: string; secureCookie: boolean }
  | { kind: "refused"; status: 401 | 403; reason: string };
export type Admitted = Exclude<Access, { kind: "refused" }>;

function credentials(request: Request, url: URL): string[] {
  const tokens: string[] = [];
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer (.+)$/i.exec(authorization);
    if (!match) throw new Error("Expected a bearer token");
    tokens.push(match[1]);
  }
  tokens.push(...url.searchParams.getAll("token"));
  for (const cookie of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === "token") tokens.push(decodeURIComponent(value.join("=")));
  }
  return tokens;
}

function loopback(address: string): boolean {
  return address === "::1" || address === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(address) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(address);
}

// `tailscale serve` forwards tailnet HTTPS to loopback as plain HTTP. It replaces any client copy of
// Tailscale-User-Login, and a DNS-rebinding page can not take a ts.net Host, so the request is as trusted as localhost.
function tailnet(request: Request, url: URL): boolean {
  return url.hostname.endsWith(".ts.net") && request.headers.has("tailscale-user-login") && request.headers.get("x-forwarded-proto") === "https";
}

export function access(request: Request, peerAddress: string, token: string): Access {
  const url = new URL(request.url);
  const peer = loopback(peerAddress);
  const proxied = peer && tailnet(request, url);
  const origin = proxied ? new URL("https://" + url.host).origin : url.origin;
  const header = request.headers.get("origin");
  if (header !== null && header !== origin) return { kind: "refused", status: 403, reason: "Invalid origin" };
  let tokens: string[];
  try { tokens = credentials(request, url); } catch {
    return { kind: "refused", status: 401, reason: "Invalid bearer credentials" };
  }
  if (tokens.some((value) => value !== token)) return { kind: "refused", status: 401, reason: "Invalid bearer token" };
  const secureCookie = origin.startsWith("https:");
  if (peer && (loopback(url.hostname) || url.hostname === "localhost" || proxied)) return { kind: "local", origin, secureCookie };
  if (tokens.length) return { kind: "token", origin, secureCookie };
  if (url.pathname === "/ws" && header === null && request.headers.get("upgrade")?.toLowerCase() === "websocket") return { kind: "deferred", origin, secureCookie };
  return { kind: "refused", status: 401, reason: "Bearer token required" };
}

// A hello token is checked like a request token, and a deferred socket must send one.
export function admit(access: Admitted, helloToken: string | null, token: string): boolean {
  return helloToken === null ? access.kind !== "deferred" : helloToken === token;
}
