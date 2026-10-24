import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestClient } from "./test/client.ts";

const MAIN = path.join(import.meta.dir, "test/serve.ts");
const running: Bun.Subprocess[] = [];

afterEach(() => {
  for (const proc of running.splice(0)) {
    proc.kill("SIGKILL");
  }
});

function serve(dir: string) {
  const proc = Bun.spawn(["bun", MAIN, "serve", "--port", "0"], {
    env: { ...process.env, MEMBR_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(proc);
  return proc;
}

// the url a server prints once it holds the lock and listens
async function listening(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  let out = "";
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    out += chunk;
    const url = out.match(/serving .* at (\S+)/)?.[1];
    if (url !== undefined) {
      return url;
    }
  }
  throw new Error(`membr serve exited before it listened: ${await new Response(proc.stderr).text()}`);
}

test("serve listens on loopback", async () => {
  const url = await listening(serve(fs.mkdtempSync(path.join(os.tmpdir(), "membr-"))));
  expect(new URL(url).hostname).toBe("127.0.0.1");
  expect((await fetch(url)).ok).toBe(true);
});

test("a second serve on the same data directory exits and names the holder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-"));
  const first = serve(dir);
  const url = await listening(first);

  const second = serve(dir);
  expect(await second.exited).not.toBe(0);
  const err = await new Response(second.stderr).text();
  expect(err).toContain(`pid ${first.pid}`);
  expect(err).toContain(url);
});

test("a lock left by a crashed server is taken over", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-"));
  const crashed = serve(dir);
  await listening(crashed);
  crashed.kill("SIGKILL");
  await crashed.exited;
  expect(fs.existsSync(path.join(dir, "lock"))).toBe(true);

  await listening(serve(dir));
});

test("SIGTERM waits for the after command before it releases the server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-"));
  const output = path.join(dir, "after.txt");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ after: `sleep 0.1; printf done > '${output}'` }));
  const proc = serve(dir);
  const url = await listening(proc);
  const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
  const client = await TestClient.connect(url.replace("http:", "ws:") + "ws", { token });
  try {
    await client.wait("ready");
    const mark = client.events.length;
    client.act({ type: "act", act: "say", id: "before-shutdown", text: "Work" });
    await client.wait("answer", mark);
    await client.wait("state", mark, (event) => !event.state.busy);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe("done");
  } finally {
    client.close();
  }
});
