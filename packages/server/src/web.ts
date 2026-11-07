import path from "node:path";

declare const EMBEDDED_WEB: Record<string, string> | undefined;

let assets: Promise<Map<string, Blob | string>> | undefined;
async function build(): Promise<Map<string, Blob | string>> {
  const result = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../web/src/index.html"), path.join(import.meta.dir, "../../web/src/mermaid.ts")], target: "browser", minify: true });
  if (!result.success) throw new AggregateError(result.logs, "The web renderer did not build");
  return new Map(result.outputs.map((output) => [path.basename(output.path) === "index.html" ? "/" : "/" + path.basename(output.path), output]));
}

// pathname is the asset path inside the web app, with the agent part of the URL removed.
export async function web(request: Request, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const embedded = typeof EMBEDDED_WEB === "undefined" ? undefined : EMBEDDED_WEB;
  const body = embedded
    ? embedded[pathname]
    : (await (assets ??= build())).get(pathname);
  if (!body) return new Response("Not found", { status: 404 });
  const contentType = typeof body === "string"
    ? pathname === "/" || pathname.endsWith(".html") ? "text/html; charset=utf-8"
      : pathname.endsWith(".css") ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8"
    : body.type;
  return new Response(request.method === "HEAD" ? null : body, { headers: {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
