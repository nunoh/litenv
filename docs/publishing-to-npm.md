# Publishing litenv to npm

This document records the steps required to publish `litenv` as a public npm package.

Last reviewed: 2026-08-25

## Current readiness

The package is structurally ready to publish:

- The `litenv` package name returned `404 Not Found` from the npm registry on 2026-08-25, which indicates that it is currently available. The final publish is authoritative because availability can change.
- The prerelease version is `0.1.0` while CLI and configuration design can still evolve.
- `package.json` exposes the CLI through the `bin` field.
- Package metadata points to `github.com/nunoh/litenv`, and public publishing is explicit.
- `prepack` builds the TypeScript source, while `prepublishOnly` runs the complete test suite.
- The package contains compiled output, TypeScript source, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`.
- The dry-run package is approximately 54 KB compressed and contains 60 files.
- The CLI has no runtime npm dependencies.
- All 62 tests pass.
- GitHub Actions tests Node.js 18, 20, and 22 and inspects the package dry run.

## Before the first release

### 1. Decide source visibility

The GitHub repository currently exists as a private repository. npm permits publishing from it, but users following the package metadata will not be able to inspect the source or open issues. Make the repository public before release if litenv is intended to be an open-source MIT project.

The project does not need a `main` or `exports` field while it is distributed only as a CLI. Add a public module entry point later only if JavaScript or TypeScript consumers should be able to import it as a library.

### 2. Repair the local npm cache

The npm cache at `/Users/developer/.npm` currently contains root-owned files. npm recommended repairing its ownership with:

```sh
sudo chown -R 501:20 /Users/developer/.npm
```

Review the path before running the command. It should target only this user's npm cache.

Using `--cache /private/tmp/litenv-npm-cache` is a temporary workaround for local dry runs, not a permanent repair.

### 3. Authenticate with npm

Create an npm account if necessary, enable two-factor authentication, and sign in:

```sh
npm login
npm whoami
```

Publishing requires either interactive two-factor authentication or a granular access token configured to bypass 2FA. For automated releases, prefer npm trusted publishing instead of storing a long-lived token.

See the official npm documentation:

- [Creating and publishing unscoped public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [Requiring 2FA for package publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)

## First release

Remove the prerelease notice from the README, date the `0.1.0` changelog entry, run the complete test suite, inspect the package contents, and then publish:

```sh
npm test
npm pack --dry-run
npm publish
```

Because `litenv` is an unscoped package, it is public automatically. The explicit `publishConfig.access` setting documents that intention.

See [npm publish](https://docs.npmjs.com/cli/commands/npm-publish/) for package-content and publishing details.

## Verify the published package

Test the registry version in a clean environment rather than relying on the existing global link:

```sh
npm uninstall --global litenv
npm install --global litenv
litenv --version
litenv --help
```

Also verify project-local installation:

```sh
npm install --save-dev litenv
npx litenv --help
```

## Later releases

Choose the appropriate semantic-version increment and publish it:

```sh
npm version patch
npm publish
```

Use `minor` for backward-compatible features and `major` for breaking CLI or configuration changes.

For a more secure automated release process, configure npm trusted publishing from the GitHub Actions workflow. Trusted publishing avoids a stored npm token and can generate provenance information automatically.
