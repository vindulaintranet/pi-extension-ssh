# pi-extension-ssh TUI config setup

## Goal
Make first-time SSH target setup easier by guiding users through creation of `.pi/ssh/config.json` from the TUI instead of stopping at a warning.

## Context
The extension already had config-driven targets, examples, and interactive connection commands. A remaining UX gap was the first-run path: `/ssh-connect` and `/ssh-targets` only warned when no targets existed.

## Decisions
- Added `/ssh-configure` as a dedicated TUI wizard for project-local SSH config setup.
- Made `/ssh-connect` and `/ssh-targets` offer guided config creation when no targets are configured.
- Kept JSON as the source of truth, but moved data collection into TUI prompts and a final review editor.
- Added a reusable starter-config generator in `ssh-core.ts` with unit-test coverage.
- Kept the saved file at `.pi/ssh/config.json` to preserve the existing configuration model.

## Commands run
- `npm test`
- `npm run check:bundle`
- `npm run validate`
- `git diff --check`

## Files changed
- `ssh.ts`
- `ssh-core.ts`
- `test/ssh-core.test.ts`
- `README.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-tui-config-setup.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- The TUI wizard currently writes a starter project config and intentionally keeps the flow simple; advanced multi-target editing still happens in JSON.
- If a malformed config already exists, the wizard currently prompts before overwrite rather than attempting complex in-place repair/merge.

## Next
- Consider a future multi-target TUI editor for adding more targets without reopening raw JSON.
- Consider a “save to global config” option if operators ask for it.
