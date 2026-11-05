// Puts the hub on the tailnet through `tailscale serve`: Tailscale takes HTTPS on this machine's
// ts.net name and the same port, and forwards it to the loopback port, so `access` admits tailnet
// requests as local. The serve config outlives membr, and a second run with the same port changes nothing.
export function tailscaleServe(port: number): string {
  tailscale(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
  const status: unknown = JSON.parse(tailscale(["status", "--json"]));
  const self = status && typeof status === "object" && "Self" in status ? status.Self : null;
  const name = self && typeof self === "object" && "DNSName" in self ? self.DNSName : null;
  if (typeof name !== "string" || name === "") throw new Error("tailscale status gives no DNS name for this machine");
  return `https://${name.replace(/\.$/, "")}:${port}/`;
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
