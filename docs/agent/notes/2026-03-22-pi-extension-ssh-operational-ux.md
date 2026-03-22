# pi-extension-ssh operational UX upgrades

## Goal
Improve the operational UX of `pi-extension-ssh` with the first set of high-value interactive commands and stronger active-target visibility.

## Context
The package already supported remote session mode, `/ssh-run`, structured logs, profiles, allowlist, and environment policies. The next priority was to make day-to-day operation smoother and safer.

## Decisions
- Added `/ssh-connect` for interactive target selection.
- Added `/ssh-disconnect` to leave remote mode explicitly.
- Added `/ssh-health` to validate target connectivity and required remote tools.
- Added `/ssh-context` to inspect the active target, policy, and log information.
- Strengthened the active-target visual indicator using environment-aware status text and a persistent widget.
- Tightened policy behavior so certain confirmation-required operations block in non-interactive mode instead of silently proceeding.
- Kept tests focused on core helpers and validated the extension via bundling.

## Commands run
- `npm test`
- `npm run check:bundle`
- `npm run validate`
- `git diff --check`

## Files changed
- `ssh.ts`
- `README.md`
- `docs/agent/notes/2026-03-22-pi-extension-ssh-operational-ux.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- The new commands improve UX, but they are mostly extension-level behavior and not directly unit-tested end-to-end.
- `ssh-health` depends on the remote host being reachable and on shell command execution working normally.

## Next
- Cut a patch release for these UX upgrades.
- Optionally add screenshots or terminal demos showing `/ssh-connect`, `/ssh-health`, and the active SSH widget.
