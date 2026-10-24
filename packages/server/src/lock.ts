// one server per data directory, so two never write the same log. The lock
// is a unix socket that the holder listens on: a socket a crash left behind
// refuses connections and is taken over, and a live holder answers each
// connection with who it is.
import fs from "node:fs";
import path from "node:path";

export type Holder = { pid: number; url: string };

export type Lock = { release(): void };

export type Taken = { lock: Lock } | { heldBy: Holder };

// `holder` is read when another process asks, so the url can name the port
// the server bound after it took the lock
export async function lock(dir: string, holder: () => Holder): Promise<Taken> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "lock");
  while (true) {
    try {
      const listener = Bun.listen({
        unix: file,
        socket: { open: (sock) => void sock.end(JSON.stringify(holder())), data() {} },
      });
      return {
        lock: {
          release() {
            listener.stop(true);
            fs.rmSync(file, { force: true });
          },
        },
      };
    } catch (err: any) {
      if (err.code !== "EADDRINUSE") {
        throw err;
      }
    }
    const heldBy = await ask(file);
    if (heldBy !== null) {
      return { heldBy };
    }
    fs.rmSync(file, { force: true });
  }
}

// the live holder of the lock, or null for a socket nobody listens on or a
// holder that closed without an answer while it shut down.
// Bun.connect, not node:net: in Bun 1.3, node:net is refused by a Bun.listen
// unix socket that Bun.connect reaches.
async function ask(file: string): Promise<Holder | null> {
  let reply = "";
  const { promise, resolve } = Promise.withResolvers<Holder | null>();
  await Bun.connect({
    unix: file,
    socket: {
      data: (_, chunk) => void (reply += chunk),
      close: () => resolve(reply === "" ? null : JSON.parse(reply)),
      connectError: () => resolve(null),
    },
  }).catch(() => resolve(null));
  return promise;
}
