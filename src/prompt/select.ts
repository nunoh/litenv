export interface SelectOption {
  id: string;
  label: string;
}

export interface MenuInput {
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (data: string) => void): unknown;
  off(event: "data", listener: (data: string) => void): unknown;
}

export interface MenuOutput {
  write(content: string): unknown;
}

function safeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
}

interface SelectionSettings {
  minimum: number;
  maximum: number;
  title: string;
  action: string;
}

async function selectTargets(
  options: SelectOption[],
  input: MenuInput,
  output: MenuOutput,
  settings: SelectionSettings,
): Promise<string[] | undefined> {
  if (options.length < settings.minimum) throw new Error(`At least ${settings.minimum} environment${settings.minimum === 1 ? " is" : "s are"} required`);
  const single = settings.minimum === 1 && settings.maximum === 1;

  return new Promise((resolve) => {
    let active = 0;
    const selected = new Set<string>();
    const wasRaw = input.isRaw === true;
    const lineCount = options.length + 3;
    let rendered = false;
    let finished = false;

    const draw = () => {
      if (rendered) output.write(`\u001b[${lineCount}A\r\u001b[J`);
      else output.write("\u001b[?25l");
      const lines = [
        single ? settings.title : `${settings.title} (${selected.size} selected)`,
        single ? `↑/↓ move  •  Enter ${settings.action}  •  q cancel` : `↑/↓ move  •  Space select  •  Enter ${settings.action}  •  q cancel`,
        "",
        ...options.map((option, index) => {
          const pointer = index === active ? "›" : " ";
          const checked = single ? "" : selected.has(option.id) ? "● " : "○ ";
          return `${pointer} ${checked}${safeText(option.label)}`;
        }),
      ];
      output.write(`${lines.join("\n")}\n`);
      rendered = true;
    };

    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      if (input.setRawMode) input.setRawMode(wasRaw);
      input.pause();
      if (rendered) output.write(`\u001b[${lineCount}A\r\u001b[J`);
      output.write("\u001b[?25h");
    };

    const complete = (selection: string[] | undefined) => {
      cleanup();
      resolve(selection);
    };

    const onData = (key: string) => {
      if (key === "\u0003" || key === "q") {
        complete(undefined);
        return;
      }
      if (key === "\u001b[A" || key === "k") active = (active - 1 + options.length) % options.length;
      else if (key === "\u001b[B" || key === "j") active = (active + 1) % options.length;
      else if (key === " ") {
        const option = options[active];
        if (option && !single) {
          if (selected.has(option.id)) selected.delete(option.id);
          else if (selected.size < settings.maximum) selected.add(option.id);
          else output.write("\u0007");
        }
      } else if (key === "\r" || key === "\n") {
        if (single) {
          const option = options[active];
          complete(option ? [option.id] : undefined);
          return;
        }
        if (selected.size >= settings.minimum && selected.size <= settings.maximum) {
          complete(options.filter((option) => selected.has(option.id)).map((option) => option.id));
          return;
        }
        output.write("\u0007");
      }
      draw();
    };

    if (input.setRawMode) input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    draw();
  });
}

export function selectDiffTargets(
  options: SelectOption[],
  input: MenuInput = process.stdin,
  output: MenuOutput = process.stderr,
): Promise<string[] | undefined> {
  return selectTargets(options, input, output, {
    minimum: 2,
    maximum: 3,
    title: "Select 2–3 environments",
    action: "compare",
  });
}

export function selectCheckTargets(
  options: SelectOption[],
  input: MenuInput = process.stdin,
  output: MenuOutput = process.stderr,
): Promise<string[] | undefined> {
  return selectTargets(options, input, output, {
    minimum: 1,
    maximum: options.length,
    title: "Select environments to check",
    action: "check",
  });
}

export async function selectCommandTarget(
  options: SelectOption[],
  action: string,
  input: MenuInput = process.stdin,
  output: MenuOutput = process.stderr,
): Promise<string | undefined> {
  const selection = await selectTargets(options, input, output, {
    minimum: 1,
    maximum: 1,
    title: `Select an environment for ${safeText(action)}`,
    action,
  });
  return selection?.[0];
}
