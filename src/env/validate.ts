import { EnvDocument } from "./document.js";

export interface SchemaEntry {
  key: string;
  optional: boolean;
}

export interface ValidationResult {
  entries: Array<SchemaEntry & { present: boolean }>;
  extras: string[];
  missingRequired: string[];
}

export function readSchema(document: EnvDocument): SchemaEntry[] {
  const seen = new Set<string>();
  const schema: SchemaEntry[] = [];
  for (const node of document.nodes) {
    if (node.type !== "variable" || seen.has(node.key)) continue;
    seen.add(node.key);
    schema.push({ key: node.key, optional: /#\s*optional\b/i.test(node.suffix) });
  }
  return schema;
}

export function validate(actual: EnvDocument, example: EnvDocument): ValidationResult {
  const schema = readSchema(example);
  const expected = new Set(schema.map(({ key }) => key));
  const entries = schema.map((entry) => ({ ...entry, present: actual.has(entry.key) }));
  return {
    entries,
    extras: actual.entries().map(([key]) => key).filter((key) => !expected.has(key)),
    missingRequired: entries.filter((entry) => !entry.optional && !entry.present).map(({ key }) => key),
  };
}
