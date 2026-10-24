import path from "node:path";

declare const EMBEDDED_WEB: Record<string, string> | undefined;

let assets: Promise<Map<string, Blob | string>> | undefined;
async function build(): Promise<Map<string, Blob | string>> {
  const result = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../web/src/main.ts")], target: "browser", minify: true });
  if (!result.success) throw new AggregateError(result.logs, "The web renderer did not build");
  const files = new Map<string, Blob | string>(result.outputs.map((output) => ["/" + path.basename(output.path), output]));
  files.set("/", await Bun.file(new URL("../../web/src/index.html", import.meta.url)).text());
  return files;
}

export async function web(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const embedded = typeof EMBEDDED_WEB === "undefined" ? undefined : EMBEDDED_WEB;
  const body = embedded
    ? embedded[url.pathname]
    : (await (assets ??= build())).get(url.pathname);
  if (!body) return new Response("Not found", { status: 404 });
  const contentType = typeof body === "string"
    ? url.pathname === "/" || url.pathname.endsWith(".html") ? "text/html; charset=utf-8"
      : url.pathname.endsWith(".css") ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8"
    : body.type;
  return new Response(request.method === "HEAD" ? null : body, { headers: {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
