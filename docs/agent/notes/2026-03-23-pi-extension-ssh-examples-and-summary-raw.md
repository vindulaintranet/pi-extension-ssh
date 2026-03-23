# pi-extension-ssh examples and richer summary exports

## Goal
Add ready-made SSH config templates and improve session summary exports with raw-entry and fuller report options.

## Context
The package already had inline config documentation in the README plus session summary/export support. The next step was to make adoption easier with copy-pasteable templates and make reports more useful for audit/handoff workflows.

## Decisions
- Added packaged `examples/` templates for common scenarios instead of relying only on one inline README snippet.
- Kept the README inline config as the compact explanatory example, and linked to `examples/` for copy-paste-ready setups.
- Added `/ssh-summary --raw` for filtered raw JSONL export.
- Added `/ssh-summary --include-entries` so text/markdown reports can include the full filtered entry list.
- Included `examples/` in published package files.

## Commands run
- `npm test`
- `npm run check:bundle`
- `npm run validate`
- `git diff --check`

## Files changed
- `ssh.ts`
- `README.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `examples/README.md`
- `examples/dev-staging-prod.config.json`
- `examples/bastion-jumpbox.config.json`
- `examples/customer-environments.config.json`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-examples-and-summary-raw.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- The packaged example configs are illustrative templates and still require operator-specific hostnames, usernames, paths, and blocked-command lists.
- Raw exports are session-scoped and reflect the filtered log slice for the current or most recent session, not a full historical query engine.

## Next
- Release a patch version with the new examples and summary options.
- Consider adding an `examples/.pi/ssh/config.json` folder structure variant if users want direct drop-in paths.
