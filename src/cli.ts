#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import {
  checkCommand,
  checkAllCommand,
  diffCommand,
  getAllCommand,
  getCommand,
  listCommand,
  varsCommand,
  setCommand,
  showCommand,
  sortCommand,
  unsetCommand,
  type CommandContext,
  type CommandIO,
} from "./commands/index.js";
import {
  completionScript,
  completionSetup,
  offerZshCompletion,
  type CompletionOutput,
} from "./completion.js";
import { loadConfig } from "./config/load.js";
import { LitenvError, UsageError } from "./errors.js";
import { isValidKey } from "./env/document.js";
import { paint } from "./output.js";
import { promptSecret } from "./prompt/secret.js";
import { selectCheckTargets, selectCommandTarget, selectDiffTargets } from "./prompt/select.js";
import { LocalTransport } from "./transport/local.js";
import { SshTransport } from "./transport/ssh.js";

const packageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION = packageMetadata.version;
const COMMANDS = new Set(["get", "set", "unset", "vars", "show", "check", "sort", "diff", "list", "completion"]);

const HELP = `litenv — lightweight .env management, locally and over SSH

Usage:
  litenv [environment] <command> [arguments] [options]
  litenv list [--names]
  litenv completion zsh
  litenv completion install|uninstall [zsh]
  litenv diff
  litenv <target>:<target>[:<target>] diff [--values]

Environment selection:
  [environment] is optional. Omit it to choose from an interactive menu.
  Use "local" for the local file or a name from litenv.toml for remote use.
  Scripts and other non-interactive use must provide an explicit environment.

  litenv get PORT            Choose an environment interactively
  litenv local get PORT      Local environment explicitly
  litenv prod get PORT       Remote environment "prod"

Commands:
  list [--names]             List local and configured remote environments
  completion zsh             Generate a Zsh completion script
  completion install [zsh]   Enable Zsh completion in the shell startup file
  completion uninstall [zsh] Remove Zsh completion from the shell startup file
  get KEY                    Print one raw value
  get KEY --all              Print the value from every environment
  set KEY[=VALUE] [...]      Set values inline or enter them without echo
  unset KEY [...]            Remove one or more variables
  vars                       Print variable names only
  show [--redact]            Show variables and values
  check                      Choose one or more environments to validate
  local check                Validate the local environment explicitly
  check --all                Check local and every configured environment
  check --summary            Show only the complete check summary
  sort                       Sort variables within sections

Diff:
  litenv diff                        Choose 2–3 environments interactively
  litenv prod:staging diff           Compare two remote environments
  litenv :prod diff                  Compare local with prod
  litenv staging: diff               Compare staging with local
  litenv :staging:prod diff          Compare local, staging, and prod
  Add --values to display values. Empty targets mean local.
  Colon selectors are required in scripts and other non-interactive use.

Mutation options:
  --sort          Sort even when project.sort is false
  --no-sort       Preserve the current variable order
  --example       Add missing set keys to the configured example file
  --no-example    Never update the configured example file
  --reload        Run the configured remote reload without prompting
  --stdin         Read one set value from stdin (one trailing newline is removed)

Remote reloads:
  Add reload = "command" to an [env.NAME] table. Use --reload to run it.
  Interactive mutations ask first and default to no.

Exit codes: 0 success, 1 operation/validation failure, 2 invalid usage.`;

function defaultIO(): CommandIO {
  const color = process.env.NO_COLOR === undefined && (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true);
  return {
    out(line) { process.stdout.write(`${line}\n`); },
    error(line) { process.stderr.write(`${line}\n`); },
    color,
  };
}

function showInteractiveRun(
  io: CommandIO,
  command: string,
  arguments_: string[],
  targets: string[],
): void {
  const argumentsText = arguments_.length > 0 ? ` ${arguments_.join(" ")}` : "";
  const commands = targets.map((target) => `litenv ${target} ${command}${argumentsText}`);
  io.out(paint(commands.length === 1 ? "Command" : "Commands", "dim", io.color));
  for (const commandLine of commands) io.out(`  ${paint(`\`${commandLine}\``, "strong", io.color)}`);
  io.out("");
}

interface ParsedArguments {
  positionals: string[];
  values: boolean;
  redact: boolean;
  sort?: boolean;
  example: "prompt" | "always" | "never";
  all: boolean;
  summary: boolean;
  reload: boolean;
  stdin: boolean;
  names: boolean;
}

function parseFlags(args: string[]): ParsedArguments {
  let values = false;
  let redact = false;
  let sort: boolean | undefined;
  let example: ParsedArguments["example"] = "prompt";
  let all = false;
  let summary = false;
  let reload = false;
  let stdin = false;
  let names = false;
  const positionals: string[] = [];
  for (const argument of args) {
    if (argument === "--values") values = true;
    else if (argument === "--redact") redact = true;
    else if (argument === "--sort") sort = true;
    else if (argument === "--no-sort") sort = false;
    else if (argument === "--example") example = "always";
    else if (argument === "--no-example") example = "never";
    else if (argument === "--all") all = true;
    else if (argument === "--summary") summary = true;
    else if (argument === "--reload") reload = true;
    else if (argument === "--stdin") stdin = true;
    else if (argument === "--names") names = true;
    else if (argument.startsWith("--")) throw new UsageError(`Unknown option: ${argument}`);
    else positionals.push(argument);
  }
  return {
    positionals,
    values,
    redact,
    ...(sort === undefined ? {} : { sort }),
    example,
    all,
    summary,
    reload,
    stdin,
    names,
  };
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function readStdinValue(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, "");
}

async function resolveSetArguments(arguments_: string[], stdin: boolean): Promise<string[]> {
  if (stdin) {
    if (arguments_.length !== 1 || arguments_[0]?.includes("=")) {
      throw new UsageError("--stdin requires exactly one variable name: litenv [environment] set KEY --stdin");
    }
    const key = arguments_[0] ?? "";
    if (!isValidKey(key)) throw new UsageError(`Invalid environment variable name: ${key}`);
    if (process.stdin.isTTY) {
      throw new UsageError("--stdin requires piped input. Omit --stdin to enter the value securely in a terminal.");
    }
    return [`${key}=${await readStdinValue()}`];
  }

  const resolved: string[] = [];
  for (const argument of arguments_) {
    if (argument.includes("=")) {
      resolved.push(argument);
      continue;
    }
    if (!isValidKey(argument)) throw new UsageError(`Invalid assignment: ${argument}`);
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new UsageError(`A value for ${argument} requires a terminal. Use ${argument}=VALUE or pipe it with --stdin.`);
    }
    const value = await promptSecret(`Value for ${argument} (input hidden)`);
    if (value === undefined) throw new LitenvError("Value entry cancelled");
    resolved.push(`${argument}=${value}`);
  }
  return resolved;
}

async function confirmDefaultYes(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${question} [Y/n] `);
    return !/^(n|no)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function stderrOutput(): CompletionOutput {
  const color = process.env.NO_COLOR === undefined && (process.env.FORCE_COLOR !== undefined || process.stderr.isTTY === true);
  return { write(text) { process.stderr.write(text); }, color };
}

export async function run(argv: string[], cwd = process.cwd(), io = defaultIO()): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    io.out(VERSION);
    return 0;
  }

  const { positionals, values, redact, sort, example, all, summary, reload, stdin, names } = parseFlags(argv);
  const config = await loadConfig(cwd);
  const projectRoot = config?.root ?? path.resolve(cwd);
  const localFileDisplay = config?.project.file ?? ".env";
  const schemaDisplay = config?.project.example ?? ".env.example";
  const localTransport = new LocalTransport(path.resolve(projectRoot, localFileDisplay));
  const schemaFile = path.resolve(projectRoot, schemaDisplay);
  const localName = config?.project.localName ?? "dev";
  const defaultSort = config?.project.sort ?? true;
  const undeclared = config?.project.undeclared ?? "warn";

  let targetName: string | undefined;
  let explicitLocal = false;
  let diffSelector: string[] | undefined;
  let interactiveTargets: string[] | undefined;
  if (positionals[0]?.includes(":")) {
    diffSelector = positionals[0].split(":");
    if (diffSelector.length < 2 || diffSelector.length > 3) {
      throw new UsageError("A diff selector must contain two or three targets");
    }
    positionals.shift();
  } else if (positionals[0] === "local") {
    explicitLocal = true;
    positionals.shift();
  } else if (
    positionals[0]
    && config?.environments[positionals[0]]
    && !(positionals.length === 1 && COMMANDS.has(positionals[0]))
  ) {
    targetName = positionals.shift();
  }

  const command = positionals.shift();
  if (!command) throw new UsageError(HELP);
  if (!COMMANDS.has(command)) throw new UsageError(`Unknown command or environment: ${command}`);
  if (diffSelector && command !== "diff") throw new UsageError("A multi-environment target can only be used with diff");

  if (command === "completion") {
    const usage = "Usage: litenv completion zsh | litenv completion install|uninstall [zsh]";
    if (targetName || explicitLocal || diffSelector) throw new UsageError(usage);
    if (values || redact || sort !== undefined || example !== "prompt" || all || summary || reload || stdin || names) {
      throw new UsageError(usage);
    }
    const action = positionals[0];
    if (action === "install" || action === "uninstall") {
      if (positionals.length > 2 || (positionals.length === 2 && positionals[1] !== "zsh")) {
        throw new UsageError(usage);
      }
      return completionSetup({ write(text) { io.out(text.replace(/\n$/, "")); }, color: io.color === true }, action);
    }
    if (positionals.length !== 1 || action !== "zsh") throw new UsageError(usage);
    io.out(completionScript("zsh").trimEnd());
    return 0;
  }

  if (command === "list") {
    if (targetName || explicitLocal || diffSelector || positionals.length !== 0) {
      throw new UsageError("Usage: litenv list [--names]");
    }
    if (values) throw new UsageError("--values is not supported by list");
    if (redact) throw new UsageError("--redact is not supported by list");
    if (sort !== undefined) throw new UsageError(`${sort ? "--sort" : "--no-sort"} is not supported by list`);
    if (example !== "prompt") throw new UsageError(`${example === "always" ? "--example" : "--no-example"} is not supported by list`);
    if (all) throw new UsageError("--all is not supported by list");
    if (summary) throw new UsageError("--summary is not supported by list");
    if (reload) throw new UsageError("--reload is not supported by list");
    if (stdin) throw new UsageError("--stdin is not supported by list");
    return listCommand(io, [
      { name: localName, selector: "local", type: "local", file: localFileDisplay },
      ...Object.entries(config?.environments ?? {}).map(([name, environment]) => ({
        name,
        selector: name,
        type: "remote" as const,
        host: environment.host,
        file: environment.file,
      })),
    ], names);
  }

  if (names) throw new UsageError(`--names is not supported by ${command}`);

  if (command === "diff") {
    if (all) throw new UsageError("--all is not supported by diff");
    if (summary) throw new UsageError("--summary is not supported by diff");
    if (reload) throw new UsageError("--reload is not supported by diff");
    if (stdin) throw new UsageError("--stdin is not supported by diff");
    if (redact) throw new UsageError("--redact is not supported by diff");
    if (sort !== undefined) throw new UsageError(`${sort ? "--sort" : "--no-sort"} is not supported by diff`);
    if (example !== "prompt") throw new UsageError(`${example === "always" ? "--example" : "--no-example"} is not supported by diff`);
    let selectors = diffSelector;
    if (!selectors && !targetName && positionals.length === 0) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new UsageError("Interactive diff requires a terminal. Use litenv TARGET:TARGET[:TARGET] diff instead.");
      }
      const menuOptions = [
        { id: ":local", label: `${localName} (local)` },
        ...Object.keys(config?.environments ?? {}).map((name) => ({
          id: name,
          label: name,
        })),
      ];
      if (menuOptions.length < 2) throw new UsageError("No configured environments are available to compare with local");
      const selected = await selectDiffTargets(menuOptions);
      if (!selected) {
        io.error("Comparison cancelled");
        return 1;
      }
      selectors = selected.map((selector) => selector === ":local" ? "" : selector);
      interactiveTargets = [selectors.join(":")];
    }
    if (!selectors || targetName || positionals.length !== 0) {
      throw new UsageError("Usage: litenv TARGET:TARGET[:TARGET] diff [--values]");
    }
    const targets = selectors.map((selector) => {
      if (selector === "" || selector === "local") {
        return { id: "local", name: localName, transport: localTransport };
      }
      const remote = config?.environments[selector];
      if (!remote) throw new UsageError(`Unknown environment: ${selector}`);
      return { id: `env:${selector}`, name: selector, transport: new SshTransport(remote.host, remote.file) };
    });
    if (new Set(targets.map(({ id }) => id)).size !== targets.length) {
      throw new UsageError("Each diff target must be unique");
    }
    const nameCounts = new Map<string, number>();
    for (const target of targets) nameCounts.set(target.name, (nameCounts.get(target.name) ?? 0) + 1);
    const displayTargets = targets.map(({ id, name, transport }) => ({
      name: id === "local" && (nameCounts.get(name) ?? 0) > 1 ? `${name} (local)` : name,
      transport,
    }));
    if (interactiveTargets) {
      showInteractiveRun(io, "diff", values ? ["--values"] : [], interactiveTargets);
    }
    return diffCommand(io, displayTargets, positionals, values);
  }

  if (values && command !== "show") throw new UsageError(`--values is not supported by ${command}`);
  if (redact && command !== "show") throw new UsageError(`--redact is not supported by ${command}`);
  if (sort !== undefined && command !== "set" && command !== "unset") throw new UsageError(`${sort ? "--sort" : "--no-sort"} is not supported by ${command}`);
  if (example !== "prompt" && command !== "set") throw new UsageError(`${example === "always" ? "--example" : "--no-example"} is not supported by ${command}`);
  if (all && command !== "check" && command !== "get") throw new UsageError(`--all is not supported by ${command}`);
  if (summary && command !== "check") throw new UsageError(`--summary is not supported by ${command}`);
  if (reload && command !== "set" && command !== "unset" && command !== "sort") {
    throw new UsageError(`--reload is not supported by ${command}`);
  }
  if (stdin && command !== "set") throw new UsageError(`--stdin is not supported by ${command}`);
  if (all && (targetName || explicitLocal)) throw new UsageError("--all cannot be combined with a specific environment");

  if (all) {
    const targets = [{ name: localName, transport: localTransport, valuesFile: localFileDisplay }];
    for (const [name, remote] of Object.entries(config?.environments ?? {})) {
      targets.push({ name, transport: new SshTransport(remote.host, remote.file), valuesFile: `${remote.host}:${remote.file}` });
    }
    if (command === "get") return getAllCommand(io, targets, positionals);
    if (positionals.length !== 0) throw new UsageError("Usage: litenv check --all");
    return checkAllCommand(schemaFile, targets, io, undeclared, schemaDisplay, summary);
  }

  if (!targetName && !explicitLocal) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      const allAlternative = command === "check" || command === "get" ? `, or litenv ${command}${command === "get" ? " KEY" : ""} --all` : "";
      throw new UsageError(`Interactive ${command} requires a terminal. Use litenv local ${command}, litenv ENVIRONMENT ${command}${allAlternative} instead.`);
    }
    const menuOptions = [
      { id: ":local", label: `${localName} (local)` },
      ...Object.keys(config?.environments ?? {}).map((name) => ({ id: name, label: name })),
    ];
    if (command === "check") {
      const selected = await selectCheckTargets(menuOptions);
      if (!selected || selected.length === 0) {
        io.error("Check cancelled");
        return 1;
      }
      if (selected.length > 1) {
        const targets = selected.map((selection) => {
          if (selection === ":local") return { name: localName, transport: localTransport, valuesFile: localFileDisplay };
          const remote = config?.environments[selection];
          if (!remote) throw new UsageError(`Unknown environment: ${selection}`);
          return { name: selection, transport: new SshTransport(remote.host, remote.file), valuesFile: `${remote.host}:${remote.file}` };
        });
        showInteractiveRun(io, "check", summary ? ["--summary"] : [], selected.map((selection) => selection === ":local" ? "local" : selection));
        return checkAllCommand(schemaFile, targets, io, undeclared, schemaDisplay, summary);
      }
      if (selected[0] === ":local") {
        explicitLocal = true;
        interactiveTargets = ["local"];
      } else {
        targetName = selected[0];
        interactiveTargets = [selected[0] ?? ""];
      }
    } else {
      const selected = await selectCommandTarget(menuOptions, command);
      if (!selected) {
        io.error(`${command} cancelled`);
        return 1;
      }
      if (selected === ":local") explicitLocal = true;
      else targetName = selected;
      interactiveTargets = [selected === ":local" ? "local" : selected];
    }
  }

  const promptForExample = process.stdin.isTTY && process.stderr.isTTY ? confirm : undefined;
  let context: CommandContext = {
    transport: localTransport,
    schemaFile,
    io,
    undeclared,
    checkInfo: {
      environment: `${localName} (local)`,
      valuesFile: localFileDisplay,
      schemaFile: schemaDisplay,
    },
    ...(promptForExample ? { confirm: promptForExample } : {}),
  };
  if (targetName) {
    const remote = config?.environments[targetName];
    if (!remote) throw new UsageError(`Unknown environment: ${targetName}`);
    const remoteTransport = new SshTransport(remote.host, remote.file);
    const reloadCommand = remote.reload;
    context = {
      transport: remoteTransport,
      targetName,
      schemaFile,
      io,
      undeclared,
      checkInfo: {
        environment: targetName,
        valuesFile: `${remote.host}:${remote.file}`,
        schemaFile: schemaDisplay,
      },
      ...(reloadCommand ? { reload: () => remoteTransport.runCommand(reloadCommand) } : {}),
      ...(promptForExample ? { confirm: promptForExample } : {}),
    };
  }

  if (reload && !context.reload) {
    throw new UsageError("--reload requires a reload command in the selected environment");
  }
  const reloadMode: "prompt" | "always" | "never" = reload
    ? "always"
    : context.reload && promptForExample ? "prompt" : "never";

  if (interactiveTargets) {
    const runArguments = command === "set"
      ? positionals.map((assignment) => {
        const equals = assignment.indexOf("=");
        return equals < 0 ? assignment : `${assignment.slice(0, equals)}=…`;
      })
      : [...positionals];
    if (command === "show" && redact) runArguments.push("--redact");
    if (command === "check" && summary) runArguments.push("--summary");
    if (reload) runArguments.push("--reload");
    if (stdin) runArguments.push("--stdin");
    if ((command === "set" || command === "unset") && sort !== undefined) runArguments.push(sort ? "--sort" : "--no-sort");
    if (command === "set" && example !== "prompt") runArguments.push(example === "always" ? "--example" : "--no-example");
    showInteractiveRun(io, command, runArguments, interactiveTargets);
  }

  const commandArguments = command === "set" ? await resolveSetArguments(positionals, stdin) : positionals;

  switch (command) {
    case "get": return getCommand(context, commandArguments);
    case "set": return setCommand(context, commandArguments, { sort: sort ?? defaultSort, example, reload: reloadMode });
    case "unset": return unsetCommand(context, commandArguments, { sort: sort ?? defaultSort, reload: reloadMode });
    case "vars": return varsCommand(context, commandArguments);
    case "show": return showCommand(context, commandArguments, redact && !values);
    case "check": return checkCommand(context, commandArguments, summary);
    case "sort": return sortCommand(context, commandArguments, { reload: reloadMode });
    default: throw new UsageError(`Unknown command: ${command}`);
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const code = await run(argv);
    process.exitCode = code;
    if (code === 0 && !argv.includes("completion") && process.stdin.isTTY && process.stderr.isTTY) {
      await offerZshCompletion(stderrOutput(), confirmDefaultYes);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const color = process.env.NO_COLOR === undefined && (process.env.FORCE_COLOR !== undefined || process.stderr.isTTY === true);
    process.stderr.write(`${paint(message, "error", color)}\n`);
    process.exitCode = error instanceof LitenvError ? error.exitCode : 1;
  }
}

await main();
