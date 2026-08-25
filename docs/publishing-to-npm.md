# Publishing litenv to npm

This document records the steps required to publish `litenv` as a public npm package.

Last reviewed: 2026-08-25

## Current readiness

The package is structurally ready to publish:

- The `litenv` package name returned `404 Not Found` from the npm registry when checked, which indicates that it is currently available. The final publish is authoritative because availability can change.
- `package.json` exposes the CLI through the `bin` field.
- `prepack` builds the TypeScript source before packaging.
- The package contains `dist`, `README.md`, `LICENSE`, and `package.json`.
- The dry-run package is approximately 34 KB compressed and contains 43 files.
- The CLI has no runtime npm dependencies.
- All 54 tests pass.

## Before the first release

### 1. Add package metadata

Once the GitHub repository location is known, add the following metadata to `package.json` with the real username and URLs:

```json
{
  "author": "Nuno",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/USERNAME/litenv.git"
  },
  "homepage": "https://github.com/USERNAME/litenv#readme",
  "bugs": {
    "url": "https://github.com/USERNAME/litenv/issues"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "prepublishOnly": "npm test"
  }
}
```

Keep the existing scripts when adding `prepublishOnly`.

The project does not need a `main` or `exports` field while it is distributed only as a CLI. Add a public module entry point later only if JavaScript or TypeScript consumers should be able to import it as a library.

### 2. Choose the initial version

The current version is `1.0.0`. Keep it if the CLI behavior and `litenv.toml` format are considered stable. Use `0.1.0` instead if breaking design changes are still expected.

An npm package version cannot be published again after that exact name and version have been used.

### 3. Create the source repository

Initialize Git, create the GitHub repository, and push the source before publishing. npm does not require a public Git repository, but it gives users a place to inspect the source, report issues, and review release history.

### 4. Repair the local npm cache

The npm cache at `/Users/developer/.npm` currently contains root-owned files. npm recommended repairing its ownership with:

```sh
sudo chown -R 501:20 /Users/developer/.npm
```

Review the path before running the command. It should target only this user's npm cache.

### 5. Authenticate with npm

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

Run the complete test suite, inspect the package contents, and then publish:

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
