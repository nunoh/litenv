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

test("secret entry disables echo and listens before showing the prompt", async () => {
  const input = new FakeInput();
  const output = {
    write(content) {
      if (content !== "\n") {
        assert.equal(input.isRaw, true);
        assert.equal(input.listenerCount("data"), 1);
        input.emit("data", "fast-secret\r");
      }
    },
  };
  assert.equal(await promptSecret("Secret", input, output), "fast-secret");
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
});

test("diff selection enforces two to three unique choices and supports deselection", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const four = [...options, { id: "preview", label: "preview" }];
  const selection = selectDiffTargets(four, input, output);
  input.emit("data", "\r"); // No choices: keep waiting.
  assert.equal(input.isRaw, true);
  input.emit("data", " ");
  input.emit("data", "\r"); // One choice: still too few.
  assert.equal(input.isRaw, true);
  for (let index = 0; index < 3; index += 1) {
    input.emit("data", "j");
    input.emit("data", " ");
  }
  assert.match(output.content, /3 selected/);
  assert.match(output.content, /› ○ preview/); // A fourth choice was refused.
  input.emit("data", "k");
  input.emit("data", " "); // Deselect prod, then select preview.
  input.emit("data", "j");
  input.emit("data", " ");
  input.emit("data", "\r");
  assert.deepEqual(await selection, [":local", "staging", "preview"]);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.ok(output.content.endsWith("\u001b[?25h"));
});

test("selectors restore a pre-existing raw terminal on Ctrl-C and wrap upward", async () => {
  const input = new FakeInput();
  input.isRaw = true;
  const output = new FakeOutput();
  const selection = selectCommandTarget(options, "show", input, output);
  input.emit("data", "\u001b[A");
  assert.match(output.content, /› prod/);
  input.emit("data", "\u0003");
  assert.equal(await selection, undefined);
  assert.equal(input.isRaw, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.paused, true);
  assert.ok(output.content.endsWith("\u001b[?25h"));
});

test("selector refuses impossible comparisons before altering the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  await assert.rejects(selectDiffTargets(options.slice(0, 1), input, output), /At least 2 environments/);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(output.content, "");
});

test("secret entry preserves Unicode while handling backspace and empty values", async () => {
  const input = new FakeInput();
  input.isRaw = true;
  const output = new FakeOutput();
  const value = promptSecret("Secret", input, output);
  input.emit("data", "\b🔐🙂\b\t\u0001é\nignored");
  assert.equal(await value, "🔐é");
  assert.equal(input.isRaw, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(output.content, "Secret: \n");

  const emptyInput = new FakeInput();
  const empty = promptSecret("Secret", emptyInput, new FakeOutput());
  emptyInput.emit("data", "\r");
  assert.equal(await empty, "");
});

for (const key of ["\u0003", "\u0004"]) {
  test(`secret entry cancels on ${key === "\u0003" ? "Ctrl-C" : "Ctrl-D"} without leaking or retaining listeners`, async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const value = promptSecret("Secret", input, output);
    input.emit("data", `never-print-this${key}`);
    assert.equal(await value, undefined);
    assert.equal(input.isRaw, false);
    assert.equal(input.paused, true);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(output.content, "Secret: \n");
  });
}
