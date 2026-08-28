# litenv

[![CI](https://github.com/nunoh/litenv/actions/workflows/ci.yml/badge.svg)](https://github.com/nunoh/litenv/actions/workflows/ci.yml)

> Small, readable `.env` management — locally and over SSH.

- validate local and remote environments against one `.env.example`
- compare values side by side across two or three environments, redacted by default
- inspect, set, unset, and sort remote `.env` files through your existing SSH setup
- choose environments interactively or use explicit, script-friendly commands
- enter secrets without exposing them in shell history, and reject stale writes
- preserve spacing, sections, quoting, inline comments, and file permissions
- optionally keep `.env.example` in sync and reload applications after mutations

The name is **lite + env**: a lightweight tool for environment files. It also reads as “lit env”—an environment workflow that is, frankly, pretty cool.

`litenv` is deliberately not a secrets manager. It does not provide encrypted storage or secret distribution. It gives developers running conventional apps on local machines and SSH-accessible servers a careful CLI for the `.env` files they already use.

## Quickstart

> `litenv` is currently in prerelease development and has not had its first npm release. Link this checkout to try it now:

```sh
npm install
npm link
litenv --help
```

After the first npm release, install globally:

```sh
npm install --global litenv
```

Or install it in one project:

```sh
npm install --save-dev litenv
npx litenv check
```

Node.js 18 or newer is required.

litenv adopts [dotenvx's `.env.example` validation convention](https://github.com/dotenvx/dotenvx#validation): variables are required by default, while the exact `# optional` annotation marks an optional variable. That one example file becomes the schema for every environment:

```dotenv
# .env.example
DATABASE_URL=
JWT_SECRET=
PORT=
SENTRY_DSN= # optional
```

With a partial local file:

```dotenv
# .env
PORT=3000
```

Check your local `.env`:

```console
$ litenv local check
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

Or omit `local` to choose an environment interactively:

```console
$ litenv check

Command
  `litenv local check`

...
```

## Manage Anywhere

> Use the same commands for local, staging, and production-like environments. The remote machine only needs SSH and a standard shell.

Create `litenv.toml`:

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
reload = "pm2 reload my-app --update-env"
```

Then target environments by name:

```sh
litenv prod get DATABASE_URL
litenv staging set PORT=3000
litenv prod check
litenv prod sort
```

`host` is passed to the system `ssh` command. Keep usernames, ports, keys, jump hosts, and connection options in `~/.ssh/config`:

```sshconfig
Host my-app
  HostName 203.0.113.10
  User deploy
  IdentityFile ~/.ssh/my-app
```

Node.js and `litenv` do not need to be installed remotely. The remote host needs SSH, a standard shell, and the POSIX `cksum` utility used to detect stale writes.

### Reload after writes

Some applications read `.env` only at process startup. Add a `reload` command to an environment when a file update may need to restart or reload that application:

```toml
[env.vps]
host = "app-vps"
file = "/srv/my-app/.env"
reload = "pm2 reload my-app --update-env"
```

Interactive mutations offer to reload, with a safe default of no:

```console
$ litenv vps set PORT=3000
✓ vps: PORT updated
Run reload command for vps? [y/N] y
○ vps: running reload
✓ vps: reload complete
```

Pressing Enter or answering no leaves the updated file in place without reloading. In scripts—or whenever prompting is unwanted—opt in explicitly:

```sh
litenv vps set PORT=3000 --reload
litenv vps unset OLD_KEY --reload
litenv vps sort --reload
```

Without `--reload`, non-interactive mutations never reload. The prompt is offered after `set`, an `unset` that removed at least one key, and `sort`. It is not offered after reads, checks, diffs, failed writes, or an `unset` that changed nothing.

Using `--reload` with local or with a remote environment that has no configured command fails before the file is touched.

If the file write succeeds but reload fails, litenv returns status `1` and makes the partial result explicit:

```text
vps: environment file updated, but reload failed: SSH operation failed on app-vps: process not found
```

## Check Every Environment

> Select any number of environments interactively, or use `--all` to check everything configured.

```sh
litenv check
litenv check --all
litenv check --all --summary
```

The aggregate summary repeats every problem, so the bottom of the output is enough to diagnose the whole project:

```text
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

`--summary` hides the individual environment sections and prints only the complete result above.

## Compare Without Leaking Values

> Diff two or three environments in one table. Values stay hidden unless you explicitly add `--values`.

```sh
litenv diff
litenv prod:staging diff
litenv :prod diff
litenv :staging:prod diff
```

```text
KEY             DEV      STAGING  PROD     RESULT
──────────────  ───────  ───────  ───────  ───────────────────
DATABASE_URL    present  present  present  different
DEBUG_TOOL      present  present  —        missing in prod
PORT            present  present  present  same
SENTRY_DSN      —        present  present  missing in dev
```

An empty target means local, so `:prod` compares local with `prod`. Add `--values` only when displaying the real values is intentional.

## Commands

Every litenv command is listed below. Expand one for syntax, examples, output, flags, and scripting behavior.

<details>
<summary><code>get KEY</code> — print one raw value</summary>

Choose an environment interactively:

```sh
litenv get DATABASE_URL
```

Target local or remote explicitly:

```sh
litenv local get DATABASE_URL
litenv prod get DATABASE_URL
```

`get` writes only the raw value to stdout, which keeps command substitution simple:

```sh
DATABASE_URL="$(litenv prod get DATABASE_URL)"
```

A missing key exits with status `1` and writes `KEY not found` to stderr.

</details>

<details>
<summary><code>get KEY --all</code> — compare one value everywhere</summary>

Read a key from local plus every configured environment:

```console
$ litenv get PORT --all
ENVIRONMENT  VALUE  RESULT
───────────  ─────  ──────────────────────────
dev          3000   found
staging      3000   found
prod         —      failed: connection refused
```

The command continues through missing values and connection failures. It exits with status `1` if any lookup was unsuccessful.

Unlike a regular `get`, this form intentionally labels every value and is designed for comparison rather than raw command substitution.

</details>

<details>
<summary><code>set KEY[=VALUE] [...]</code> — set one or more variables</summary>

Set values locally or remotely:

```sh
litenv local set PORT=3000
litenv prod set PORT=3000 API_TIMEOUT=5000
```

For secrets, omit the value and litenv asks for it without echoing the input:

```console
$ litenv prod set INTERNAL_TOKEN
Value for INTERNAL_TOKEN (input hidden):
✓ prod: INTERNAL_TOKEN updated
```

Pipe one value in scripts so it never appears in the command arguments:

```sh
printf %s "$INTERNAL_TOKEN" | litenv prod set INTERNAL_TOKEN --stdin --no-example
```

`--stdin` accepts exactly one key and removes one trailing newline from the piped value. Inline `KEY=VALUE` remains convenient for non-sensitive values.

```text
✓ prod: PORT updated
✓ prod: API_TIMEOUT updated
API_TIMEOUT is missing from .env.example. Add it? [y/N] y
✓ .env.example updated: API_TIMEOUT
```

Only empty placeholders are added to `.env.example`; values are never copied there. Mutation status output also never echoes values.

Use explicit behavior in scripts:

```sh
litenv prod set API_TIMEOUT=5000 --example
litenv prod set LOG_LEVEL=debug --no-example
```

Mutations sort contiguous variable runs by default. Comments, blank lines, and unknown lines act as boundaries so sorting cannot silently attach a comment to the wrong key:

```sh
litenv prod set PORT=3000 --no-sort
litenv prod set PORT=3000 --sort
```

| Option | Effect |
| --- | --- |
| `--example` | Add missing keys to `.env.example` with empty values |
| `--no-example` | Never update `.env.example` |
| `--sort` | Sort even when `project.sort` is `false` |
| `--no-sort` | Preserve the current variable order |
| `--reload` | Run the configured remote reload without prompting |
| `--stdin` | Read one value from stdin instead of command arguments |

When the selected remote environment defines `reload`, interactive use asks whether to run it after the file write. Add `--reload` to run it without prompting.

</details>

<details>
<summary><code>unset KEY [...]</code> — remove one or more variables</summary>

```console
$ litenv staging unset DEBUG_TOOL LEGACY_API_KEY
✓ staging: DEBUG_TOOL removed
○ staging: LEGACY_API_KEY not found
```

Unset locally or remotely:

```sh
litenv local unset DEBUG_TOOL
litenv prod unset DEBUG_TOOL LEGACY_API_KEY
```

The file is sorted after a successful removal by default. Use `--no-sort` to preserve its current order.

If the remote environment defines `reload`, interactive use prompts only when at least one key was actually removed. Add `--reload` to opt in non-interactively.

</details>

<details>
<summary><code>vars</code> — print variable names only</summary>

```console
$ litenv prod vars
DATABASE_URL
JWT_SECRET
PORT
SENTRY_DSN
```

`vars` prints one undecorated variable name per line, making it safe to pipe or redirect:

```sh
litenv prod vars > prod-vars.txt
```

</details>

<details>
<summary><code>show [--redact]</code> — show an environment</summary>

Show real values:

```sh
litenv prod show
```

Redact values before sharing output:

```console
$ litenv prod show --redact
DATABASE_URL=******************************
JWT_SECRET=************
PORT=****
```

`show` reveals values by default. Redaction uses one `*` per character so the original length remains visible.

</details>

<details>
<summary><code>check [--summary]</code> — validate one or more environments</summary>

Following the dotenvx convention, `.env.example` is the schema:

```dotenv
DATABASE_URL=
JWT_SECRET=
SENTRY_DSN= # optional
```

- variables are required by default
- the exact annotation `# optional` makes a variable optional
- missing required variables fail the check
- undeclared variables warn by default
- `project.undeclared = "error"` makes undeclared variables fail the check

Choose one or more environments:

```sh
litenv check
```

Or target one explicitly:

```sh
litenv local check
litenv prod check
litenv prod check --summary
```

Example failure:

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

Each problem variable gets its own line. `--summary` removes successful and optional variable details while retaining problems and the final result.

</details>

<details>
<summary><code>check --all [--summary]</code> — validate everything configured</summary>

Check local first, followed by every `[env.NAME]` entry:

```sh
litenv check --all
```

Only print the self-contained aggregate result:

```sh
litenv check --all --summary
```

Checks run sequentially so SSH prompts and diagnostics remain readable. Unreachable environments do not stop later checks. The command exits with status `1` if any environment is invalid or cannot be read.

```text
Summary
  ✓ Valid (2): dev, staging
  ⚠ Warnings (1): preview
  ✗ Invalid (1): prod
  ✗ Failed (1): qa

Problems
  preview
    ⚠ Not declared in .env.example (1)
      ⚠ DEBUG_TOOL

  prod
    ✗ Missing required (1)
      ✗ DATABASE_URL

  qa
    ✗ SSH operation failed on qa
```

</details>

<details>
<summary><code>sort</code> — sort variables within sections</summary>

```console
$ litenv prod sort
✓ prod environment sorted
```

Sorting is comment-aware. Contiguous variable runs are alphabetized, while comments, blank lines, and unknown lines remain semantic boundaries. Inline comments move with their variables.

`set` and `unset` already sort by default. Use `sort` when an existing file needs a complete cleanup.

Sorting writes the file, so interactive use also offers the selected remote environment's configured reload. Add `--reload` to run it without prompting.

</details>

<details>
<summary><code>diff</code> — compare two or three environments</summary>

Choose targets interactively:

```sh
litenv diff
```

Use the explicit colon syntax in scripts:

```sh
litenv prod:staging diff
litenv :prod diff
litenv staging: diff
litenv :staging:prod diff
```

Colon selectors contain exactly two or three unique targets. An empty target means local.

The default table reports presence and equality without showing values:

```text
KEY           DEV      PROD     RESULT
────────────  ───────  ───────  ─────────
DATABASE_URL  present  present  different
DEBUG_TOOL    present  —        only dev
PORT          present  present  same
```

Reveal values explicitly:

```sh
litenv :prod diff --values
```

Newlines, tabs, backslashes, and control characters are escaped to keep every value on one terminal row.

</details>

<details>
<summary><code>--help</code> and <code>--version</code> — CLI information</summary>

```sh
litenv --help
litenv -h
litenv --version
litenv -v
```

</details>

## Environment Selection

Omit the environment prefix to open a terminal selector:

| Command | Selection |
| --- | --- |
| `get`, `set`, `unset`, `vars`, `show`, `sort` | Exactly one environment |
| `check` | One or more environments |
| `diff` | Two or three environments |

After selection, litenv prints a small callout showing the explicit command:

```text
Command
  `litenv prod check`
```

Multiple checks show one command per selected environment:

```text
Commands
  `litenv local check`
  `litenv staging check`
```

Interactive selection requires a terminal. Scripts, CI jobs, pipes, and redirects must use an explicit target, `check --all`, `get --all`, or a colon diff selector.

## Configuration

The CLI searches upward from the current directory for `litenv.toml`. Its directory becomes the project root.

### Project settings

| Setting | Default | Description |
| --- | --- | --- |
| `file` | `".env"` | Local values file, relative to the project root unless absolute |
| `example` | `".env.example"` | Validation schema, relative to the project root unless absolute |
| `local_name` | `"dev"` | Display name for the local environment |
| `sort` | `true` | Sort successful mutations inside sections |
| `undeclared` | `"warn"` | Treat undeclared variables as `"warn"` or `"error"` |

### Remote environments

Each `[env.NAME]` table requires:

| Setting | Description |
| --- | --- |
| `host` | SSH host or alias passed to the system `ssh` command |
| `file` | Path to the remote `.env` file; use an absolute path |
| `reload` | Optional remote shell command offered after successful mutations |

## CI

Install litenv as a development dependency. After creating or retrieving the job's `.env` file, use an explicit target:

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
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
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

## What I Could Have Used

These are good tools. I did not build litenv because they are bad; I built it because they solve adjacent problems or introduce a larger operational model than I wanted.

| Tool | Use it when | Why I did not use it for this job |
| --- | --- | --- |
| [dotenvx](https://github.com/dotenvx/dotenvx) | You want encrypted `.env` files, runtime injection, expansion, or multiple local file conventions. | It is the closest alternative—and the direct inspiration for litenv's `.env.example` schema. I wanted named local and SSH targets, multi-host checks and diffs, in-place mutation, and optional reload hooks without adopting encryption or key management. |
| [dotenv-linter](https://github.com/dotenv-linter/dotenv-linter) | You mainly need fast linting, formatting checks, fixes, and diffs for dotenv files. | It focuses on file correctness. litenv treats local and remote environments as operational targets that can be inspected and safely changed. |
| [direnv](https://direnv.net/) | You want environment variables automatically loaded and unloaded as you move between project directories. | It manages the current shell session rather than a set of named environment files across SSH hosts. |
| [Infisical](https://infisical.com/docs/documentation/getting-started/introduction) or [Doppler](https://docs.doppler.com/docs/start) | You need centralized storage, access control, auditing, rotation, approvals, or secret distribution. | At that point, a real secrets platform is probably the right answer. litenv intentionally stays with the `.env` files and SSH access you already operate. |

litenv occupies the small space between “edit the file by hand” and “adopt a secrets platform.”

## File and Secret Safety

- Common dotenv forms are supported: unquoted, single-quoted, and double-quoted values, empty values, inline comments, and values containing `=`.
- Values are data. Shell substitutions and variable references are never executed or interpolated.
- Local writes use a temporary file in the same directory followed by an atomic rename.
- Remote writes stream content over stdin to an unpredictable temporary file, preserve the original mode when possible, and atomically rename it into place.
- Before replacing a file, mutations verify that it still matches the version litenv read. If another process changed it, litenv refuses the write and asks you to retry.
- `diff` hides values unless `--values` is present.
- `show` reveals values unless `--redact` is present.
- `get` intentionally prints the requested value.
- Mutation status output never echoes values.
- `set KEY` reads a value without terminal echo; `set KEY --stdin` keeps it out of process arguments. Inline `KEY=VALUE` can still be retained by shell history.
- A configured `reload` value is executed as a remote shell command. Treat `litenv.toml` as trusted executable configuration before running mutations.

`litenv` does not encrypt `.env` files or replace a secret manager. Protect files, terminal output, shell history, SSH access, and CI logs accordingly.

Set `NO_COLOR=1` to disable terminal styling. Output is automatically plain when redirected.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Operation or validation failure |
| `2` | Invalid command usage |

## Development

```sh
npm install
npm test
npm run cloc
```

Link the development build globally:

```sh
npm link
litenv --help
```

See [Publishing litenv to npm](docs/publishing-to-npm.md) for the release checklist.

## License

MIT
