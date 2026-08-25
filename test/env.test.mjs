import assert from "node:assert/strict";
import test from "node:test";
import { EnvDocument } from "../dist/env/document.js";
import { diffDocuments } from "../dist/env/diff.js";
import { readSchema, validate } from "../dist/env/validate.js";

test("dotenv parsing supports common syntax without interpolation", () => {
  const document = EnvDocument.parse([
    "FOO=bar",
    'SPACED="bar baz"',
    "SINGLE='one two'",
    "EMPTY=",
    "URL=https://example.com?a=b",
    "INLINE=value # explanation",
    "HASH=foo#bar",
    "COMMAND=$(do-not-run)",
    "REFERENCE=${OTHER}",
  ].join("\n"));

  assert.equal(document.get("FOO"), "bar");
  assert.equal(document.get("SPACED"), "bar baz");
  assert.equal(document.get("SINGLE"), "one two");
  assert.equal(document.get("EMPTY"), "");
  assert.equal(document.get("URL"), "https://example.com?a=b");
  assert.equal(document.get("INLINE"), "value");
  assert.equal(document.get("HASH"), "foo#bar");
  assert.equal(document.get("COMMAND"), "$(do-not-run)");
  assert.equal(document.get("REFERENCE"), "${OTHER}");
});

test("unmodified documents round-trip byte for byte", () => {
  const content = "# Heading\r\n\r\nFOO = \"bar baz\" # note\r\nUNKNOWN LINE\r\n";
  assert.equal(EnvDocument.parse(content).serialize(), content);
});

test("set changes only the selected value and preserves style and comments", () => {
  const document = EnvDocument.parse("# comment\nFOO = 'old value' # inline\nBAR=keep\n");
  document.set("FOO", "new value");
  assert.equal(document.serialize(), "# comment\nFOO = 'new value' # inline\nBAR=keep\n");
});

test("set safely quotes a value that cannot remain unquoted", () => {
  const document = EnvDocument.parse("FOO=old\n");
  document.set("FOO", "new # value");
  assert.equal(document.serialize(), 'FOO="new # value"\n');
  assert.equal(EnvDocument.parse(document.serialize()).get("FOO"), "new # value");
});

test("set appends missing keys and supports multiple changes", () => {
  const document = EnvDocument.parse("FOO=old\n");
  document.set("FOO", "new");
  document.set("PORT", "3000");
  document.set("DEBUG", "false");
  assert.equal(document.serialize(), "FOO=new\nPORT=3000\nDEBUG=false\n");
});

test("unset removes all occurrences and leaves unrelated formatting", () => {
  const document = EnvDocument.parse("# top\nFOO=one\n\nBAR=two\nFOO=three\n");
  assert.equal(document.unset("FOO"), true);
  assert.equal(document.unset("MISSING"), false);
  assert.equal(document.serialize(), "# top\n\nBAR=two\n");
});

test("entries use last-value semantics and keep first insertion order", () => {
  const document = EnvDocument.parse("FOO=one\nBAR=two\nFOO=three\n");
  assert.deepEqual(document.entries(), [["FOO", "three"], ["BAR", "two"]]);
});

test("sort orders variables inside blank-line-delimited sections", () => {
  const document = EnvDocument.parse([
    "# Database",
    "DB_POOL_SIZE=10",
    "DATABASE_URL=foo",
    "",
    "# Mail",
    "SMTP_PORT=587",
    "SMTP_HOST=smtp.example.com",
    "",
  ].join("\n"));
  document.sortSections();
  assert.equal(document.serialize(), [
    "# Database",
    "DATABASE_URL=foo",
    "DB_POOL_SIZE=10",
    "",
    "# Mail",
    "SMTP_HOST=smtp.example.com",
    "SMTP_PORT=587",
    "",
  ].join("\n"));
});

test("sort treats comments and unknown lines as semantic boundaries", () => {
  const document = EnvDocument.parse([
    "# Service settings",
    "Z_SERVICE=last",
    "A_SERVICE=first",
    "# This comment belongs to Z_TOKEN",
    "Z_TOKEN=secret",
    "# This comment belongs to A_TOKEN",
    "A_TOKEN=other",
    "UNSUPPORTED LINE",
    "Z_TRAILING=last",
    "A_TRAILING=first",
    "",
  ].join("\n"));
  document.sortSections();
  assert.equal(document.serialize(), [
    "# Service settings",
    "A_SERVICE=first",
    "Z_SERVICE=last",
    "# This comment belongs to Z_TOKEN",
    "Z_TOKEN=secret",
    "# This comment belongs to A_TOKEN",
    "A_TOKEN=other",
    "UNSUPPORTED LINE",
    "A_TRAILING=first",
    "Z_TRAILING=last",
    "",
  ].join("\n"));
});

test("validation distinguishes required, optional, and extra keys", () => {
  const example = EnvDocument.parse("DATABASE_URL=\nPORT=\nSENTRY_DSN= # optional\n");
  assert.deepEqual(readSchema(example), [
    { key: "DATABASE_URL", optional: false },
    { key: "PORT", optional: false },
    { key: "SENTRY_DSN", optional: true },
  ]);
  const result = validate(EnvDocument.parse("DATABASE_URL=postgres\nEXTRA=yes\n"), example);
  assert.deepEqual(result.missingRequired, ["PORT"]);
  assert.deepEqual(result.extras, ["EXTRA"]);
});

test("diff reports key presence and equality without losing values", () => {
  const result = diffDocuments(
    EnvDocument.parse("LOCAL_ONLY=local\nDIFFERENT=one\nSAME=yes\n"),
    EnvDocument.parse("REMOTE_ONLY=remote\nDIFFERENT=two\nSAME=yes\n"),
  );
  assert.deepEqual(result, {
    onlyLocal: [["LOCAL_ONLY", "local"]],
    onlyRemote: [["REMOTE_ONLY", "remote"]],
    different: [["DIFFERENT", "one", "two"]],
    same: [["SAME", "yes"]],
  });
});
