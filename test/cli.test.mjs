import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = path.resolve("dist/cli.js");

async function run(args, cwd, env = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
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
  const invalid = await run(["local", "set", "NOT_AN_ASSIGNMENT"], directory);
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
  assert.equal(result.stdout.includes("litenv diff ENVIRONMENT ENVIRONMENT"), false);
  assert.equal(result.stdout.includes("litenv diff prod"), false);
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
