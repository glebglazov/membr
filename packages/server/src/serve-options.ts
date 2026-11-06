// The options of `membr serve`, checked once for both `serve` and `service install`: the service
// writes them into the launchd plist, so a bad option must fail at install and not at the next login.
export type ServeOptions = Readonly<{ port?: number; host?: string; tailscale: boolean; home?: string }>;

export function parseServeOptions(values: Readonly<{ port?: string; host?: string; tailscale?: boolean; home?: string }>): ServeOptions {
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a port number, not "${values.port}"`);
  }
  const tailscale = values.tailscale ?? false;
  if (tailscale && values.host !== undefined) throw new Error("--tailscale serves on 127.0.0.1 behind tailscale serve, so it takes no --host");
  return { port, host: values.host, tailscale, home: values.home };
}

export function serveArgs(options: ServeOptions): string[] {
  return [
    ...(options.port !== undefined ? ["--port", String(options.port)] : []),
    ...(options.host !== undefined ? ["--host", options.host] : []),
    ...(options.tailscale ? ["--tailscale"] : []),
    ...(options.home !== undefined ? ["--home", options.home] : []),
  ];
}
