# Changelog

## 0.1.0 - 2026-08-28

- Added local and SSH-based `.env` management.
- Added interactive environment selection and explicit script-friendly targets.
- Added schema checks, complete multi-environment summaries, and `--summary` output.
- Added safe two-way and three-way environment diffs.
- Added format-preserving, sorted, atomic mutations with `.env.example` synchronization.
- Added optional per-environment reload commands with safe prompts and `--reload` opt-in.
- Added hidden terminal input and `--stdin` for values that should not enter shell history.
- Added stale-write detection for local and remote mutations.
- Made default sorting preserve the meaning of comments and unknown lines.
- Renamed `keys` to the more domain-specific `vars` command before the first release.
