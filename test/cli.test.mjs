import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = path.resolve("dist/cli.js");

function plainEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides, NO_COLOR: "1" };
  delete environment.FORCE_COLOR;
  return environment;
}

async function run(args, cwd, env = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd, env: plainEnvironment(env) });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function runWithInput(args, cwd, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: plainEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("local CLI workflow works from a directory below the project root", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-cli-"));
  const nested = path.join(directory, "apps", "web");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(directory, "litenv.toml"), "# project marker\n", "utf8");
  await writeFile(path.join(directory, ".env.example"), "FOO=\nPORT=\nOPTIONAL= # optional\n", "utf8");
  await writeFile(path.join(directory, ".env"), "FOO=bar\n", "utf8");

  assert.deepEqual(await run(["local", "get", "FOO"], nested), { code: 0, stdout: "bar\n", stderr: "" });
  assert.equal((await run(["local", "check"], nested)).code, 1);
  assert.equal((await run(["local", "set", "PORT=3000"], nested)).stdout, "✓ PORT updated\n");
  assert.equal((await run(["local", "check"], nested)).code, 0);
  assert.equal((await run(["local", "show"], nested)).stdout, "FOO=bar\nPORT=3000\n");
  assert.equal((await run(["local", "show", "--redact"], nested)).stdout, "FOO=***\nPORT=****\n");
  assert.equal((await run(["local", "unset", "FOO", "MISSING"], nested)).stdout, "✓ FOO removed\n○ MISSING not found\n");
  assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "PORT=3000\n");
});

test("CLI uses exit code 2 for invalid usage and 1 for missing keys", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-errors-"));
  const invalid = await run(["local", "set", "NOT-A-KEY"], directory);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Invalid assignment/);
  const missing = await run(["local", "get", "MISSING"], directory);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, "MISSING not found\n");
});

test("help explains the optional environment prefix and only documents colon diff syntax", async () => {
  const result = await run(["--help"], process.cwd());
  assert.equal(result.code, 0);
  assert.match(result.stdout, /litenv \[environment] <command>/);
  assert.match(result.stdout, /\[environment] is optional/);
  assert.match(result.stdout, /litenv diff\s+Choose 2–3 environments interactively/);
  assert.match(result.stdout, /Colon selectors are required in scripts/);
  assert.match(result.stdout, /--reload\s+Run the configured remote reload without prompting/);
  assert.match(result.stdout, /--stdin\s+Read one set value from stdin/);
  assert.match(result.stdout, /list \[--names]\s+List local and configured remote environments/);
  assert.match(result.stdout, /completion zsh\s+Generate a Zsh completion script/);
  assert.match(result.stdout, /completion install \[zsh]\s+Enable Zsh completion in the shell startup file/);
  assert.match(result.stdout, /vars\s+Print variable names only/);
  assert.equal(result.stdout.includes("keys                       Print variable names only"), false);
  assert.equal(result.stdout.includes("litenv diff ENVIRONMENT ENVIRONMENT"), false);
  assert.equal(result.stdout.includes("litenv diff prod"), false);
});

test("completion zsh generates a valid dynamic completion script", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-completion-"));
  const result = await run(["completion", "zsh"], directory);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^#compdef litenv\n/);
  assert.match(result.stdout, /litenv list --names/);
  assert.match(result.stdout, /_describe -t environments 'environment' environments/);
  assert.match(result.stdout, /zstyle ':completion:\*:\*:litenv:\*' group-name ''/);
  assert.match(result.stdout, /zstyle ':completion:\*:\*:litenv:\*:descriptions' format '%B%d%b'/);
  assert.match(result.stdout, /compdef _litenv litenv/);
  assert.equal(result.stdout.includes(" ssh "), false);

  const script = path.join(directory, "_litenv");
  await writeFile(script, result.stdout, "utf8");
  await execute("zsh", ["-n", script]);

  const unsupported = await run(["completion", "bash"], directory);
  assert.equal(unsupported.code, 2);
  assert.match(unsupported.stderr, /^Usage: litenv completion zsh \| litenv completion install\|uninstall \[zsh]\n$/);
});

test("completion install and uninstall edit the Zsh startup file idempotently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-completion-install-"));
  const home = path.join(directory, "home");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  const zshrc = path.join(home, ".zshrc");
  await writeFile(zshrc, "export A=1\n", "utf8");
  const environment = { HOME: home, ZDOTDIR: "", XDG_CONFIG_HOME: path.join(home, ".config") };

  const installed = await run(["completion", "install"], directory, environment);
  assert.equal(installed.code, 0);
  assert.equal(installed.stderr, "");
  assert.match(installed.stdout, /^✓ Zsh completion enabled in ~\/\.zshrc$/m);
  assert.equal(await readFile(zshrc, "utf8"), [
    "export A=1",
    "",
    "# >>> litenv completion >>>",
    'eval "$(litenv completion zsh)"',
    "# <<< litenv completion <<<",
    "",
  ].join("\n"));

  const again = await run(["completion", "install", "zsh"], directory, environment);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /^○ Zsh completion is already enabled in ~\/\.zshrc$/m);
  assert.equal((await readFile(zshrc, "utf8")).match(/litenv completion zsh/g).length, 1);

  const removed = await run(["completion", "uninstall"], directory, environment);
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /^✓ Zsh completion removed from ~\/\.zshrc$/m);
  assert.equal(await readFile(zshrc, "utf8"), "export A=1\n");

  const removedAgain = await run(["completion", "uninstall"], directory, environment);
  assert.equal(removedAgain.code, 0);
  assert.match(removedAgain.stdout, /^○ Zsh completion is not enabled in ~\/\.zshrc$/m);

  const invalid = await run(["completion", "install", "bash"], directory, environment);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Usage: litenv completion zsh \| litenv completion install\|uninstall \[zsh]/);
});

test("list shows local and configured remote environments without connecting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-list-"));
  await writeFile(path.join(directory, "litenv.toml"), [
    "[project]",
    'file = "config/.env"',
    'local_name = "workstation"',
    "",
    "[env.staging]",
    'host = "stage-box"',
    'file = "/srv/app/.env"',
    "",
    "[env.prod]",
    'host = "prod-box"',
    'file = "/srv/app/.env"',
    "",
  ].join("\n"), "utf8");

  const result = await run(["list"], directory);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^ENVIRONMENT\s+TYPE\s+HOST\s+FILE$/m);
  assert.match(result.stdout, /^workstation \(local\)\s+local\s+—\s+config\/\.env$/m);
  assert.match(result.stdout, /^staging\s+remote\s+stage-box\s+\/srv\/app\/\.env$/m);
  assert.match(result.stdout, /^prod\s+remote\s+prod-box\s+\/srv\/app\/\.env$/m);
  assert.ok(result.stdout.indexOf("staging") < result.stdout.indexOf("prod"));
});

test("list --names prints usable target selectors in configuration order", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-list-names-"));
  await writeFile(path.join(directory, "litenv.toml"), [
    "[project]",
    'local_name = "workstation"',
    "[env.staging]",
    'host = "stage-box"',
    'file = "/srv/app/.env"',
    "[env.prod]",
    'host = "prod-box"',
    'file = "/srv/app/.env"',
  ].join("\n"), "utf8");

  assert.deepEqual(await run(["list", "--names"], directory), {
    code: 0,
    stdout: "local\nstaging\nprod\n",
    stderr: "",
  });
});

test("list works without a configuration file and rejects target-specific syntax", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-list-local-"));
  assert.deepEqual(await run(["list"], directory), {
    code: 0,
    stdout: [
      "ENVIRONMENT  TYPE   HOST  FILE",
      "───────────  ─────  ────  ────",
      "dev (local)  local  —     .env",
      "",
    ].join("\n"),
    stderr: "",
  });

  const targeted = await run(["local", "list"], directory);
  assert.equal(targeted.code, 2);
  assert.match(targeted.stderr, /Usage: litenv list \[--names]/);

  const unsupported = await run(["list", "--all"], directory);
  assert.equal(unsupported.code, 2);
  assert.match(unsupported.stderr, /--all is not supported by list/);
});

test("--version is read from package metadata", async () => {
  const metadata = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  const result = await run(["--version"], process.cwd());
  assert.deepEqual(result, { code: 0, stdout: `${metadata.version}\n`, stderr: "" });
});

test("set accepts one secret through stdin without printing it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-stdin-"));
  await writeFile(path.join(directory, ".env"), "PORT=3000\n", "utf8");
  const result = await runWithInput(["local", "set", "TOKEN", "--stdin", "--no-example"], directory, "top-secret\n");

  assert.deepEqual(result, { code: 0, stdout: "✓ TOKEN updated\n⚠ Not declared in .env.example: TOKEN\n", stderr: "" });
  assert.equal(result.stdout.includes("top-secret"), false);
  assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "PORT=3000\nTOKEN=top-secret\n");
});

test("set requires secure input syntax outside a terminal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-secure-input-"));
  const result = await run(["local", "set", "TOKEN"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Use TOKEN=VALUE or pipe it with --stdin/);
});

test("bare diff gives non-interactive callers a colon-selector instruction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-noninteractive-diff-"));
  const result = await run(["diff"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Interactive diff requires a terminal/);
  assert.match(result.stderr, /TARGET:TARGET\[:TARGET]/);
});

test("bare check gives non-interactive callers explicit target choices", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-noninteractive-check-"));
  const result = await run(["check"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Interactive check requires a terminal/);
  assert.match(result.stderr, /litenv local check/);
  assert.match(result.stderr, /litenv check --all/);
});

test("other bare environment commands also require an interactive terminal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-noninteractive-get-"));
  const result = await run(["get", "PORT"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Interactive get requires a terminal/);
  assert.match(result.stderr, /litenv local get/);
});

test("vars is the only command for listing variable names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-vars-"));
  await writeFile(path.join(directory, ".env"), "TOKEN=secret\nPORT=3000\n", "utf8");
  assert.deepEqual(await run(["local", "vars"], directory), {
    code: 0,
    stdout: "TOKEN\nPORT\n",
    stderr: "",
  });
  const legacy = await run(["local", "keys"], directory);
  assert.equal(legacy.code, 2);
  assert.match(legacy.stderr, /Unknown command or environment: keys/);
});

test("CLI mutation flags control sorting and example synchronization", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-flags-"));
  await writeFile(path.join(directory, "litenv.toml"), "# project marker\n", "utf8");
  await writeFile(path.join(directory, ".env"), "Z=last\nA=first\n", "utf8");
  await writeFile(path.join(directory, ".env.example"), "Z=\n", "utf8");

  const added = await run(["local", "set", "M=middle", "--example"], directory);
  assert.equal(added.code, 0);
  assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "A=first\nM=middle\nZ=last\n");
  assert.equal(await readFile(path.join(directory, ".env.example"), "utf8"), "M=\nZ=\n");

  const preserved = await run(["local", "set", "B=appended", "--no-sort", "--no-example"], directory);
  assert.equal(preserved.code, 0);
  assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "A=first\nM=middle\nZ=last\nB=appended\n");
});

test("check --all includes local validation and an aggregate summary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-check-all-"));
  await writeFile(path.join(directory, ".env"), "REQUIRED=yes\n", "utf8");
  await writeFile(path.join(directory, ".env.example"), "REQUIRED=\n", "utf8");

  const result = await run(["check", "--all"], directory);
  assert.deepEqual(result, {
    code: 0,
    stdout: "dev\n  Values file  .env\n  Schema file  .env.example\n\n  ✓ environment valid\n\nSummary\n  ✓ Valid (1): dev\n",
    stderr: "",
  });
});

test("check --all --summary prints only the complete diagnostic summary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-check-summary-"));
  await writeFile(path.join(directory, ".env"), "EXTRA=yes\n", "utf8");
  await writeFile(path.join(directory, ".env.example"), "REQUIRED=\n", "utf8");

  const result = await run(["check", "--all", "--summary"], directory);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("Values file"), false);
  assert.deepEqual(result.stdout, [
    "Summary",
    "  ✗ Invalid (1): dev",
    "",
    "Problems",
    "  dev",
    "    ✗ Missing required (1)",
    "      ✗ REQUIRED",
    "",
    "    ⚠ Not declared in .env.example (1)",
    "      ⚠ EXTRA",
    "",
  ].join("\n"));
});

test("get --all reads the key from local and every configured environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-get-all-"));
  await writeFile(path.join(directory, "litenv.toml"), [
    "[env.prod]",
    'host = "prod-host"',
    'file = "/app/.env"',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(directory, ".env"), "PORT=3000\n", "utf8");

  const binDirectory = path.join(directory, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(binDirectory);
  const ssh = path.join(binDirectory, "ssh");
  await writeFile(ssh, "#!/bin/sh\nprintf 'PORT=8080\\n'\n", "utf8");
  await chmod(ssh, 0o755);

  const result = await run(["get", "PORT", "--all"], directory, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ENVIRONMENT\s+VALUE\s+RESULT/);
  assert.match(result.stdout, /dev\s+3000\s+found/);
  assert.match(result.stdout, /prod\s+8080\s+found/);
});

test("remote mutations run the environment reload command after the file write", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-reload-"));
  await writeFile(path.join(directory, "litenv.toml"), [
    "[env.prod]",
    'host = "prod-host"',
    'file = "/app/.env"',
    'reload = "pm2 reload my-app --update-env"',
    "",
  ].join("\n"), "utf8");

  const binDirectory = path.join(directory, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(binDirectory);
  const logFile = path.join(directory, "ssh.log");
  const ssh = path.join(binDirectory, "ssh");
  await writeFile(ssh, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const command = process.argv[3];",
    'fs.appendFileSync(process.env.SSH_LOG, `${JSON.stringify(command)}\\n`);',
    'if (command.startsWith("if [ -e")) process.stdout.write("FOO=old\\n");',
    "",
  ].join("\n"), "utf8");
  await chmod(ssh, 0o755);

  const skipped = await run(["prod", "set", "FOO=new", "--no-example"], directory, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    SSH_LOG: logFile,
  });
  assert.equal(skipped.code, 0);
  assert.equal(skipped.stdout.includes("reload"), false);
  const skippedCalls = (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(skippedCalls.length, 2);
  await writeFile(logFile, "", "utf8");

  const result = await run(["prod", "set", "FOO=new", "--no-example", "--reload"], directory, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    SSH_LOG: logFile,
  });

  assert.deepEqual(result, {
    code: 0,
    stdout: "✓ prod: FOO updated\n○ prod: running reload\n✓ prod: reload complete\n⚠ Not declared in .env.example: FOO\n",
    stderr: "",
  });
  const calls = (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.equal(calls[2], "pm2 reload my-app --update-env");
});

test("--reload fails before writing when the selected environment has no reload command", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-missing-reload-"));
  await writeFile(path.join(directory, ".env"), "FOO=old\n", "utf8");

  const result = await run(["local", "set", "FOO=new", "--reload"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--reload requires a reload command/);
  assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "FOO=old\n");
});

test("project config controls local paths, sorting, and strict undeclared checks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-project-config-"));
  await writeFile(path.join(directory, "litenv.toml"), [
    "[project]",
    'file = ".env.local"',
    'example = ".env.sample"',
    'local_name = "workstation"',
    "sort = false",
    'undeclared = "error"',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(directory, ".env.local"), "Z=last\nA=first\n", "utf8");
  await writeFile(path.join(directory, ".env.sample"), "A=\nZ=\n", "utf8");

  assert.equal((await run(["local", "show"], directory)).stdout, "Z=last\nA=first\n");
  await run(["local", "set", "M=middle", "--no-example"], directory);
  assert.equal(await readFile(path.join(directory, ".env.local"), "utf8"), "Z=last\nA=first\nM=middle\n");
  assert.equal((await run(["local", "check"], directory)).code, 1);

  await run(["local", "set", "M=middle", "--example", "--sort"], directory);
  assert.equal(await readFile(path.join(directory, ".env.local"), "utf8"), "A=first\nM=middle\nZ=last\n");
  const checked = await run(["local", "check"], directory);
  assert.equal(checked.code, 0);
  assert.match(checked.stdout, /Check\n  Environment  workstation \(local\)\n  Values file  \.env\.local\n  Schema file  \.env\.sample\n/);
});

test("paired target syntax compares two configured environments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-paired-diff-"));
  const binDirectory = path.join(directory, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(binDirectory);
  await writeFile(path.join(directory, "litenv.toml"), [
    "[env.prod]",
    'host = "prod-host"',
    'file = "/app/.env"',
    "",
    "[env.staging]",
    'host = "staging-host"',
    'file = "/app/.env"',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(directory, ".env"), "PORT=3000\nMODE=dev\nLOCAL_ONLY=yes\n", "utf8");
  const ssh = path.join(binDirectory, "ssh");
  await writeFile(ssh, [
    "#!/usr/bin/env node",
    'const host = process.argv[2];',
    'process.stdout.write(host === "prod-host" ? "PORT=3000\\nMODE=prod\\n" : "PORT=3000\\nMODE=staging\\n");',
    "",
  ].join("\n"), "utf8");
  await chmod(ssh, 0o755);

  const result = await run(["prod:staging", "diff", "--values"], directory, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /KEY\s+PROD\s+STAGING\s+RESULT/);
  assert.match(result.stdout, /MODE\s+prod\s+staging\s+different/);
  assert.match(result.stdout, /PORT\s+3000\s+3000\s+same/);

  const threeWay = await run([":staging:prod", "diff", "--values"], directory, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(threeWay.code, 0);
  assert.match(threeWay.stdout, /KEY\s+DEV\s+STAGING\s+PROD\s+RESULT/);
  assert.match(threeWay.stdout, /LOCAL_ONLY\s+yes\s+—\s+—\s+only dev/);
  assert.match(threeWay.stdout, /MODE\s+dev\s+staging\s+prod\s+different/);

  const legacy = await run(["diff", "prod"], directory, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(legacy.code, 2);
  assert.match(legacy.stderr, /TARGET:TARGET/);
});

test("--stdin is rejected by commands other than set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-stdin-command-"));
  const result = await run(["local", "get", "FOO", "--stdin"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--stdin is not supported by get/);
});

test("--stdin requires exactly one bare variable name", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-stdin-arity-"));
  const many = await run(["local", "set", "ONE", "TWO", "--stdin"], directory);
  assert.equal(many.code, 2);
  assert.match(many.stderr, /--stdin requires exactly one variable name/);

  const assignment = await run(["local", "set", "TOKEN=value", "--stdin"], directory);
  assert.equal(assignment.code, 2);
  assert.match(assignment.stderr, /--stdin requires exactly one variable name/);

  const badKey = await runWithInput(["local", "set", "NOT-A-KEY", "--stdin"], directory, "value\n");
  assert.equal(badKey.code, 2);
  assert.match(badKey.stderr, /Invalid environment variable name: NOT-A-KEY/);
});

test("a diff selector must name two or three targets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-diff-selector-"));
  const result = await run(["a:b:c:d", "diff"], directory);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /A diff selector must contain two or three targets/);
});
