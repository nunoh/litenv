export type QuoteStyle = "single" | "double" | "unquoted";

export interface VariableNode {
  type: "variable";
  key: string;
  value: string;
  raw: string;
  prefix: string;
  suffix: string;
  quote: QuoteStyle;
  changed: boolean;
}

export interface CommentNode {
  type: "comment";
  value: string;
  raw: string;
}

export interface BlankNode {
  type: "blank";
  raw: string;
}

export interface RawNode {
  type: "raw";
  raw: string;
}

export type EnvNode = VariableNode | CommentNode | BlankNode | RawNode;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decodeDoubleQuoted(value: string): string {
  return value.replace(/\\(n|r|t|"|\\)/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case '"': return '"';
      default: return "\\";
    }
  });
}

function findClosingDoubleQuote(input: string): number {
  let escaped = false;
  for (let index = 1; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"' && !escaped) return index;
    if (char === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return -1;
}

function parseValue(input: string): Pick<VariableNode, "value" | "suffix" | "quote"> {
  if (input.startsWith("'")) {
    const end = input.indexOf("'", 1);
    if (end !== -1) {
      return { value: input.slice(1, end), suffix: input.slice(end + 1), quote: "single" };
    }
  }

  if (input.startsWith('"')) {
    const end = findClosingDoubleQuote(input);
    if (end !== -1) {
      return {
        value: decodeDoubleQuoted(input.slice(1, end)),
        suffix: input.slice(end + 1),
        quote: "double",
      };
    }
  }

  const commentMatch = /\s+#/.exec(input);
  const commentIndex = input.startsWith("#") ? 0 : commentMatch?.index;
  if (commentIndex !== undefined) {
    const beforeComment = input.slice(0, commentIndex);
    return {
      value: beforeComment.trimEnd(),
      suffix: input.slice(beforeComment.length),
      quote: "unquoted",
    };
  }

  return { value: input.trimEnd(), suffix: input.slice(input.trimEnd().length), quote: "unquoted" };
}

function parseLine(line: string): EnvNode {
  if (/^\s*$/.test(line)) return { type: "blank", raw: line };
  if (/^\s*#/.test(line)) return { type: "comment", value: line.trimStart().slice(1).trim(), raw: line };

  const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
  if (!match) return { type: "raw", raw: line };

  const [, indent = "", key = "", equals = "=", rawValue = ""] = match;
  const parsed = parseValue(rawValue);
  return {
    type: "variable",
    key,
    value: parsed.value,
    raw: line,
    prefix: `${indent}${key}${equals}`,
    suffix: parsed.suffix,
    quote: parsed.quote,
    changed: false,
  };
}

function encodeValue(value: string, quote: QuoteStyle): { encoded: string; quote: QuoteStyle } {
  if (quote === "single" && !value.includes("'")) return { encoded: `'${value}'`, quote };
  if (quote === "double") {
    return {
      encoded: `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`,
      quote,
    };
  }
  if (value === "" || (!/^\s|\s$/.test(value) && !/[\n\r#'"\\]/.test(value))) {
    return { encoded: value, quote: "unquoted" };
  }
  return {
    encoded: `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`,
    quote: "double",
  };
}

function serializeNode(node: EnvNode): string {
  if (node.type !== "variable" || !node.changed) return node.raw;
  const encoded = encodeValue(node.value, node.quote);
  node.quote = encoded.quote;
  return `${node.prefix}${encoded.encoded}${node.suffix}`;
}

export class EnvDocument {
  readonly nodes: EnvNode[];
  readonly newline: "\n" | "\r\n";
  readonly finalNewline: boolean;

  private constructor(nodes: EnvNode[], newline: "\n" | "\r\n", finalNewline: boolean) {
    this.nodes = nodes;
    this.newline = newline;
    this.finalNewline = finalNewline;
  }

  static parse(content: string): EnvDocument {
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    const finalNewline = content.endsWith("\n");
    const lines = content === "" ? [] : content.split(/\r?\n/);
    if (finalNewline) lines.pop();
    return new EnvDocument(lines.map(parseLine), newline, finalNewline);
  }

  serialize(): string {
    const body = this.nodes.map(serializeNode).join(this.newline);
    return body + (this.finalNewline && this.nodes.length > 0 ? this.newline : "");
  }

  entries(): Array<[string, string]> {
    const values = new Map<string, string>();
    for (const node of this.nodes) {
      if (node.type === "variable") values.set(node.key, node.value);
    }
    return [...values.entries()];
  }

  has(key: string): boolean {
    return this.nodes.some((node) => node.type === "variable" && node.key === key);
  }

  get(key: string): string | undefined {
    let result: string | undefined;
    for (const node of this.nodes) {
      if (node.type === "variable" && node.key === key) result = node.value;
    }
    return result;
  }

  set(key: string, value: string): void {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    for (let index = this.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.nodes[index];
      if (node?.type === "variable" && node.key === key) {
        node.value = value;
        node.changed = true;
        return;
      }
    }

    this.nodes.push({
      type: "variable",
      key,
      value,
      raw: "",
      prefix: `${key}=`,
      suffix: "",
      quote: "unquoted",
      changed: true,
    });
  }

  unset(key: string): boolean {
    const originalLength = this.nodes.length;
    for (let index = this.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.nodes[index];
      if (node?.type === "variable" && node.key === key) this.nodes.splice(index, 1);
    }
    return this.nodes.length !== originalLength;
  }

  sortSections(): void {
    let sectionStart = 0;
    for (let index = 0; index <= this.nodes.length; index += 1) {
      if (index === this.nodes.length || this.nodes[index]?.type === "blank") {
        const variableIndexes: number[] = [];
        const variables: VariableNode[] = [];
        for (let cursor = sectionStart; cursor < index; cursor += 1) {
          const node = this.nodes[cursor];
          if (node?.type === "variable") {
            variableIndexes.push(cursor);
            variables.push(node);
          }
        }
        variables.sort((left, right) => left.key.localeCompare(right.key));
        variableIndexes.forEach((nodeIndex, variableIndex) => {
          const variable = variables[variableIndex];
          if (variable) this.nodes[nodeIndex] = variable;
        });
        sectionStart = index + 1;
      }
    }
  }
}

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}
