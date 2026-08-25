# litenv

> Small, readable `.env` management — locally and over SSH.

- Check every environment against one `.env.example`.
- Compare two or three environments without revealing values by default.
- Read and update remote `.env` files through your existing SSH configuration.
- Preserve comments, spacing, sections, quoting, and file permissions.

`litenv` is deliberately not a secrets manager. It does not provide encrypted storage or secret distribution; it gives you a careful CLI for the `.env` files you already use.

## Quickstart

Install globally:

```sh
npm install --global litenv
```

Or add it to one project:

```sh
npm install --save-dev litenv
npx litenv check
```

Node.js 18 or newer is required.

Create the schema your environments should follow:

```dotenv
# .env.example
DATABASE_URL=
JWT_SECRET=
PORT=
SENTRY_DSN= # optional
```

With a partial local environment:

```dotenv
# .env
PORT=3000
```

Then check an environment:

```console
$ litenv check

Command
  `litenv local check`

Check
  Environment  dev (local)
  Values file  .env
  Schema file  .env.example

✓ PORT
○ SENTRY_DSN optional, missing

Problems
  ✗ Missing required (2)
    ✗ DATABASE_URL
    ✗ JWT_SECRET

✗ environment invalid
```

Bare commands open an environment selector. Use `local` or a configured environment name explicitly in scripts:

```sh
litenv local check
litenv prod check
```

## Add remote environments

Create `litenv.toml` in the project root:

```toml
[project]
file = ".env"
example = ".env.example"
local_name = "dev"
sort = true
undeclared = "warn"

[env.staging]
host = "my-app-staging"
file = "/srv/my-app/.env"

[env.prod]
host = "my-app"
file = "/srv/my-app/.env"
```

The `host` values are passed directly to the system `ssh` command. Put usernames, identity files, ports, jump hosts, and other connection details in `~/.ssh/config`:

```sshconfig
Host my-app
  HostName 203.0.113.10
  User deploy
  IdentityFile ~/.ssh/my-app
```

The remote machine needs SSH and a standard shell. It does not need Node.js or `litenv` installed.

Now the same commands work remotely:

```sh
litenv prod get DATABASE_URL
litenv prod set PORT=3000
litenv prod check
litenv prod sort
```

## Check every environment

Run `check` without a target to select one or more environments interactively. Use Space to toggle environments and Enter to run the check.

```console
$ litenv check

Commands
  `litenv local check`
  `litenv staging check`
  `litenv prod check`

...

Summary
  ✓ Valid (1): dev
  ⚠ Warnings (1): staging
  ✗ Invalid (1): prod

Problems
  staging
    ⚠ Not declared in .env.example (1)
      ⚠ DEBUG_TOOL

  prod
    ✗ Missing required (2)
      ✗ DATABASE_URL
      ✗ JWT_SECRET
```

The bottom summary is self-contained: it names each valid, warning, invalid, or unreachable environment and repeats every problem grouped by environment.

Check local plus every environment in `litenv.toml` without opening the selector:

```sh
litenv check --all
```

Show only the complete summary, without the individual environment sections:

```sh
litenv check --all --summary
```

`--summary` also works with an explicit environment or after interactive selection:

```sh
litenv prod check --summary
litenv check --summary
```

Checks run sequentially so SSH authentication prompts and errors remain readable. The command exits with status `1` if an environment is invalid or cannot be read.

## Compare environments

Run `diff` to select two or three environments:

```sh
litenv diff
```

Or provide a colon selector explicitly:

```sh
litenv prod:staging diff
litenv :prod diff
litenv staging: diff
litenv :staging:prod diff
```

An empty target means local. Therefore `:prod` compares local with `prod`, while `:staging:prod` performs a three-way comparison.

Values are hidden by default:

```text
KEY             DEV      STAGING  PROD     RESULT
──────────────  ───────  ───────  ───────  ───────────────────
DATABASE_URL    present  present  present  different
DEBUG_TOOL      present  present  —        missing in prod
PORT            present  present  present  same
SENTRY_DSN      —        present  present  missing in dev
```

Reveal values only when you explicitly intend to display them:

```sh
litenv :staging:prod diff --values
```

Values containing newlines, tabs, or terminal control characters are escaped so they cannot break the table layout.

The colon selector is the only explicit diff syntax. Comparisons are capped at three environments to keep the output readable.

## Compare one variable everywhere

Read one key from local and every configured environment:

```console
$ litenv get PORT --all
ENVIRONMENT  VALUE  RESULT
───────────  ─────  ──────────────────────────
dev          3000   found
staging      3000   found
prod         —      failed: connection refused
```

`get --all` continues through missing variables and connection failures, then exits with status `1` if any lookup was unsuccessful.

A regular single-environment `get` stays shell-friendly and prints only the raw value:

```sh
PORT="$(litenv prod get PORT)"
```

## Update variables safely

Set one or more values:

```console
$ litenv prod set PORT=3000 API_TIMEOUT=5000
✓ prod: PORT updated
✓ prod: API_TIMEOUT updated
API_TIMEOUT is missing from .env.example. Add it? [y/N] y
✓ .env.example updated: API_TIMEOUT
```

Only empty placeholders are added to `.env.example`; secret values are never copied there. Mutation status messages also never echo values.

Control example-file synchronization explicitly in scripts:

```sh
litenv prod set API_TIMEOUT=5000 --example
litenv prod set INTERNAL_TOKEN=secret --no-example
```

Remove variables:

```console
$ litenv staging unset DEBUG_TOOL LEGACY_API_KEY
✓ staging: DEBUG_TOOL removed
○ staging: LEGACY_API_KEY not found
```

`set` and `unset` sort variables inside each blank-line-delimited section by default. Override that behavior for one command:

```sh
litenv prod set PORT=3000 --no-sort
litenv prod unset OLD_KEY --no-sort
```

Or sort an entire environment explicitly:

```sh
litenv prod sort
```

## Inspect values

Show an environment:

```sh
litenv prod show
```

`show` displays real values. Redact them before sharing output:

```console
$ litenv prod show --redact
DATABASE_URL=******************************
JWT_SECRET=************
PORT=****
```

List only names or retrieve one raw value:

```sh
litenv prod keys
litenv prod get DATABASE_URL
```

## Environment selection

Every command that needs an environment opens a selector when the environment prefix is omitted:

| Command | Interactive selection |
| --- | --- |
| `get`, `set`, `unset`, `keys`, `show`, `sort` | Exactly one environment |
| `check` | One or more environments |
| `diff` | Two or three environments |

After selection, litenv prints a small command callout before the results:

```text
Command
  `litenv prod check`
```

This makes the equivalent explicit form easy to discover. For multiple checks, each selected environment is shown as its own command.

Interactive selectors require a terminal. CI jobs, pipes, and other non-interactive callers must use `local`, a configured environment, `check --all`, `get --all`, or an explicit diff selector.

## Validation rules

`.env.example` acts as the schema for every environment:

```dotenv
DATABASE_URL=
JWT_SECRET=
SENTRY_DSN= # optional
```

- Variables are required by default.
- The exact inline annotation `# optional` makes a variable optional.
- Missing required variables fail the check.
- Undeclared variables warn by default.
- `[project] undeclared = "error"` makes undeclared variables fail the check.
- Every problem variable is printed on its own line.

Example with both kinds of problem:

```text
Check
  Environment  prod
  Values file  my-app:/srv/my-app/.env
  Schema file  .env.example

Problems
  ✗ Missing required (3)
    ✗ DATABASE_URL
    ✗ JWT_SECRET
    ✗ PORT

  ⚠ Not declared in .env.example (2)
    ⚠ DEBUG_TOOL
    ⚠ LEGACY_API_KEY

✗ prod environment invalid
```

## Configuration reference

The CLI searches from the current directory upward for `litenv.toml`. The directory containing it becomes the project root.

### Project settings

| Setting | Default | Description |
| --- | --- | --- |
| `file` | `".env"` | Local values file, relative to the project root unless absolute |
| `example` | `".env.example"` | Validation schema, relative to the project root unless absolute |
| `local_name` | `"dev"` | Display name for the local environment |
| `sort` | `true` | Sort mutations inside sections by default |
| `undeclared` | `"warn"` | Treat undeclared variables as `"warn"` or `"error"` |

### Remote environment settings

Each `[env.NAME]` table requires:

| Setting | Description |
| --- | --- |
| `host` | SSH host or alias passed to the system `ssh` command |
| `file` | Path to the remote `.env` file; use an absolute path |

## Command reference

| Command | Purpose |
| --- | --- |
| `get KEY` | Print one raw value |
| `get KEY --all` | Print the value across all environments |
| `set KEY=VALUE [...]` | Set one or more variables |
| `unset KEY [...]` | Remove one or more variables |
| `keys` | Print variable names only |
| `show [--redact]` | Show variables and values |
| `check [--summary]` | Validate one or more selected environments |
| `check --all [--summary]` | Validate local and all configured environments |
| `sort` | Sort variables within sections |
| `diff` | Select two or three environments to compare |
| `TARGET:TARGET[:TARGET] diff [--values]` | Compare environments explicitly |

### Mutation options

| Option | Effect |
| --- | --- |
| `--sort` | Sort even when `project.sort` is `false` |
| `--no-sort` | Preserve the current variable order |
| `--example` | Add missing set keys to `.env.example` |
| `--no-example` | Never update `.env.example` |

Set `NO_COLOR=1` to disable terminal styling. Output is automatically plain when redirected.

## CI

Install litenv as a development dependency. After the job creates or retrieves its `.env` file, use an explicit target:

```yaml
# .github/workflows/env-check.yml
name: Environment check

on:
  pull_request:
  push:

jobs:
  env-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx litenv local check --summary
```

For remote checks, configure SSH authentication in the job and run:

```sh
npx litenv check --all --summary
```

## File and secret safety

- Common dotenv forms are supported: unquoted, single-quoted, and double-quoted values, empty values, inline comments, and values containing `=`.
- Values are treated as data. Shell substitutions and variable references are never executed or interpolated.
- Local writes use a temporary file in the same directory followed by an atomic rename.
- Remote writes stream content over stdin to an unpredictable temporary file, preserve the existing mode when possible, and atomically rename it into place.
- `diff` hides values unless `--values` is present.
- `show` reveals values unless `--redact` is present.
- `get` intentionally prints the requested value.

`litenv` does not encrypt `.env` files or replace a secret manager. Protect files, terminal output, shell history, SSH access, and CI logs accordingly.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Operation or validation failure |
| `2` | Invalid command usage |

## Development

```sh
npm install
npm test
```

Link the development build globally:

```sh
npm link
litenv --help
```

See [Publishing litenv to npm](docs/publishing-to-npm.md) for the release checklist.

## License

MIT
