import { readFile } from "node:fs/promises";
import path from "node:path";
import { EnvDocument, isValidKey } from "../env/document.js";
import { validate } from "../env/validate.js";
import { LitenvError, UsageError } from "../errors.js";
import { paint, statusSymbol } from "../output.js";
import { LocalTransport } from "../transport/local.js";
import type { EnvTransport } from "../transport/types.js";

export interface CommandIO {
  out(line: string): void;
  error(line: string): void;
  color?: boolean;
}

export interface CommandContext {
  transport: EnvTransport;
  targetName?: string;
  schemaFile: string;
  io: CommandIO;
  confirm?: (question: string) => Promise<boolean>;
  reload?: () => Promise<void>;
  undeclared?: "warn" | "error";
  checkInfo?: {
    environment: string;
    valuesFile: string;
    schemaFile: string;
  };
}

export interface MutationOptions {
  sort?: boolean;
  example?: "prompt" | "always" | "never";
  reload?: "prompt" | "always" | "never";
}

export interface CheckTarget {
  name: string;
  transport: EnvTransport;
  valuesFile?: string;
}

export interface GetTarget {
  name: string;
  transport: EnvTransport;
}

function requireKeys(keys: string[], usage: string): void {
  if (keys.length === 0) throw new UsageError(`Usage: ${usage}`);
  for (const key of keys) {
    if (!isValidKey(key)) throw new UsageError(`Invalid environment variable name: ${key}`);
  }
}

function statusPrefix(context: CommandContext): string {
  return context.targetName ? `${context.targetName}: ` : "";
}

function mark(context: CommandContext, kind: "success" | "info" | "warning" | "error"): string {
  return statusSymbol(kind, context.io.color);
}

function keyName(context: CommandContext, key: string): string {
  return paint(key, "strong", context.io.color);
}

function requireConfiguredReload(context: CommandContext, mode: MutationOptions["reload"]): void {
  if (mode === "always" && !context.reload) {
    throw new UsageError("--reload requires a reload command in the selected environment");
  }
}

async function reloadAfterWrite(
  context: CommandContext,
  mode: MutationOptions["reload"] = "never",
): Promise<void> {
  if (mode === "never") return;
  if (!context.reload) {
    if (mode === "always") throw new UsageError("--reload requires a reload command in the selected environment");
    return;
  }
  if (mode === "prompt") {
    if (!context.confirm) return;
    const target = context.targetName ?? "selected environment";
    if (!await context.confirm(`Run reload command for ${target}?`)) return;
  }
  context.io.out(`${mark(context, "info")} ${statusPrefix(context)}running reload`);
  try {
    await context.reload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LitenvError(`${statusPrefix(context)}environment file updated, but reload failed: ${message}`);
  }
  context.io.out(`${mark(context, "success")} ${statusPrefix(context)}reload complete`);
}

async function updateExampleIfRequested(
  context: CommandContext,
  keys: string[],
  mode: MutationOptions["example"],
): Promise<void> {
  const exampleTransport = new LocalTransport(context.schemaFile);
  const exampleName = path.basename(context.schemaFile);
  const originalExample = await exampleTransport.read();
  const example = EnvDocument.parse(originalExample);
  const missing = [...new Set(keys)].filter((key) => !example.has(key));
  if (missing.length === 0) return;

  let shouldUpdate = mode === "always";
  if (mode === "prompt" && context.confirm) {
    shouldUpdate = await context.confirm(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing from ${exampleName}. Add ${missing.length === 1 ? "it" : "them"}?`);
  }
  if (!shouldUpdate) {
    context.io.out(`${mark(context, "warning")} Not declared in ${exampleName}: ${missing.map((key) => keyName(context, key)).join(", ")}`);
    if (mode === "prompt" && !context.confirm) {
      context.io.out(paint("  Use --example to add empty placeholders.", "dim", context.io.color));
    }
    return;
  }

  for (const key of missing) example.set(key, "");
  example.sortSections();
  await exampleTransport.write(example.serialize(), { expectedContent: originalExample });
  context.io.out(`${mark(context, "success")} ${exampleName} updated: ${missing.map((key) => keyName(context, key)).join(", ")}`);
}

export async function getCommand(context: CommandContext, args: string[]): Promise<number> {
  if (args.length !== 1) throw new UsageError("Usage: litenv [environment] get KEY");
  const key = args[0] ?? "";
  requireKeys([key], "litenv [environment] get KEY");
  const value = EnvDocument.parse(await context.transport.read()).get(key);
  if (value === undefined) throw new LitenvError(`${key} not found`);
  context.io.out(value);
  return 0;
}

export async function getAllCommand(io: CommandIO, targets: GetTarget[], args: string[]): Promise<number> {
  if (args.length !== 1) throw new UsageError("Usage: litenv get KEY --all");
  const key = args[0] ?? "";
  requireKeys([key], "litenv get KEY --all");

  const rows: string[][] = [];
  let failed = false;
  for (const target of targets) {
    try {
      const value = EnvDocument.parse(await target.transport.read()).get(key);
      if (value === undefined) {
        failed = true;
        rows.push([target.name, "—", "not found"]);
      } else {
        rows.push([target.name, safeTableValue(value), "found"]);
      }
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      rows.push([target.name, "—", `failed: ${safeTableValue(message)}`]);
    }
  }

  const headers = ["ENVIRONMENT", "VALUE", "RESULT"];
  const widths = headers.map((header, column) => Math.max(
    textWidth(header),
    ...rows.map((row) => textWidth(row[column] ?? "")),
  ));
  const renderRow = (row: string[], result?: string): string => row.map((cell, column) => {
    const padded = padCell(cell, widths[column] ?? 0);
    if (column === 0 && result !== undefined) return paint(padded, "strong", io.color);
    if (column !== 2 || result === undefined) return padded;
    return paint(padded, result === "found" ? "success" : "error", io.color);
  }).join("  ").trimEnd();

  io.out(paint(renderRow(headers), "heading", io.color));
  io.out(paint(widths.map((width) => "─".repeat(width)).join("  "), "dim", io.color));
  for (const row of rows) io.out(renderRow(row, row[2]));
  return failed ? 1 : 0;
}

export async function setCommand(
  context: CommandContext,
  assignments: string[],
  options: MutationOptions = {},
): Promise<number> {
  if (assignments.length === 0) throw new UsageError("Usage: litenv [environment] set KEY=VALUE [KEY=VALUE ...]");
  const parsed = assignments.map((assignment) => {
    const equals = assignment.indexOf("=");
    if (equals < 1) throw new UsageError(`Invalid assignment: ${assignment}`);
    const key = assignment.slice(0, equals);
    if (!isValidKey(key)) throw new UsageError(`Invalid environment variable name: ${key}`);
    return [key, assignment.slice(equals + 1)] as const;
  });
  requireConfiguredReload(context, options.reload);
  const original = await context.transport.read();
  const document = EnvDocument.parse(original);
  for (const [key, value] of parsed) document.set(key, value);
  if (options.sort !== false) document.sortSections();
  await context.transport.write(document.serialize(), { expectedContent: original });
  for (const [key] of parsed) context.io.out(`${mark(context, "success")} ${statusPrefix(context)}${keyName(context, key)} updated`);
  await reloadAfterWrite(context, options.reload);
  await updateExampleIfRequested(context, parsed.map(([key]) => key), options.example ?? "prompt");
  return 0;
}

export async function unsetCommand(
  context: CommandContext,
  keys: string[],
  options: Pick<MutationOptions, "sort" | "reload"> = {},
): Promise<number> {
  requireKeys(keys, "litenv [environment] unset KEY [KEY ...]");
  requireConfiguredReload(context, options.reload);
  const original = await context.transport.read();
  const document = EnvDocument.parse(original);
  let changed = false;
  const results = keys.map((key) => {
    const removed = document.unset(key);
    changed ||= removed;
    return { key, removed };
  });
  if (changed) {
    if (options.sort !== false) document.sortSections();
    await context.transport.write(document.serialize(), { expectedContent: original });
  }
  for (const { key, removed } of results) {
    context.io.out(`${mark(context, removed ? "success" : "info")} ${statusPrefix(context)}${keyName(context, key)} ${removed ? "removed" : "not found"}`);
  }
  if (changed) await reloadAfterWrite(context, options.reload);
  return 0;
}

export async function varsCommand(context: CommandContext, args: string[]): Promise<number> {
  if (args.length !== 0) throw new UsageError("Usage: litenv [environment] vars");
  for (const [key] of EnvDocument.parse(await context.transport.read()).entries()) context.io.out(key);
  return 0;
}

export async function showCommand(context: CommandContext, args: string[], redact: boolean): Promise<number> {
  if (args.length !== 0) throw new UsageError("Usage: litenv [environment] show [--redact]");
  for (const [key, value] of EnvDocument.parse(await context.transport.read()).entries()) {
    context.io.out(`${key}=${redact ? "*".repeat(value.length) : value}`);
  }
  return 0;
}

export async function checkCommand(context: CommandContext, args: string[], summaryOnly = false): Promise<number> {
  if (args.length !== 0) throw new UsageError("Usage: litenv [environment] check");
  if (context.checkInfo && !summaryOnly) {
    context.io.out(paint("Check", "heading", context.io.color));
    context.io.out(`  ${paint("Environment", "dim", context.io.color)}  ${paint(context.checkInfo.environment, "strong", context.io.color)}`);
    context.io.out(`  ${paint("Values file", "dim", context.io.color)}  ${paint(context.checkInfo.valuesFile, "strong", context.io.color)}`);
    context.io.out(`  ${paint("Schema file", "dim", context.io.color)}  ${paint(context.checkInfo.schemaFile, "strong", context.io.color)}`);
    context.io.out("");
  }
  let exampleContent: string;
  try {
    exampleContent = await readFile(context.schemaFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LitenvError(`Schema file not found: ${context.schemaFile}`);
    }
    throw error;
  }
  const actual = EnvDocument.parse(await context.transport.read());
  const result = validate(actual, EnvDocument.parse(exampleContent));
  const exampleName = path.basename(context.schemaFile);
  const undeclaredIsError = context.undeclared === "error";
  const hasDetails = result.missingRequired.length > 0 || result.entries.some((entry) => entry.optional && !entry.present) || result.extras.length > 0;
  const statusEntries = result.entries.filter((entry) => entry.present || entry.optional);

  if (!summaryOnly && hasDetails && statusEntries.length > 0) {
    for (const entry of statusEntries) {
      if (entry.present) context.io.out(`${mark(context, "success")} ${keyName(context, entry.key)}`);
      else if (entry.optional) context.io.out(`${mark(context, "info")} ${keyName(context, entry.key)} ${paint("optional, missing", "dim", context.io.color)}`);
    }
    context.io.out("");
  }

  if (result.missingRequired.length > 0 || result.extras.length > 0) {
    context.io.out(paint("Problems", "heading", context.io.color));
    if (result.missingRequired.length > 0) {
      context.io.out(`  ${paint(`✗ Missing required (${result.missingRequired.length})`, "error", context.io.color)}`);
      for (const key of result.missingRequired) context.io.out(`    ${mark(context, "error")} ${keyName(context, key)}`);
    }
    if (result.missingRequired.length > 0 && result.extras.length > 0) context.io.out("");
    if (result.extras.length > 0) {
      const kind = undeclaredIsError ? "error" : "warning";
      context.io.out(`  ${paint(`${undeclaredIsError ? "✗" : "⚠"} Not declared in ${exampleName} (${result.extras.length})`, kind, context.io.color)}`);
      for (const key of result.extras) context.io.out(`    ${mark(context, kind)} ${keyName(context, key)}`);
    }
    context.io.out("");
  }

  if (result.missingRequired.length > 0 || (undeclaredIsError && result.extras.length > 0)) {
    context.io.out(`${mark(context, "error")} ${context.targetName ? `${context.targetName} ` : ""}environment invalid`);
    return 1;
  }
  context.io.out(`${mark(context, "success")} ${context.targetName ? `${context.targetName} ` : ""}environment valid${result.extras.length > 0 ? " with warnings" : ""}`);
  return 0;
}

export async function checkAllCommand(
  schemaFile: string,
  targets: CheckTarget[],
  io: CommandIO,
  undeclared: "warn" | "error" = "warn",
  schemaDisplay?: string,
  summaryOnly = false,
): Promise<number> {
  const valid: string[] = [];
  const warnings: string[] = [];
  const invalid: string[] = [];
  const failed: string[] = [];
  const problems: Array<{ name: string; lines: string[] }> = [];

  const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
  const captureProblems = (name: string, lines: string[]) => {
    const start = lines.findIndex((line) => plain(line) === "Problems");
    if (start < 0) return;
    const end = lines.findIndex((line, index) => index > start && /environment (?:invalid|valid)/.test(plain(line)));
    const details = lines.slice(start + 1, end < 0 ? undefined : end);
    while (details[0] === "") details.shift();
    while (details.at(-1) === "") details.pop();
    if (details.length > 0) problems.push({ name, lines: details });
  };

  for (const target of targets) {
    const lines: string[] = [];
    const sectionIO: CommandIO = {
      out(line) { lines.push(line); },
      error(line) { lines.push(`${statusSymbol("error", io.color)} ${line}`); },
      ...(io.color === undefined ? {} : { color: io.color }),
    };

    try {
      const code = await checkCommand({ transport: target.transport, schemaFile, io: sectionIO, undeclared }, [], summaryOnly);
      if (code !== 0) invalid.push(target.name);
      else if (lines.some((line) => line.includes("environment valid with warnings"))) warnings.push(target.name);
      else valid.push(target.name);
      captureProblems(target.name, lines);
    } catch (error) {
      failed.push(target.name);
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`${statusSymbol("error", io.color)} ${message}`);
      problems.push({ name: target.name, lines: [`  ${statusSymbol("error", io.color)} ${message}`] });
    }

    if (!summaryOnly) {
      io.out(paint(target.name, "heading", io.color));
      if (target.valuesFile) io.out(`  ${paint("Values file", "dim", io.color)}  ${paint(target.valuesFile, "strong", io.color)}`);
      if (schemaDisplay) io.out(`  ${paint("Schema file", "dim", io.color)}  ${paint(schemaDisplay, "strong", io.color)}`);
      if (target.valuesFile || schemaDisplay) io.out("");
      for (const line of lines) io.out(line === "" ? "" : `  ${line}`);
      io.out("");
    }
  }

  io.out(paint("Summary", "heading", io.color));
  if (valid.length > 0) io.out(`  ${statusSymbol("success", io.color)} Valid (${valid.length}): ${valid.join(", ")}`);
  if (warnings.length > 0) io.out(`  ${statusSymbol("warning", io.color)} Warnings (${warnings.length}): ${warnings.join(", ")}`);
  if (invalid.length > 0) io.out(`  ${statusSymbol("error", io.color)} Invalid (${invalid.length}): ${invalid.join(", ")}`);
  if (failed.length > 0) io.out(`  ${statusSymbol("error", io.color)} Failed (${failed.length}): ${failed.join(", ")}`);
  if (problems.length > 0) {
    io.out("");
    io.out(paint("Problems", "heading", io.color));
    for (const [index, problem] of problems.entries()) {
      if (index > 0) io.out("");
      io.out(`  ${paint(problem.name, "strong", io.color)}`);
      for (const line of problem.lines) io.out(line === "" ? "" : `  ${line}`);
    }
  }
  return invalid.length > 0 || failed.length > 0 ? 1 : 0;
}

export async function sortCommand(
  context: CommandContext,
  args: string[],
  options: Pick<MutationOptions, "reload"> = {},
): Promise<number> {
  if (args.length !== 0) throw new UsageError("Usage: litenv [environment] sort");
  requireConfiguredReload(context, options.reload);
  const original = await context.transport.read();
  const document = EnvDocument.parse(original);
  document.sortSections();
  await context.transport.write(document.serialize(), { expectedContent: original });
  context.io.out(`${mark(context, "success")} ${context.targetName ? `${context.targetName} ` : ""}environment sorted`);
  await reloadAfterWrite(context, options.reload);
  return 0;
}

export interface DiffTarget {
  name: string;
  transport: EnvTransport;
}

interface DiffTableRow {
  key: string;
  values: Array<string | undefined>;
  result: string;
  same: boolean;
}

function safeTableValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => {
      return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    });
}

function textWidth(value: string): number {
  return [...value].length;
}

function padCell(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - textWidth(value)));
}

function renderDiffTable(
  io: CommandIO,
  rows: DiffTableRow[],
  targets: DiffTarget[],
  values: boolean,
): void {
  const headers = ["KEY", ...targets.map((target) => target.name.toUpperCase()), "RESULT"];
  const cells = rows.map((row) => [
    row.key,
    ...row.values.map((value) => value === undefined ? "—" : values ? safeTableValue(value) : "present"),
    row.result,
  ]);
  const widths = headers.map((header, column) => Math.max(
    textWidth(header),
    ...cells.map((row) => textWidth(row[column] ?? "")),
  ));
  const resultColumn = headers.length - 1;
  const renderRow = (row: string[], same?: boolean): string => row.map((cell, column) => {
    const padded = padCell(cell, widths[column] ?? 0);
    if (column === 0 && same !== undefined) return paint(padded, "strong", io.color);
    if (column !== resultColumn || same === undefined) return padded;
    return paint(padded, same ? "success" : "warning", io.color);
  }).join("  ").trimEnd();

  io.out(paint(renderRow(headers), "heading", io.color));
  io.out(paint(widths.map((width) => "─".repeat(width)).join("  "), "dim", io.color));
  for (const [index, row] of cells.entries()) io.out(renderRow(row, rows[index]?.same));
  if (rows.length === 0) io.out(paint("(no environment variables)", "dim", io.color));
}

export async function diffCommand(
  io: CommandIO,
  targets: DiffTarget[],
  args: string[],
  values: boolean,
): Promise<number> {
  if (args.length !== 0 || targets.length < 2 || targets.length > 3) {
    throw new UsageError("Usage: litenv TARGET:TARGET[:TARGET] diff [--values]");
  }

  const documents: EnvDocument[] = [];
  for (const target of targets) documents.push(EnvDocument.parse(await target.transport.read()));
  const maps = documents.map((document) => new Map(document.entries()));
  const keys = [...new Set(maps.flatMap((map) => [...map.keys()]))].sort((left, right) => left.localeCompare(right));
  const rows: DiffTableRow[] = keys.map((key) => {
    const rowValues = maps.map((map) => map.get(key));
    const present = rowValues.flatMap((value, index) => value === undefined ? [] : [index]);
    const uniqueValues = new Set(rowValues.filter((value): value is string => value !== undefined));
    const missingNames = targets.filter((_target, index) => rowValues[index] === undefined).map((target) => target.name);
    let result: string;
    let same = false;
    if (present.length === 1) {
      result = `only ${targets[present[0] ?? 0]?.name ?? "one target"}`;
    } else if (missingNames.length > 0) {
      result = `missing in ${missingNames.join(", ")}${uniqueValues.size > 1 ? "; different" : ""}`;
    } else if (uniqueValues.size === 1) {
      result = "same";
      same = true;
    } else {
      result = "different";
    }
    return { key, values: rowValues, result, same };
  });
  renderDiffTable(io, rows, targets, values);
  return 0;
}
