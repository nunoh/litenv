import { spawn } from "node:child_process";
import { LitenvError } from "../errors.js";
import type { EnvTransport } from "./types.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SshRunner = (args: string[], input?: string) => Promise<ProcessResult>;

export function runSsh(args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new LitenvError("Remote file paths cannot contain control characters");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class SshTransport implements EnvTransport {
  constructor(
    readonly host: string,
    readonly file: string,
    private readonly runner: SshRunner = runSsh,
  ) {}

  private async execute(command: string, input?: string): Promise<string> {
    const result = await this.runner([this.host, command], input);
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      throw new LitenvError(`SSH operation failed on ${this.host}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout;
  }

  async read(): Promise<string> {
    const target = shellQuote(this.file);
    return this.execute(`if [ -e ${target} ]; then cat -- ${target}; fi`);
  }

  async write(content: string): Promise<void> {
    const target = shellQuote(this.file);
    const script = [
      "set -eu",
      `target=${target}`,
      'tmp=$(mktemp "${target}.litenv.XXXXXX")',
      'trap \'rm -f -- "$tmp"\' EXIT HUP INT TERM',
      'cat > "$tmp"',
      'if [ -e "$target" ]; then',
      "  mode=$(stat -c '%a' \"$target\" 2>/dev/null || stat -f '%Lp' \"$target\")",
      '  chmod "$mode" "$tmp"',
      "fi",
      'mv -f -- "$tmp" "$target"',
      "trap - EXIT HUP INT TERM",
    ].join("\n");
    await this.execute(script, content);
  }
}
