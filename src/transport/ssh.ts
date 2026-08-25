import { spawn } from "node:child_process";
import { LitenvError } from "../errors.js";
import type { EnvTransport, WriteOptions } from "./types.js";

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

const CKSUM_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
});

export function posixCksum(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  let crc = 0;
  for (const byte of bytes) {
    crc = (((crc << 8) >>> 0) ^ (CKSUM_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  let length = bytes.length;
  while (length > 0) {
    crc = (((crc << 8) >>> 0) ^ (CKSUM_TABLE[((crc >>> 24) ^ (length & 0xff)) & 0xff] ?? 0)) >>> 0;
    length = Math.floor(length / 256);
  }
  return `${(~crc) >>> 0} ${bytes.length}`;
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

  async runCommand(command: string): Promise<void> {
    await this.execute(command);
  }

  async write(content: string, options: WriteOptions = {}): Promise<void> {
    const target = shellQuote(this.file);
    const script = [
      "set -eu",
      `target=${target}`,
      ...(options.expectedContent === undefined ? [] : [
        `expected_cksum=${shellQuote(posixCksum(options.expectedContent))}`,
        'if [ -e "$target" ]; then actual_cksum=$(cksum < "$target"); else actual_cksum="4294967295 0"; fi',
        'if [ "$actual_cksum" != "$expected_cksum" ]; then',
        '  echo "environment file changed since it was read; no changes were written. Retry the command." >&2',
        "  exit 73",
        "fi",
      ]),
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
