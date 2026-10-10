import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  completionOnboardingStatus,
  completionSetup,
  homeRelative,
  offerZshCompletion,
  usesZsh,
  zshConfigPath,
} from "../dist/completion.js";

class Recorder {
  content = "";
  color = false;
  write(text) { this.content += text; }
}

async function sandbox() {
  const home = await mkdtemp(path.join(tmpdir(), "litenv-home-"));
  return {
    home,
    environment: {
      HOME: home,
      SHELL: "/bin/zsh",
      XDG_CONFIG_HOME: path.join(home, ".config"),
    },
    zshrc: path.join(home, ".zshrc"),
  };
}

test("zshConfigPath honours ZDOTDIR and homeRelative shortens the display path", async () => {
  const { home, environment } = await sandbox();
  assert.equal(zshConfigPath(environment), path.join(home, ".zshrc"));
  assert.equal(zshConfigPath({ ...environment, ZDOTDIR: "~/zdot" }), path.join(home, "zdot", ".zshrc"));
  assert.equal(zshConfigPath({ ...environment, ZDOTDIR: "/etc/zsh" }), "/etc/zsh/.zshrc");
  assert.equal(homeRelative(path.join(home, ".zshrc"), environment), "~/.zshrc");
  assert.equal(homeRelative("/etc/zsh/.zshrc", environment), "/etc/zsh/.zshrc");
});

test("usesZsh only matches a Zsh login shell", () => {
  assert.equal(usesZsh({ SHELL: "/bin/zsh" }), true);
  assert.equal(usesZsh({ SHELL: "/usr/local/bin/zsh" }), true);
  assert.equal(usesZsh({ SHELL: "/bin/bash" }), false);
  assert.equal(usesZsh({ SHELL: "" }), false);
  assert.equal(usesZsh({}), false);
});

test("completionSetup refuses to touch a startup file with a damaged block", async () => {
  const { environment, zshrc } = await sandbox();
  await writeFile(zshrc, "# >>> litenv completion >>>\n", "utf8");
  await assert.rejects(
    completionSetup(new Recorder(), "install", environment),
    /incomplete litenv completion block/,
  );

  await writeFile(zshrc, 'eval "$(litenv completion zsh)"\n', "utf8");
  await assert.rejects(
    completionSetup(new Recorder(), "uninstall", environment),
    /remove it manually/,
  );
});

test("uninstall clears an unmarked install and installing again restores the block", async () => {
  const { environment, zshrc } = await sandbox();
  const output = new Recorder();
  await completionSetup(output, "install", environment);
  assert.equal(await completionOnboardingStatus(environment), "configured");

  await completionSetup(output, "uninstall", environment);
  assert.equal(await readFile(zshrc, "utf8"), "");
  assert.equal(await completionOnboardingStatus(environment), "declined");

  await completionSetup(output, "install", environment);
  assert.equal(await completionOnboardingStatus(environment), "configured");
});

test("the onboarding offer installs on acceptance and never asks twice", async () => {
  const { environment, zshrc } = await sandbox();
  const output = new Recorder();
  const asked = [];
  const accept = async (question) => { asked.push(question); return true; };

  assert.equal(await offerZshCompletion(output, accept, environment), "installed");
  assert.equal(asked.length, 1);
  assert.match(output.content, /Enable Zsh completion for litenv\?/);
  assert.match(output.content, /This adds `eval "\$\(litenv completion zsh\)"` to ~\/\.zshrc\./);
  assert.match(output.content, /✓ Zsh completion enabled in ~\/\.zshrc/);
  assert.match(await readFile(zshrc, "utf8"), /# >>> litenv completion >>>/);

  assert.equal(await offerZshCompletion(new Recorder(), accept, environment), "skipped");
  assert.equal(asked.length, 1);
});

test("the onboarding offer records a decline and stays silent afterwards", async () => {
  const { environment, home } = await sandbox();
  const output = new Recorder();
  const decline = async () => false;

  assert.equal(await offerZshCompletion(output, decline, environment), "declined");
  assert.match(output.content, /Skipped\. Run `litenv completion install` to enable it later\./);
  assert.equal(await readFile(path.join(home, ".config", "litenv", "completion-declined"), "utf8"), "zsh\n");

  const second = new Recorder();
  assert.equal(await offerZshCompletion(second, decline, environment), "skipped");
  assert.equal(second.content, "");
});

test("the onboarding offer stays out of the way of scripts and other shells", async () => {
  const { environment } = await sandbox();
  const refuse = async () => { throw new Error("must not ask"); };
  for (const overrides of [{ CI: "1" }, { LITENV_NO_COMPLETION_PROMPT: "1" }, { SHELL: "/bin/bash" }]) {
    const output = new Recorder();
    assert.equal(await offerZshCompletion(output, refuse, { ...environment, ...overrides }), "skipped");
    assert.equal(output.content, "");
  }
});

test("the onboarding offer reports a failure without throwing", async () => {
  const { environment, zshrc } = await sandbox();
  await writeFile(zshrc, "# <<< litenv completion <<<\n", "utf8");
  const output = new Recorder();
  assert.equal(await offerZshCompletion(output, async () => true, environment), "failed");
  assert.match(output.content, /incomplete litenv completion block/);
});

test("completionSetup creates a missing startup directory", async () => {
  const { home, environment } = await sandbox();
  const zdotdir = path.join(home, "nested", "zdot");
  const scoped = { ...environment, ZDOTDIR: zdotdir };
  const output = new Recorder();
  await completionSetup(output, "install", scoped);
  assert.match(await readFile(path.join(zdotdir, ".zshrc"), "utf8"), /litenv completion zsh/);
});
