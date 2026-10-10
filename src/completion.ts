import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LitenvError } from "./errors.js";
import { paint, statusSymbol } from "./output.js";

export type CompletionShell = "zsh";

const COMPLETION_START = "# >>> litenv completion >>>";
const COMPLETION_END = "# <<< litenv completion <<<";
export const ZSH_COMPLETION_LINE = 'eval "$(litenv completion zsh)"';
const COMPLETION_LINE = ZSH_COMPLETION_LINE;
const COMPLETION_BLOCK = `${COMPLETION_START}\n${COMPLETION_LINE}\n${COMPLETION_END}\n`;
const DECLINED_FILE = "completion-declined";

const ZSH_COMPLETION = `#compdef litenv

if (( ! \$+functions[compdef] )); then
  autoload -Uz compinit
  compinit
fi

# Show environments and commands as separate labelled groups. A user who
# already configures either style keeps their own setting.
if ! zstyle -s ':completion:*:*:litenv:*:*' group-name _litenv_style; then
  zstyle ':completion:*:*:litenv:*' group-name ''
fi
if ! zstyle -s ':completion:*:*:litenv:*:descriptions' format _litenv_style; then
  zstyle ':completion:*:*:litenv:*:descriptions' format '%B%d%b'
fi
unset _litenv_style

_litenv() {
  local -a environments commands target_commands
  local command_name command_position environment

  environments=("\${(@f)\$(command litenv list --names 2>/dev/null)}")
  commands=(
    'get:choose an environment and print one raw value'
    'set:choose an environment and set one or more values'
    'unset:choose an environment and remove variables'
    'vars:choose an environment and print variable names'
    'show:choose an environment and show variables and values'
    'check:choose environments to validate'
    'sort:choose an environment and sort its variables'
    'diff:choose two or three environments to compare'
    'list:list local and configured remote environments'
    'completion:generate a shell completion script'
  )
  target_commands=(
    'get:print one raw value'
    'set:set one or more values'
    'unset:remove one or more variables'
    'vars:print variable names'
    'show:show variables and values'
    'check:validate the environment'
    'sort:sort variables within sections'
  )

  if (( CURRENT == 2 )); then
    _describe -t environments 'environment' environments
    _describe -t commands 'command' commands
    return
  fi

  command_position=2
  command_name="\${words[2]}"
  for environment in "\${environments[@]}"; do
    if [[ "\${words[2]}" == "\$environment" ]]; then
      command_position=3
      command_name="\${words[3]}"
      break
    fi
  done

  if (( command_position == 3 && CURRENT == 3 )); then
    _describe -t commands 'command' target_commands
    return
  fi

  if [[ "\$command_name" == 'completion' ]]; then
    if (( CURRENT == command_position + 1 )); then
      _values 'completion action' \
        'zsh[generate completion for Zsh]' \
        'install[enable completion in Zsh startup files]' \
        'uninstall[remove completion from Zsh startup files]'
    else
      _values 'shell' 'zsh[use Zsh completion]'
    fi
    return
  fi

  case "\$command_name" in
    list)
      _values 'option' '--names[print usable target selectors only]'
      ;;
    get)
      _values 'option' '--all[read the key from every environment]'
      ;;
    set)
      _values 'option' \\
        '--sort[sort variables after writing]' \\
        '--no-sort[preserve variable order]' \\
        '--example[add missing keys to the example file]' \\
        '--no-example[never update the example file]' \\
        '--reload[run the configured remote reload]' \\
        '--stdin[read one value from standard input]'
      ;;
    unset)
      _values 'option' \\
        '--sort[sort variables after writing]' \\
        '--no-sort[preserve variable order]' \\
        '--reload[run the configured remote reload]'
      ;;
    show)
      _values 'option' '--redact[hide values]'
      ;;
    check)
      _values 'option' \\
        '--all[check every environment]' \\
        '--summary[show only the complete summary]'
      ;;
    sort)
      _values 'option' '--reload[run the configured remote reload]'
      ;;
    diff)
      _values 'option' '--values[display environment values]'
      ;;
  esac
}

compdef _litenv litenv
`;

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "zsh": return ZSH_COMPLETION;
  }
}

function resolveFromHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(home, value);
}

export function zshConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME?.trim() || os.homedir();
  const zdotdir = environment.ZDOTDIR?.trim();
  const directory = zdotdir ? resolveFromHome(zdotdir, home) : home;
  return path.join(directory, ".zshrc");
}

function declinedPath(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME?.trim() || os.homedir();
  const configured = environment.XDG_CONFIG_HOME?.trim();
  const configHome = configured ? resolveFromHome(configured, home) : path.join(home, ".config");
  return path.join(configHome, "litenv", DECLINED_FILE);
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function clearDeclined(environment: NodeJS.ProcessEnv): Promise<void> {
  try {
    await unlink(declinedPath(environment));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function markDeclined(environment: NodeJS.ProcessEnv): Promise<void> {
  const file = declinedPath(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "zsh\n", "utf8");
}

function hasCompletion(content: string): boolean {
  return content.includes(COMPLETION_START) || content.includes(COMPLETION_LINE);
}

export interface CompletionChange {
  changed: boolean;
  path: string;
}

export async function installZshCompletion(environment: NodeJS.ProcessEnv = process.env): Promise<CompletionChange> {
  const file = zshConfigPath(environment);
  const content = await readOptional(file) ?? "";
  const hasStart = content.includes(COMPLETION_START);
  const hasEnd = content.includes(COMPLETION_END);
  if (hasStart !== hasEnd) {
    throw new LitenvError(`Cannot update ${file}: incomplete litenv completion block`);
  }
  if (hasCompletion(content)) {
    await clearDeclined(environment);
    return { changed: false, path: file };
  }

  await mkdir(path.dirname(file), { recursive: true });
  const separator = content === "" || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  await appendFile(file, `${separator}${COMPLETION_BLOCK}`, "utf8");
  await clearDeclined(environment);
  return { changed: true, path: file };
}

export async function uninstallZshCompletion(environment: NodeJS.ProcessEnv = process.env): Promise<CompletionChange> {
  const file = zshConfigPath(environment);
  const content = await readOptional(file) ?? "";
  const start = content.indexOf(COMPLETION_START);
  const end = content.indexOf(COMPLETION_END, Math.max(0, start));
  if ((start < 0) !== (end < 0)) {
    throw new LitenvError(`Cannot update ${file}: incomplete litenv completion block`);
  }

  let changed = false;
  if (start >= 0 && end >= 0) {
    let removeStart = start;
    if (content.slice(Math.max(0, start - 2), start) === "\n\n") removeStart -= 1;
    let removeEnd = end + COMPLETION_END.length;
    if (content[removeEnd] === "\n") removeEnd += 1;
    await writeFile(file, content.slice(0, removeStart) + content.slice(removeEnd), "utf8");
    changed = true;
  } else if (content.includes(COMPLETION_LINE)) {
    throw new LitenvError(`Cannot safely remove the unmarked litenv completion line from ${file}; remove it manually`);
  }

  await markDeclined(environment);
  return { changed, path: file };
}

export type CompletionOnboardingStatus = "available" | "configured" | "declined";

export async function completionOnboardingStatus(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CompletionOnboardingStatus> {
  if (await readOptional(declinedPath(environment)) !== undefined) return "declined";
  const content = await readOptional(zshConfigPath(environment)) ?? "";
  return hasCompletion(content) ? "configured" : "available";
}

export async function declineZshCompletion(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  await markDeclined(environment);
}

export function homeRelative(file: string, environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME?.trim();
  if (home && (file === home || file.startsWith(`${home}/`))) return `~${file.slice(home.length)}`;
  return file;
}

export function usesZsh(environment: NodeJS.ProcessEnv = process.env): boolean {
  const shell = environment.SHELL?.trim();
  return shell !== undefined && shell !== "" && path.basename(shell) === "zsh";
}

export interface CompletionOutput {
  write(text: string): void;
  color?: boolean;
}

export async function completionSetup(
  output: CompletionOutput,
  action: "install" | "uninstall",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const change = action === "install"
    ? await installZshCompletion(environment)
    : await uninstallZshCompletion(environment);
  const display = homeRelative(change.path, environment);
  if (!change.changed) {
    const state = action === "install" ? "is already enabled in" : "is not enabled in";
    output.write(`${statusSymbol("info", output.color)} Zsh completion ${state} ${display}\n`);
    return 0;
  }
  if (action === "uninstall") {
    output.write(`${statusSymbol("success", output.color)} Zsh completion removed from ${display}\n`);
    return 0;
  }
  output.write(`${statusSymbol("success", output.color)} Zsh completion enabled in ${display}\n`);
  output.write(`${paint("Open a new shell or run `exec zsh` to use it.", "dim", output.color)}\n`);
  return 0;
}

export type CompletionOffer = "installed" | "declined" | "skipped" | "failed";

export async function offerZshCompletion(
  output: CompletionOutput,
  confirm: (question: string) => Promise<boolean>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CompletionOffer> {
  if (environment.LITENV_NO_COMPLETION_PROMPT !== undefined) return "skipped";
  if (environment.CI !== undefined) return "skipped";
  if (!usesZsh(environment)) return "skipped";
  try {
    if (await completionOnboardingStatus(environment) !== "available") return "skipped";
    const file = homeRelative(zshConfigPath(environment), environment);
    output.write(`\n${paint("Enable Zsh completion for litenv?", "strong", output.color)}\n`);
    output.write(`${paint(`This adds \`${ZSH_COMPLETION_LINE}\` to ${file}.`, "dim", output.color)}\n`);
    if (!await confirm("Enable it?")) {
      await declineZshCompletion(environment);
      output.write(`${paint("Skipped. Run `litenv completion install` to enable it later.", "dim", output.color)}\n`);
      return "declined";
    }
    await completionSetup(output, "install", environment);
    return "installed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`${paint(message, "error", output.color)}\n`);
    return "failed";
  }
}
