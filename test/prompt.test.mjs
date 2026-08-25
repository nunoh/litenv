import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { promptSecret } from "../dist/prompt/secret.js";
import { selectCheckTargets, selectCommandTarget, selectDiffTargets } from "../dist/prompt/select.js";

class FakeInput extends EventEmitter {
  isRaw = false;
  paused = false;
  setRawMode(enabled) { this.isRaw = enabled; }
  setEncoding() {}
  resume() { this.paused = false; }
  pause() { this.paused = true; }
}

class FakeOutput {
  content = "";
  write(value) { this.content += value; }
}

const options = [
  { id: ":local", label: "dev (local)" },
  { id: "staging", label: "staging" },
  { id: "prod", label: "prod" },
];

test("interactive selector uses arrows, Space, and Enter to choose targets", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectDiffTargets(options, input, output);
  input.emit("data", " ");
  input.emit("data", "\u001b[B");
  input.emit("data", " ");
  input.emit("data", "\r");

  assert.deepEqual(await selection, [":local", "staging"]);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.match(output.content, /Select 2–3 environments/);
  assert.match(output.content, /dev \(local\)/);
  assert.equal(output.content.includes(".env"), false);
  assert.match(output.content, /Space select/);
});

test("interactive selector supports three choices and cancellation", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectDiffTargets(options, input, output);
  input.emit("data", " ");
  input.emit("data", "j");
  input.emit("data", " ");
  input.emit("data", "j");
  input.emit("data", " ");
  input.emit("data", "\n");
  assert.deepEqual(await selection, [":local", "staging", "prod"]);

  const cancelInput = new FakeInput();
  const cancelled = selectDiffTargets(options, cancelInput, new FakeOutput());
  cancelInput.emit("data", "q");
  assert.equal(await cancelled, undefined);
});

test("interactive check selector allows one or more environments", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectCheckTargets(options, input, output);
  input.emit("data", " ");
  input.emit("data", "\u001b[B");
  input.emit("data", " ");
  input.emit("data", "\r");
  assert.deepEqual(await selection, [":local", "staging"]);
  assert.match(output.content, /Select environments to check/);
  assert.match(output.content, /Enter check/);
  assert.match(output.content, /Space select/);
});

test("other commands use a single-environment selector", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectCommandTarget(options, "show", input, output);
  input.emit("data", "j");
  input.emit("data", "\r");
  assert.equal(await selection, "staging");
  assert.match(output.content, /Select an environment for show/);
  assert.match(output.content, /Enter show/);
  assert.equal(output.content.includes("Space select"), false);
});

test("secret prompt captures a value without echoing it", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const value = promptSecret("Value for TOKEN (input hidden)", input, output);
  input.emit("data", "top-secrex");
  input.emit("data", "\u007f");
  input.emit("data", "t\r");

  assert.equal(await value, "top-secret");
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(output.content, "Value for TOKEN (input hidden): \n");
  assert.equal(output.content.includes("top-secret"), false);
});
