# pi-extension-ssh target manager TUI

## Goal
Add a TUI-based target manager so users can maintain project-local SSH targets without manually editing JSON for common operations.

## Context
The extension already supported a first-run TUI wizard via `/ssh-configure`, but post-setup workflows still pushed users back into raw JSON for add/edit/remove tasks. The goal here was to keep JSON as the source of truth while making routine target management easier.

## Decisions
- Added `/ssh-manage` as a TUI manager for project-local targets.
- Kept management scoped to `.pi/ssh/config.json` to avoid surprising edits to global SSH config.
- Added add, edit, remove, review-local-JSON, and connect actions.
- Reused TUI prompts plus a final JSON editor instead of building a fully custom component.
- Added raw-config helper functions in `ssh-core.ts` for upsert/remove behavior and allowlist syncing.
- Added repair flow for invalid project JSON before target management proceeds.
- Did not create a release yet per user request.

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
- `docs/agent/notes/2026-03-23-pi-extension-ssh-target-manager-tui.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- The target manager intentionally edits only project-local config. Global config still requires manual editing if needed.
- The manager uses dialog-based TUI flows rather than a single custom full-screen component, which keeps implementation simpler but less dense.

## Next
- Run final validation.
- If approved, commit and push without cutting a release.
