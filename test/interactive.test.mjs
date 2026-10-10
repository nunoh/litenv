import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { project, terminal } from "./helpers/terminal.mjs";

const options = { timeout: 15000 };

test("interactive diff with no remote environments fails before opening a selector", options, async (t) => {
  const fixture = await project();
  await writeFile(path.join(fixture.directory, "litenv.toml"), "# local only\n");
  const output = await terminal(t, fixture, ["diff"]).result(2);
  assert.match(output, /No configured environments are available to compare with local/);
  assert.doesNotMatch(output, /Select 2–3 environments|KEY\s+DEV/);
});

test("interactive three-way diff prints the selected command and keeps values hidden", options, async (t) => {
  const fixture = await project();
  const cli = terminal(t, fixture, ["diff"]);
  await cli.waitFor(/Select 2–3 environments/);
  await cli.send(" ", /1 selected/);
  await cli.send("j", /› ○ staging/);
  await cli.send(" ", /2 selected/);
  await cli.send("j", /› ○ prod/);
  await cli.send(" ", /3 selected/);
  await cli.send("\r");
  const output = await cli.result();
  assert.match(output, /Command\n  `litenv :staging:prod diff`/);
  assert.match(output, /KEY\s+DEV\s+STAGING\s+PROD\s+RESULT/);
  assert.match(output, /TOKEN\s+present\s+present\s+—\s+missing in prod/);
  assert.doesNotMatch(output, /local-secret|staging-secret|stage-box|prod-box/);
});

test("interactive two-way diff honours the explicit values option", options, async (t) => {
  const cli = terminal(t, await project(), ["diff", "--values"]);
  await cli.waitFor(/Select 2–3 environments/);
  await cli.send(" ", /1 selected/);
  await cli.send("j", /› ○ staging/);
  await cli.send(" ", /2 selected/);
  await cli.send("\r");
  const output = await cli.result();
  assert.match(output, /`litenv :staging diff --values`/);
  assert.match(output, /TOKEN\s+local-secret\s+staging-secret\s+different/);
});

test("interactive multi-check retains every problem in summary-only output", options, async (t) => {
  const fixture = await project();
  await writeFile(fixture.staging, "PORT=4000\nTOKEN=staging-secret\nDEBUG_TOOL=yes\n");
  const cli = terminal(t, fixture, ["check", "--summary"]);
  await cli.waitFor(/Select environments to check/);
  await cli.send(" ", /1 selected/);
  await cli.send("j", /› ○ staging/);
  await cli.send(" ", /2 selected/);
  await cli.send("j", /› ○ prod/);
  await cli.send(" ", /3 selected/);
  await cli.send("\r");
  const output = await cli.result(1);
  assert.match(output, /`litenv local check --summary`/);
  assert.match(output, /`litenv staging check --summary`/);
  assert.match(output, /`litenv prod check --summary`/);
  assert.match(output, /Valid \(1\): dev/);
  assert.match(output, /Warnings \(1\): staging/);
  assert.match(output, /Invalid \(1\): prod/);
  assert.match(output, /staging\n\s+⚠ Not declared.*\n\s+⚠ DEBUG_TOOL/);
  assert.match(output, /prod\n\s+✗ Missing required.*\n\s+✗ TOKEN/);
  assert.doesNotMatch(output, /Values file|local-secret|staging-secret/);
});

for (const target of ["local", "staging"]) {
  test(`interactive single-check resolves ${target} and identifies its file`, options, async (t) => {
    const fixture = await project();
    const cli = terminal(t, fixture, ["check"]);
    await cli.waitFor(/Select environments to check/);
    if (target === "staging") await cli.send("j", /› ○ staging/);
    await cli.send(" ", /1 selected/);
    await cli.send("\r");
    const output = await cli.result();
    assert.match(output, new RegExp(`\x60litenv ${target} check\x60`));
    assert.match(output, target === "local" ? /Environment\s+dev \(local\)/ : /Environment\s+staging/);
    assert.match(output, target === "local" ? /Values file\s+\.env/ : /Values file\s+stage-box:.*\.env.staging/);
  });
}

test("interactive show selects a remote target and preserves redaction", options, async (t) => {
  const cli = terminal(t, await project(), ["show", "--redact"]);
  await cli.waitFor(/Select an environment for show/);
  await cli.send("j", /› staging/);
  await cli.send("\r");
  const output = await cli.result();
  assert.match(output, /`litenv staging show --redact`/);
  assert.match(output, /TOKEN=\*+/);
  assert.doesNotMatch(output, /staging-secret/);
});

for (const [command, title, key, message] of [
  ["diff", /Select 2–3 environments/, "q", "Comparison cancelled"],
  ["check", /Select environments to check/, "\u0003", "Check cancelled"],
  ["set", /Select an environment for set/, "q", "set cancelled"],
]) {
  test(`cancelling interactive ${command} leaves files unchanged`, options, async (t) => {
    const fixture = await project();
    const file = path.join(fixture.directory, ".env");
    const original = await readFile(file, "utf8");
    const cli = terminal(t, fixture, command === "set" ? [command, "TOKEN=new-secret"] : [command]);
    await cli.waitFor(title);
    await cli.send(key);
    const output = await cli.result(1);
    assert.ok(output.includes(message), output);
    assert.doesNotMatch(output, /Command\n|updated|new-secret/);
    assert.equal(await readFile(file, "utf8"), original);
  });
}

test("hidden value entry writes multiple values without echo or schema secrets", options, async (t) => {
  const fixture = await project();
  const cli = terminal(t, fixture, ["local", "set", "TOKEN", "API_KEY"]);
  await cli.waitFor(/Value for TOKEN \(input hidden\):/);
  await cli.send("first-secret\r", /Value for API_KEY \(input hidden\):/);
  await cli.send("second-secret\r", /Add it\? \[y\/N\]/);
  await cli.send("y\r");
  const output = await cli.result();
  assert.match(output, /TOKEN updated/);
  assert.match(output, /API_KEY updated/);
  assert.doesNotMatch(output, /first-secret|second-secret/);
  assert.equal(await readFile(path.join(fixture.directory, ".env"), "utf8"), "API_KEY=second-secret\nPORT=3000\nTOKEN=first-secret\n");
  assert.equal(await readFile(path.join(fixture.directory, ".env.example"), "utf8"), "API_KEY=\nPORT=\nTOKEN=\n");
});

test("cancelling the second hidden value aborts the whole mutation", options, async (t) => {
  const fixture = await project();
  const file = path.join(fixture.directory, ".env");
  const original = await readFile(file, "utf8");
  const cli = terminal(t, fixture, ["local", "set", "TOKEN", "API_KEY"]);
  await cli.waitFor(/Value for TOKEN \(input hidden\):/);
  await cli.send("first-secret\r", /Value for API_KEY \(input hidden\):/);
  await cli.send("second-secret\u0003");
  const output = await cli.result(1);
  assert.match(output, /Value entry cancelled/);
  assert.doesNotMatch(output, /first-secret|second-secret|updated/);
  assert.equal(await readFile(file, "utf8"), original);
});

test("selected mutations print a redacted command with their actual options", options, async (t) => {
  const fixture = await project();
  const cli = terminal(t, fixture, ["set", "TOKEN=new-secret", "--no-sort", "--no-example"]);
  await cli.waitFor(/Select an environment for set/);
  await cli.send("\r");
  const output = await cli.result();
  assert.match(output, /`litenv local set TOKEN=… --no-sort --no-example`/);
  assert.doesNotMatch(output, /new-secret/);
  assert.equal(await readFile(path.join(fixture.directory, ".env"), "utf8"), "PORT=3000\nTOKEN=new-secret\n");
});

test("example synchronization defaults to no and retains undeclared warnings", options, async (t) => {
  const fixture = await project();
  const schema = path.join(fixture.directory, ".env.example");
  const original = await readFile(schema, "utf8");
  const cli = terminal(t, fixture, ["local", "set", "API_KEY=private-value"]);
  await cli.waitFor(/Add it\? \[y\/N\]/);
  await cli.send("\r");
  const output = await cli.result();
  assert.match(output, /Not declared in .env.example: API_KEY/);
  assert.doesNotMatch(output, /private-value/);
  assert.equal(await readFile(schema, "utf8"), original);
});

for (const answer of ["", "yes"]) {
  test(`remote reload ${answer === "" ? "defaults to no" : "runs after confirmation"}`, options, async (t) => {
    const fixture = await project();
    const cli = terminal(t, fixture, ["prod", "set", "PORT=6000", "--no-example"]);
    await cli.waitFor(/Run reload command for prod\? \[y\/N\]/);
    assert.equal(await readFile(fixture.prod, "utf8"), "PORT=6000\n");
    await assert.rejects(access(fixture.reload), { code: "ENOENT" });
    await cli.send(`${answer}\r`);
    const output = await cli.result();
    if (answer) {
      assert.match(output, /prod: reload complete/);
      assert.equal(await readFile(fixture.reload, "utf8"), "reloaded");
    } else {
      assert.doesNotMatch(output, /running reload|reload complete/);
      await assert.rejects(access(fixture.reload), { code: "ENOENT" });
    }
  });
}

for (const answer of ["", "no"]) {
  test(`completion onboarding ${answer === "" ? "accepts Enter" : "remembers a decline"} without asking twice`, options, async (t) => {
    const fixture = await project();
    const overrides = { CI: undefined, LITENV_NO_COMPLETION_PROMPT: undefined };
    const cli = terminal(t, fixture, ["local", "vars"], overrides);
    await cli.waitFor(/Enable it\? \[Y\/n\]/);
    await cli.send(`${answer}\r`);
    const output = await cli.result();
    if (answer) {
      assert.match(output, /Skipped/);
      await assert.rejects(access(path.join(fixture.home, ".zshrc")), { code: "ENOENT" });
    } else {
      assert.match(output, /Zsh completion enabled/);
      assert.match(await readFile(path.join(fixture.home, ".zshrc"), "utf8"), /eval "\$\(litenv completion zsh\)"/);
    }
    const next = terminal(t, fixture, ["local", "vars"], overrides);
    const nextOutput = await next.result();
    assert.doesNotMatch(nextOutput, /Enable it\?|Enable Zsh completion/);
  });
}
