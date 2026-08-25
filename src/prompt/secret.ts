export interface SecretInput {
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (data: string) => void): unknown;
  off(event: "data", listener: (data: string) => void): unknown;
}

export interface SecretOutput {
  write(content: string): unknown;
}

export function promptSecret(
  question: string,
  input: SecretInput = process.stdin,
  output: SecretOutput = process.stderr,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let value = "";
    let finished = false;
    const wasRaw = input.isRaw === true;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      if (input.setRawMode) input.setRawMode(wasRaw);
      input.pause();
    };

    const complete = (result: string | undefined) => {
      cleanup();
      output.write("\n");
      resolve(result);
    };

    const onData = (data: string) => {
      for (const character of data) {
        if (character === "\u0003" || character === "\u0004") {
          complete(undefined);
          return;
        }
        if (character === "\r" || character === "\n") {
          complete(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (character >= " " && character !== "\u007f") value += character;
      }
    };

    output.write(`${question}: `);
    if (input.setRawMode) input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
  });
}
