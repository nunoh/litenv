import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkCommand,
  checkAllCommand,
  diffCommand,
  getAllCommand,
  getCommand,
  varsCommand,
  setCommand,
  showCommand,
  sortCommand,
  unsetCommand,
} from "../dist/commands/index.js";
import { parseConfig, loadConfig } from "../dist/config/load.js";
import { LocalTransport } from "../dist/transport/local.js";
import { posixCksum, SshTransport } from "../dist/transport/ssh.js";

class MemoryTransport {
  constructor(content = "") { this.content = content; }
  async read() { return this.content; }
  async write(content) { this.content = content; }
}

function setup(content = "", schemaFile = "/unused/.env.example", targetName) {
  const out = [];
  const errors = [];
  const transport = new MemoryTransport(content);
  const io = { out: (line) => out.push(line), error: (line) => errors.push(line) };
  const context = { transport, schemaFile, io, ...(targetName ? { targetName } : {}) };
  return { context, transport, out, errors };
}

test("get and vars produce undecorated script-friendly output", async () => {
  const fixture = setup("FOO=bar\nPORT=3000\n");
  assert.equal(await getCommand(fixture.context, ["FOO"]), 0);
  assert.deepEqual(fixture.out, ["bar"]);
  fixture.out.length = 0;
  assert.equal(await varsCommand(fixture.context, []), 0);
  assert.deepEqual(fixture.out, ["FOO", "PORT"]);
});

test("get --all labels values and continues after missing or failed lookups", async () => {
  const fixture = setup();
  const unavailable = {
    async read() { throw new Error("connection refused"); },
    async write() { throw new Error("not used"); },
  };
  const code = await getAllCommand(fixture.context.io, [
    { name: "dev", transport: new MemoryTransport("PORT=3000\n") },
    { name: "staging", transport: new MemoryTransport("OTHER=yes\n") },
    { name: "prod", transport: unavailable },
  ], ["PORT"]);
  assert.equal(code, 1);
  assert.deepEqual(fixture.out, [
    "ENVIRONMENT  VALUE  RESULT",
    "───────────  ─────  ──────────────────────────",
    "dev          3000   found",
    "staging      —      not found",
    "prod         —      failed: connection refused",
  ]);
});

test("set and unset mutate through the transport without printing values", async () => {
  const fixture = setup("FOO=old # keep\n", "/unused/.env.example", "prod");
  await setCommand(fixture.context, ["FOO=top-secret", "PORT=3000"]);
  assert.equal(fixture.transport.content, "FOO=top-secret # keep\nPORT=3000\n");
  assert.deepEqual(fixture.out, [
    "✓ prod: FOO updated",
    "✓ prod: PORT updated",
    "⚠ Not declared in .env.example: FOO, PORT",
    "  Use --example to add empty placeholders.",
  ]);
  assert.equal(fixture.out.join("\n").includes("top-secret"), false);

  fixture.out.length = 0;
  await unsetCommand(fixture.context, ["PORT", "MISSING"]);
  assert.deepEqual(fixture.out, ["✓ prod: PORT removed", "○ prod: MISSING not found"]);
});

test("write commands run a configured reload only after an actual write", async () => {
  const fixture = setup("FOO=old\n", "/unused/.env.example", "prod");
  let reloads = 0;
  fixture.context.reload = async () => { reloads += 1; };

  await setCommand(fixture.context, ["FOO=new"], { example: "never", reload: "always" });
  assert.equal(reloads, 1);
  assert.deepEqual(fixture.out, [
    "✓ prod: FOO updated",
    "○ prod: running reload",
    "✓ prod: reload complete",
    "⚠ Not declared in .env.example: FOO",
  ]);

  fixture.out.length = 0;
  await unsetCommand(fixture.context, ["MISSING"], { reload: "always" });
  assert.equal(reloads, 1);
  assert.deepEqual(fixture.out, ["○ prod: MISSING not found"]);

  fixture.out.length = 0;
  await unsetCommand(fixture.context, ["FOO"], { reload: "always" });
  assert.equal(reloads, 2);
  assert.deepEqual(fixture.out, [
    "✓ prod: FOO removed",
    "○ prod: running reload",
    "✓ prod: reload complete",
  ]);

  fixture.out.length = 0;
  await sortCommand(fixture.context, [], { reload: "always" });
  assert.equal(reloads, 3);
  assert.deepEqual(fixture.out, [
    "✓ prod environment sorted",
    "○ prod: running reload",
    "✓ prod: reload complete",
  ]);
});

test("reload failure clearly reports that the environment file was already updated", async () => {
  const fixture = setup("FOO=old\n", "/unused/.env.example", "prod");
  fixture.context.reload = async () => { throw new Error("pm2 reload failed"); };

  await assert.rejects(
    setCommand(fixture.context, ["FOO=new"], { example: "never", reload: "always" }),
    /prod: environment file updated, but reload failed: pm2 reload failed/,
  );
  assert.equal(fixture.transport.content, "FOO=new\n");
  assert.deepEqual(fixture.out, [
    "✓ prod: FOO updated",
    "○ prod: running reload",
  ]);
});

test("forced reload without a configured command fails before writing", async () => {
  const fixture = setup("FOO=old\n", "/unused/.env.example", "prod");
  await assert.rejects(
    setCommand(fixture.context, ["FOO=new"], { example: "never", reload: "always" }),
    /--reload requires a reload command/,
  );
  assert.equal(fixture.transport.content, "FOO=old\n");
  assert.deepEqual(fixture.out, []);
});

test("reload prompt defaults to skipping the configured command", async () => {
  const fixture = setup("FOO=old\n", "/unused/.env.example", "prod");
  const questions = [];
  let reloads = 0;
  fixture.context.reload = async () => { reloads += 1; };
  fixture.context.confirm = async (question) => {
    questions.push(question);
    return false;
  };

  await setCommand(fixture.context, ["FOO=new"], { example: "never", reload: "prompt" });
  assert.equal(reloads, 0);
  assert.deepEqual(questions, ["Run reload command for prod?"]);
  assert.deepEqual(fixture.out, [
    "✓ prod: FOO updated",
    "⚠ Not declared in .env.example: FOO",
  ]);
});

test("show displays values by default and redacts with explicit opt-in", async () => {
  const fixture = setup("TOKEN=secret\nPORT=3000\n");
  await showCommand(fixture.context, [], false);
  assert.deepEqual(fixture.out, ["TOKEN=secret", "PORT=3000"]);
  fixture.out.length = 0;
  await showCommand(fixture.context, [], true);
  assert.deepEqual(fixture.out, ["TOKEN=******", "PORT=****"]);
});

test("check uses a local example and returns validation exit status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-check-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "REQUIRED=\nOPTIONAL= # optional\n", "utf8");
  const fixture = setup("EXTRA=value\n", schemaFile, "prod");
  assert.equal(await checkCommand(fixture.context, []), 1);
  assert.deepEqual(fixture.out, [
    "○ OPTIONAL optional, missing",
    "",
    "Problems",
    "  ✗ Missing required (1)",
    "    ✗ REQUIRED",
    "",
    "  ⚠ Not declared in .env.example (1)",
    "    ⚠ EXTRA",
    "",
    "✗ prod environment invalid",
  ]);
});

test("check clearly reports undeclared variables without failing an otherwise valid environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-extra-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "REQUIRED=\n", "utf8");
  const fixture = setup("REQUIRED=yes\nUNDECLARED=value\n", schemaFile);
  assert.equal(await checkCommand(fixture.context, []), 0);
  assert.deepEqual(fixture.out, [
    "✓ REQUIRED",
    "",
    "Problems",
    "  ⚠ Not declared in .env.example (1)",
    "    ⚠ UNDECLARED",
    "",
    "✓ environment valid with warnings",
  ]);
});

test("check lists every problem variable on its own summary line", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-problems-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "DATABASE_URL=\nJWT_SECRET=\nPORT=\n", "utf8");
  const fixture = setup("DEBUG_TOOL=yes\nLEGACY_API_KEY=set\n", schemaFile, "prod");
  assert.equal(await checkCommand(fixture.context, []), 1);
  assert.deepEqual(fixture.out, [
    "Problems",
    "  ✗ Missing required (3)",
    "    ✗ DATABASE_URL",
    "    ✗ JWT_SECRET",
    "    ✗ PORT",
    "",
    "  ⚠ Not declared in .env.example (2)",
    "    ⚠ DEBUG_TOOL",
    "    ⚠ LEGACY_API_KEY",
    "",
    "✗ prod environment invalid",
  ]);
});

test("terminal check output bolds variable names while script output stays plain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-styling-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "REQUIRED=\nOPTIONAL= # optional\n", "utf8");
  const fixture = setup("EXTRA=value\n", schemaFile);
  fixture.context.io.color = true;
  await checkCommand(fixture.context, []);
  assert.equal(fixture.out.some((line) => line.includes("\u001b[1mREQUIRED\u001b[0m")), true);
  assert.equal(fixture.out.some((line) => line.includes("\u001b[1mEXTRA\u001b[0m")), true);
  assert.equal(fixture.out.some((line) => line.includes("\u001b[2moptional, missing\u001b[0m")), true);

  fixture.out.length = 0;
  await varsCommand(fixture.context, []);
  assert.deepEqual(fixture.out, ["EXTRA"]);
  fixture.out.length = 0;
  await getCommand(fixture.context, ["EXTRA"]);
  assert.deepEqual(fixture.out, ["value"]);
});

test("check --all groups every target, continues after failures, and summarizes results", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-all-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "REQUIRED=\n", "utf8");
  const fixture = setup();
  const unavailable = {
    async read() { throw new Error("connection refused"); },
    async write() { throw new Error("not used"); },
  };

  const code = await checkAllCommand(schemaFile, [
    { name: "Local", transport: new MemoryTransport("REQUIRED=yes\n") },
    { name: "preview", transport: new MemoryTransport("REQUIRED=yes\nEXTRA=value\n") },
    { name: "prod", transport: new MemoryTransport("") },
    { name: "staging", transport: unavailable },
  ], fixture.context.io);

  assert.equal(code, 1);
  assert.deepEqual(fixture.out, [
    "Local",
    "  ✓ environment valid",
    "",
    "preview",
    "  ✓ REQUIRED",
    "",
    "  Problems",
    "    ⚠ Not declared in .env.example (1)",
    "      ⚠ EXTRA",
    "",
    "  ✓ environment valid with warnings",
    "",
    "prod",
    "  Problems",
    "    ✗ Missing required (1)",
    "      ✗ REQUIRED",
    "",
    "  ✗ environment invalid",
    "",
    "staging",
    "  ✗ connection refused",
    "",
    "Summary",
    "  ✓ Valid (1): Local",
    "  ⚠ Warnings (1): preview",
    "  ✗ Invalid (1): prod",
    "  ✗ Failed (1): staging",
    "",
    "Problems",
    "  preview",
    "    ⚠ Not declared in .env.example (1)",
    "      ⚠ EXTRA",
    "",
    "  prod",
    "    ✗ Missing required (1)",
    "      ✗ REQUIRED",
    "",
    "  staging",
    "    ✗ connection refused",
  ]);
});

test("check --summary hides environment sections but retains every problem", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-summary-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "REQUIRED=\n", "utf8");
  const fixture = setup();

  const code = await checkAllCommand(schemaFile, [
    { name: "preview", transport: new MemoryTransport("REQUIRED=yes\nEXTRA=value\n") },
    { name: "prod", transport: new MemoryTransport("") },
  ], fixture.context.io, "warn", undefined, true);

  assert.equal(code, 1);
  assert.deepEqual(fixture.out, [
    "Summary",
    "  ⚠ Warnings (1): preview",
    "  ✗ Invalid (1): prod",
    "",
    "Problems",
    "  preview",
    "    ⚠ Not declared in .env.example (1)",
    "      ⚠ EXTRA",
    "",
    "  prod",
    "    ✗ Missing required (1)",
    "      ✗ REQUIRED",
  ]);
});

test("sort writes the sorted document through the transport", async () => {
  const fixture = setup("# section\nZ=1\nA=2\n");
  await sortCommand(fixture.context, []);
  assert.equal(fixture.transport.content, "# section\nA=2\nZ=1\n");
});

test("mutations sort by default and --no-sort preserves order", async () => {
  const sorted = setup("Z=1\nA=2\n");
  await setCommand(sorted.context, ["M=3"], { example: "never" });
  assert.equal(sorted.transport.content, "A=2\nM=3\nZ=1\n");

  const preserved = setup("Z=1\nA=2\n");
  await setCommand(preserved.context, ["M=3"], { sort: false, example: "never" });
  assert.equal(preserved.transport.content, "Z=1\nA=2\nM=3\n");
});

test("set can add missing keys to .env.example without copying values", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-example-"));
  const schemaFile = path.join(directory, ".env.example");
  await writeFile(schemaFile, "Z_EXISTING=\n", "utf8");
  const fixture = setup("", schemaFile);
  fixture.context.confirm = async () => true;
  await setCommand(fixture.context, ["API_KEY=top-secret", "PORT=3000"]);
  assert.equal(await readFile(schemaFile, "utf8"), "API_KEY=\nPORT=\nZ_EXISTING=\n");
  assert.equal((await readFile(schemaFile, "utf8")).includes("top-secret"), false);
  assert.equal(fixture.out.includes("✓ .env.example updated: API_KEY, PORT"), true);
});

test("diff redacts by default and can explicitly include values", async () => {
  const local = new MemoryTransport("FOO=local-secret\nSAME=x\n");
  const fixture = setup("FOO=remote-secret\nSAME=x\n", "/unused", "prod");
  await diffCommand(fixture.context.io, [
    { name: "local", transport: local },
    { name: "prod", transport: fixture.transport },
  ], [], false);
  assert.equal(fixture.out.join("\n").includes("secret"), false);
  assert.match(fixture.out[0], /KEY\s+LOCAL\s+PROD\s+RESULT/);
  assert.match(fixture.out.find((line) => line.startsWith("FOO")), /present\s+present\s+different/);

  fixture.out.length = 0;
  await diffCommand(fixture.context.io, [
    { name: "local", transport: local },
    { name: "prod", transport: fixture.transport },
  ], [], true);
  assert.match(fixture.out.find((line) => line.startsWith("FOO")), /local-secret\s+remote-secret\s+different/);
});

test("diff tables sort keys and escape values that would break terminal rows", async () => {
  const local = new MemoryTransport('Z="line\\nnext"\nESC="safe\\tvalue"\n');
  const fixture = setup('A=first\nESC="other\\tvalue"\n', "/unused", "prod");
  await diffCommand(fixture.context.io, [
    { name: "local", transport: local },
    { name: "prod", transport: fixture.transport },
  ], [], true);
  const dataRows = fixture.out.slice(2);
  assert.equal(dataRows[0].startsWith("A"), true);
  assert.equal(dataRows[1].startsWith("ESC"), true);
  assert.equal(dataRows[2].startsWith("Z"), true);
  assert.equal(fixture.out.join("\n").includes("safe\\tvalue"), true);
  assert.equal(fixture.out.join("\n").includes("line\\nnext"), true);
});

test("diff labels comparisons between two named environments", async () => {
  const staging = new MemoryTransport("SHARED=staging\nSTAGING_ONLY=yes\n");
  const fixture = setup("PROD_ONLY=yes\nSHARED=prod\n", "/unused", "prod");
  await diffCommand(fixture.context.io, [
    { name: "staging", transport: staging },
    { name: "prod", transport: fixture.transport },
  ], [], true);
  assert.match(fixture.out[0], /KEY\s+STAGING\s+PROD\s+RESULT/);
  assert.match(fixture.out.find((line) => line.startsWith("PROD_ONLY")), /only prod/);
  assert.match(fixture.out.find((line) => line.startsWith("STAGING_ONLY")), /only staging/);
});

test("diff supports a three-way environment matrix", async () => {
  const fixture = setup();
  await diffCommand(fixture.context.io, [
    { name: "dev", transport: new MemoryTransport("ALL=same\nMODE=dev\nDEV_ONLY=yes\nPAIR=x\n") },
    { name: "staging", transport: new MemoryTransport("ALL=same\nMODE=staging\nPAIR=x\n") },
    { name: "prod", transport: new MemoryTransport("ALL=same\nMODE=prod\n") },
  ], [], true);
  assert.match(fixture.out[0], /KEY\s+DEV\s+STAGING\s+PROD\s+RESULT/);
  assert.match(fixture.out.find((line) => line.startsWith("ALL")), /same/);
  assert.match(fixture.out.find((line) => line.startsWith("DEV_ONLY")), /only dev/);
  assert.match(fixture.out.find((line) => line.startsWith("MODE")), /different/);
  assert.match(fixture.out.find((line) => line.startsWith("PAIR")), /missing in prod/);
});

test("local transport writes atomically and preserves permissions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-local-"));
  const file = path.join(directory, ".env");
  await writeFile(file, "FOO=old\n", { mode: 0o640 });
  const transport = new LocalTransport(file);
  await transport.write("FOO=new\n");
  assert.equal(await readFile(file, "utf8"), "FOO=new\n");
  assert.equal((await stat(file)).mode & 0o777, 0o640);
});

test("local transport refuses to overwrite a file changed since reading", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-local-stale-"));
  const file = path.join(directory, ".env");
  await writeFile(file, "FOO=old\n", "utf8");
  const transport = new LocalTransport(file);
  const original = await transport.read();
  await writeFile(file, "FOO=changed-elsewhere\n", "utf8");

  await assert.rejects(
    transport.write("FOO=mine\n", { expectedContent: original }),
    /changed since it was read; no changes were written/,
  );
  assert.equal(await readFile(file, "utf8"), "FOO=changed-elsewhere\n");
});

test("POSIX checksums match the remote cksum format", () => {
  assert.equal(posixCksum(""), "4294967295 0");
  assert.equal(posixCksum("FOO=bar\n"), "120070710 8");
  assert.equal(posixCksum("hello"), "3287646509 5");
});

test("SSH transport streams file contents over stdin, never in the command", async () => {
  const calls = [];
  const runner = async (args, input) => {
    calls.push({ args, input });
    return calls.length === 1
      ? { stdout: "FOO=old\n", stderr: "", code: 0 }
      : { stdout: "", stderr: "", code: 0 };
  };
  const transport = new SshTransport("app-host", "/srv/app's files/.env", runner);
  const fixture = setup();
  fixture.context.transport = transport;
  await setCommand(fixture.context, ["FOO=very-secret"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], "app-host");
  assert.equal(calls[1].args[1].includes("very-secret"), false);
  assert.equal(calls[1].input, "FOO=very-secret\n");
  assert.match(calls[1].args[1], /mktemp/);
  assert.match(calls[1].args[1], /mv -f/);
  assert.match(calls[1].args[1], /expected_cksum='1863560420 8'/);
  assert.match(calls[1].args[1], /changed since it was read/);
});

test("SSH transport reports a stale remote file without sending secrets in the command", async () => {
  const calls = [];
  const runner = async (args, input) => {
    calls.push({ args, input });
    return calls.length === 1
      ? { stdout: "FOO=old\n", stderr: "", code: 0 }
      : { stdout: "", stderr: "environment file changed since it was read; no changes were written. Retry the command.\n", code: 73 };
  };
  const fixture = setup();
  fixture.context.transport = new SshTransport("app-host", "/srv/app/.env", runner);

  await assert.rejects(
    setCommand(fixture.context, ["FOO=very-secret"], { example: "never" }),
    /changed since it was read; no changes were written/,
  );
  assert.equal(calls[1].args[1].includes("very-secret"), false);
  assert.equal(calls[1].input, "FOO=very-secret\n");
});

test("SSH transport runs configured commands on the same host", async () => {
  const calls = [];
  const runner = async (args, input) => {
    calls.push({ args, input });
    return { stdout: "reloaded\n", stderr: "", code: 0 };
  };
  const transport = new SshTransport("app-host", "/srv/app/.env", runner);
  await transport.runCommand("pm2 reload my-app --update-env");
  assert.deepEqual(calls, [{
    args: ["app-host", "pm2 reload my-app --update-env"],
    input: undefined,
  }]);
});

test("configuration parsing and upward discovery find project environments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-config-"));
  const nested = path.join(directory, "apps", "web");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(nested, { recursive: true });
  const file = path.join(directory, "litenv.toml");
  await writeFile(file, '[project]\nfile = ".env.local"\nexample = ".env.sample"\nlocal_name = "workstation"\nsort = false\nundeclared = "error"\n\n[env.prod]\nhost = "app-prod"\nfile = "/srv/my-app/.env"\nreload = "pm2 reload my-app --update-env"\n', "utf8");
  const config = await loadConfig(nested);
  assert.equal(config?.path, file);
  assert.deepEqual(config?.project, {
    file: ".env.local",
    example: ".env.sample",
    localName: "workstation",
    sort: false,
    undeclared: "error",
  });
  assert.deepEqual(config?.environments.prod, {
    host: "app-prod",
    file: "/srv/my-app/.env",
    reload: "pm2 reload my-app --update-env",
  });

  const defaults = parseConfig("[env.stage]\nhost='stage'\nfile='/app/.env' # note\n", file);
  assert.deepEqual(defaults.project, {
    file: ".env",
    example: ".env.example",
    localName: "dev",
    sort: true,
    undeclared: "warn",
  });
  assert.deepEqual(defaults.environments.stage, { host: "stage", file: "/app/.env" });
});

test("configuration rejects empty or multiline reload commands", () => {
  const file = "/project/litenv.toml";
  assert.throws(
    () => parseConfig("[env.prod]\nhost='prod'\nfile='/app/.env'\nreload=''\n", file),
    /env\.prod\.reload cannot be empty/,
  );
  assert.throws(
    () => parseConfig('[env.prod]\nhost="prod"\nfile="/app/.env"\nreload="first\\nsecond"\n', file),
    /env\.prod\.reload cannot contain control characters/,
  );
});

test("local transport surfaces stat failures other than a missing file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "litenv-local-stat-"));
  const blocker = path.join(directory, "blocker");
  await writeFile(blocker, "not a directory\n", "utf8");
  const transport = new LocalTransport(path.join(blocker, ".env"));

  await assert.rejects(transport.write("FOO=bar\n"), (error) => error.code === "ENOTDIR");
});
