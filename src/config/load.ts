import { readFile } from "node:fs/promises";
import path from "node:path";
import { LitenvError } from "../errors.js";
import type { LitenvConfig, ProjectConfig, RemoteEnvironment } from "./types.js";

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  file: ".env",
  example: ".env.example",
  localName: "dev",
  sort: true,
  undeclared: "warn",
};

function removeComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === "'" || character === '"') && !escaped) {
      quote = quote === character ? undefined : quote ?? character;
    } else if (character === "#" && quote === undefined) {
      return line.slice(0, index);
    }
    escaped = false;
  }
  return line;
}

function parseString(raw: string, configPath: string, lineNumber: number): string {
  const value = raw.trim();
  try {
    if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  } catch {
    // The consistent diagnostic below is more useful than JSON's parser error.
  }
  throw new LitenvError(`${configPath}:${lineNumber}: expected a quoted string`);
}

export function parseConfig(content: string, configPath: string): LitenvConfig {
  const partial: Record<string, Partial<RemoteEnvironment>> = {};
  const project: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG };
  let currentEnvironment: string | undefined;
  let inProject = false;

  content.split(/\r?\n/).forEach((sourceLine, index) => {
    const lineNumber = index + 1;
    const line = removeComment(sourceLine).trim();
    if (line === "") return;

    if (line === "[project]") {
      currentEnvironment = undefined;
      inProject = true;
      return;
    }

    const table = /^\[env\.([A-Za-z0-9_-]+)]$/.exec(line);
    if (table?.[1]) {
      if (table[1] === "local") throw new LitenvError(`${configPath}:${lineNumber}: env.local is reserved`);
      currentEnvironment = table[1];
      inProject = false;
      partial[currentEnvironment] ??= {};
      return;
    }

    const property = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (property?.[1] && property[2]) {
      const key = property[1];
      const rawValue = property[2];
      if (currentEnvironment && (key === "host" || key === "file")) {
        partial[currentEnvironment]![key] = parseString(rawValue, configPath, lineNumber);
        return;
      }
      if (inProject && (key === "file" || key === "example")) {
        project[key] = parseString(rawValue, configPath, lineNumber);
        if (project[key] === "") throw new LitenvError(`${configPath}:${lineNumber}: project.${key} cannot be empty`);
        return;
      }
      if (inProject && key === "local_name") {
        const value = parseString(rawValue, configPath, lineNumber);
        if (!/^[A-Za-z0-9_-]+$/.test(value)) {
          throw new LitenvError(`${configPath}:${lineNumber}: project.local_name must contain only letters, numbers, _ or -`);
        }
        project.localName = value;
        return;
      }
      if (inProject && key === "sort") {
        const boolean = rawValue.trim();
        if (boolean !== "true" && boolean !== "false") {
          throw new LitenvError(`${configPath}:${lineNumber}: project.sort must be true or false`);
        }
        project.sort = boolean === "true";
        return;
      }
      if (inProject && key === "undeclared") {
        const value = parseString(rawValue, configPath, lineNumber);
        if (value !== "warn" && value !== "error") {
          throw new LitenvError(`${configPath}:${lineNumber}: project.undeclared must be "warn" or "error"`);
        }
        project.undeclared = value;
        return;
      }
    }

    throw new LitenvError(`${configPath}:${lineNumber}: unsupported configuration`);
  });

  const environments: Record<string, RemoteEnvironment> = {};
  for (const [name, environment] of Object.entries(partial)) {
    if (!environment.host || !environment.file) {
      throw new LitenvError(`${configPath}: env.${name} must define both host and file`);
    }
    environments[name] = { host: environment.host, file: environment.file };
  }

  return { path: configPath, root: path.dirname(configPath), project, environments };
}

export async function loadConfig(startDirectory: string): Promise<LitenvConfig | undefined> {
  let directory = path.resolve(startDirectory);
  while (true) {
    const configPath = path.join(directory, "litenv.toml");
    try {
      const content = await readFile(configPath, "utf8");
      return parseConfig(content, configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
