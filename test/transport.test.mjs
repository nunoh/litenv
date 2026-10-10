import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalTransport } from "../dist/transport/local.js";
import { SshTransport } from "../dist/transport/ssh.js";

function shellRunner(prefix = "") {
  return ([_host, command], input) => new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `${prefix}${command}`], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    // Stale-write rejection may exit before stdin can be consumed.
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
}

for (const remote of [false, true]) {
  const kind = remote ? "remote shell" : "local";
  const transport = (file, runner) => remote ? new SshTransport("test-host", file, runner ?? shellRunner()) : new LocalTransport(file);

  test(`${kind} creates a missing environment with private permissions`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "litenv-transport-"));
    const file = path.join(directory, ".env");
    const env = transport(file);
    assert.equal(await env.read(), "");
    await env.write("TOKEN=new-secret\n", { expectedContent: "" });
    assert.equal(await env.read(), "TOKEN=new-secret\n");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [".env"]);
  });

  test(`${kind} stale-write rejection preserves the newer file and removes temporary secrets`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "litenv-transport-stale-"));
    const file = path.join(directory, ".env");
    await writeFile(file, "TOKEN=original\n", { mode: 0o640 });
    const env = transport(file);
    const original = await env.read();
    await writeFile(file, "TOKEN=other-writer\n");
    await assert.rejects(env.write("TOKEN=my-secret\n", { expectedContent: original }), /changed since it was read/);
    assert.equal(await readFile(file, "utf8"), "TOKEN=other-writer\n");
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.deepEqual(await readdir(directory), [".env"]);
  });
}

test("remote shell writes quoted paths and Unicode values literally, preserving file mode", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-remote-quoted-"));
  const file = path.join(directory, "app's $(touch INJECTED); .env");
  const original = "TOKEN=🔐é\n";
  await writeFile(file, original, { mode: 0o640 });
  const env = new SshTransport("test-host", file, shellRunner());
  assert.equal(await env.read(), original);
  const replacement = "TOKEN=$(touch INJECTED)\nUNICODE=🔑🌍\n";
  await env.write(replacement, { expectedContent: original });
  assert.equal(await readFile(file, "utf8"), replacement);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(directory), [path.basename(file)]);
});

test("failed remote replacement removes its temporary secret and preserves the original", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-remote-failure-"));
  const file = path.join(directory, ".env");
  await writeFile(file, "TOKEN=original\n");
  const env = new SshTransport("test-host", file, shellRunner("mv() { echo 'replacement denied' >&2; return 1; }\n"));
  await assert.rejects(env.write("TOKEN=new-secret\n"), /SSH operation failed on test-host: replacement denied/);
  assert.equal(await readFile(file, "utf8"), "TOKEN=original\n");
  assert.deepEqual(await readdir(directory), [".env"]);
});

test("unsafe remote paths are rejected before SSH is invoked", async () => {
  let calls = 0;
  const runner = async () => { calls += 1; throw new Error("must not connect"); };
  for (const character of ["\0", "\n", "\r"]) {
    const env = new SshTransport("test-host", `/app/.env${character}injected`, runner);
    await assert.rejects(env.read(), /Remote file paths cannot contain control characters/);
    await assert.rejects(env.write("TOKEN=secret\n"), /Remote file paths cannot contain control characters/);
  }
  assert.equal(calls, 0);
});
