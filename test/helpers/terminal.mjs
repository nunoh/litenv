import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
const plain = (value) => value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

export async function project() {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-interactive-"));
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(home);
  await mkdir(bin);
  // Exercise the real remote shell script locally, without SSH or a server.
  const ssh = path.join(bin, "ssh");
  await copyFile(fileURLToPath(new URL("./ssh", import.meta.url)), ssh);
  await chmod(ssh, 0o755);
  const staging = path.join(directory, ".env.staging");
  const prod = path.join(directory, ".env.prod");
  const reload = path.join(directory, "reloaded");
  await writeFile(path.join(directory, ".env"), "PORT=3000\nTOKEN=local-secret\n");
  await writeFile(staging, "PORT=4000\nTOKEN=staging-secret\n");
  await writeFile(prod, "PORT=5000\n");
  await writeFile(path.join(directory, ".env.example"), "PORT=\nTOKEN=\n");
  await writeFile(path.join(directory, "litenv.toml"), [
    "[env.staging]", 'host = "stage-box"', `file = ${JSON.stringify(staging)}`,
    "[env.prod]", 'host = "prod-box"', `file = ${JSON.stringify(prod)}`,
    `reload = ${JSON.stringify(`printf reloaded > ${quote(reload)}`)}`, "",
  ].join("\n"));
  return {
    directory, home, staging, prod, reload,
    environment: {
      HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      SHELL: "/bin/zsh", CI: "1",
    },
  };
}

export function terminal(t, fixture, args, overrides = {}) {
  const environment = { ...process.env, ...fixture.environment, ...overrides, NO_COLOR: "1" };
  delete environment.FORCE_COLOR;
  for (const key of Object.keys(environment)) if (environment[key] === undefined) delete environment[key];
  const helper = fileURLToPath(new URL("./terminal.py", import.meta.url));
  const child = spawn("python3", [helper, process.execPath, cli, ...args], {
    cwd: fixture.directory, env: environment, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let closed = false;
  const pending = new Set();
  function check() {
    for (const wait of pending) {
      if (wait.pattern.test(plain(output.slice(wait.offset)))) {
        pending.delete(wait);
        clearTimeout(wait.timer);
        wait.resolve();
      } else if (closed) {
        pending.delete(wait);
        clearTimeout(wait.timer);
        wait.reject(new Error(`CLI exited before ${wait.pattern}:\n${plain(output)}`));
      }
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output += chunk; check(); });
  }
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { closed = true; check(); resolve({ code, output: plain(output) }); });
  });
  t.after(() => {
    if (!closed) child.kill("SIGTERM");
    for (const wait of pending) clearTimeout(wait.timer);
  });
  const waitFor = (pattern, offset = 0) => new Promise((resolve, reject) => {
    const wait = { pattern, offset, resolve, reject };
    wait.timer = setTimeout(() => {
      pending.delete(wait);
      reject(new Error(`Timed out waiting for ${pattern}:\n${plain(output)}`));
    }, 8000);
    pending.add(wait);
    check();
  });
  return {
    waitFor,
    async send(input, pattern) {
      const offset = output.length;
      child.stdin.write(input);
      if (pattern) await waitFor(pattern, offset);
    },
    async result(code = 0) {
      const result = await done;
      assert.equal(result.code, code, result.output);
      return result.output;
    },
  };
}
