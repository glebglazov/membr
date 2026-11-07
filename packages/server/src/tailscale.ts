// Puts the hub on the tailnet through `tailscale serve`: Tailscale takes HTTPS on this machine's ts.net name, port 443,
// path /membr, and forwards it to the loopback port. It strips the /membr it matched and adds the target's /membr back,
// so the hub sees the same path as on loopback, and `access` admits tailnet requests as local. The serve config
// outlives membr, and a second run changes nothing.
export function tailscaleServe(port: number): string {
  tailscale(["serve", "--bg", "--https=443", "--set-path=/membr", `http://127.0.0.1:${port}/membr`]);
  const status: unknown = JSON.parse(tailscale(["status", "--json"]));
  const self = status && typeof status === "object" && "Self" in status ? status.Self : null;
  const name = self && typeof self === "object" && "DNSName" in self ? self.DNSName : null;
  if (typeof name !== "string" || name === "") throw new Error("tailscale status gives no DNS name for this machine");
  const host = name.replace(/\.$/, "");
  dropPortEntry(host, port);
  return `https://${host}/membr/`;
}

// Before many agents, membr served the whole of https://<host>:<port>/. That entry is turned off one time, and only
// when it still forwards to membr's own port.
function dropPortEntry(host: string, port: number): void {
  const serve: unknown = JSON.parse(tailscale(["serve", "status", "--json"]) || "{}");
  const web = serve && typeof serve === "object" && "Web" in serve ? serve.Web as Record<string, { Handlers?: Record<string, { Proxy?: string }> }> : {};
  const handlers = web[`${host}:${port}`]?.Handlers;
  if (handlers && Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === `http://127.0.0.1:${port}`) tailscale(["serve", `--https=${port}`, "off"]);
}

function tailscale(args: string[]): string {
  const command = "tailscale " + args.join(" ");
  let proc: Bun.SyncSubprocess<"pipe", "pipe">;
  // `tailscale serve` waits for the user when Serve is off for the tailnet, so a stuck call fails instead of hanging.
  try { proc = Bun.spawnSync(["tailscale", ...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 }); } catch {
    throw new Error(`${command} could not start: is Tailscale installed and on PATH?`);
  }
  if (proc.exitCode !== 0) {
    const reason = proc.stderr.toString().trim() || proc.stdout.toString().trim() || (proc.exitCode === null ? "timed out" : `exit status ${proc.exitCode}`);
    throw new Error(`${command} failed: ${reason}`);
  }
  return proc.stdout.toString();
}
