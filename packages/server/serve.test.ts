import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestClient } from "./test/client.ts";

const MAIN = path.join(import.meta.dir, "test/serve.ts");
const running: Bun.Subprocess[] = [];
const dirs: string[] = [];

function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membr-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const proc of running.splice(0)) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function serve(dir: string, command = ["bun", MAIN]) {
  const proc = Bun.spawn([...command, "serve", "--port", "0"], {
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

async function contend(dir: string, command?: string[]) {
  const processes = Array.from({ length: 8 }, () => serve(dir, command));
  const results = await Promise.allSettled(processes.map(listening));
  const winners = results.flatMap((result, index) => result.status === "fulfilled" ? [{ proc: processes[index], url: result.value }] : []);
  expect(winners).toHaveLength(1);
  const winner = winners[0];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === "fulfilled") continue;
    expect(await processes[index].exited).toBe(1);
    expect(String(result.reason)).toContain(`pid ${winner.proc.pid}`);
  }
  expect((await fetch(winner.url)).ok).toBe(true);
  return winner;
}

test("serve listens on loopback", async () => {
  const url = await listening(serve(directory()));
  expect(new URL(url).hostname).toBe("127.0.0.1");
  expect((await fetch(url)).ok).toBe(true);
});

test("a second serve on the same data directory exits and names the holder", async () => {
  const dir = directory();
  const first = serve(dir);
  const url = await listening(first);

  const second = serve(dir);
  expect(await second.exited).not.toBe(0);
  const err = await new Response(second.stderr).text();
  expect(err).toContain(`pid ${first.pid}`);
  expect(err).toContain(url);
});

test("a lock left by a crashed server is taken over", async () => {
  const dir = directory();
  const crashed = serve(dir);
  await listening(crashed);
  crashed.kill("SIGKILL");
  await crashed.exited;
  expect(fs.existsSync(path.join(dir, "lock"))).toBe(true);

  await contend(dir);
}, 10000);

test("SIGTERM waits for the after command before it releases the server", async () => {
  const dir = directory();
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

test("the built binary refuses a live holder and takes over after a crash", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const build = Bun.spawn([process.execPath, "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(output + errors);
  const dir = directory();
  const command = [path.join(root, "dist/membr")];
  const first = serve(dir, command);
  const url = await listening(first);
  const second = serve(dir, command);
  expect(await Promise.race([second.exited, Bun.sleep(3000).then(() => "still running")])).toBe(1);
  const error = await new Response(second.stderr).text();
  expect(error).toContain(`pid ${first.pid}`);
  expect(error).toContain(url);
  expect((await fetch(url)).ok).toBe(true);
  first.kill("SIGKILL");
  await first.exited;
  expect(fs.existsSync(path.join(dir, "lock"))).toBe(true);
  const { proc: replacement } = await contend(dir, command);
  replacement.kill("SIGTERM");
  expect(await replacement.exited).toBe(0);
  expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);
  expect((await fetch(await listening(serve(dir, command)))).ok).toBe(true);
}, 30000);


test("a new server refuses a legacy socket lock without replacing it", async () => {
  const dir = directory();
  const file = path.join(dir, "lock");
  const legacy = Bun.listen({ unix: file, socket: { data() {} } });
  const inode = fs.lstatSync(file).ino;
  try {
    const next = serve(dir);
    expect(await next.exited).toBe(1);
    expect(await new Response(next.stderr).text()).toContain("Legacy socket lock");
    expect(fs.lstatSync(file).isSocket()).toBe(true);
    expect(fs.lstatSync(file).ino).toBe(inode);
  } finally {
    legacy.stop(true);
  }
});
