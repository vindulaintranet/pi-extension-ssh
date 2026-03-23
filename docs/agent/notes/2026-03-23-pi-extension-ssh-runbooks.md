# pi-extension-ssh runbooks

## Goal
Add a human-friendly runbook capability on top of the SSH operational foundation so teams can execute repeatable SSH workflows with preview, parameters, confirmation, logging, and summary export support.

## Context
The extension already had target management, preflight, health checks, session summaries, and structured logs. The next natural step was a runbook layer for repeatable operational sequences.

## Decisions
- Added runbook discovery from project-local and global runbook directories.
- Added Markdown + frontmatter support for runbooks, while keeping JSON support.
- Added `/ssh-runbooks` filtering/search.
- Added `/ssh-runbook` parameter overrides such as `--service`, `--container`, and `--path`.
- Added parameter prompting for missing runbook values in interactive mode.
- Added runbook report attachment to session summaries so `/ssh-summary` exports now include runbook results when available.
- Added Markdown and JSON example runbooks for production health checks and staging smoke checks.
- Kept execution sequential and policy-aware.
- Did not create a release in this step.

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
- `examples/README.md`
- `examples/runbooks/prod-health-check.md`
- `examples/runbooks/staging-deploy-smoke.md`
- `examples/runbooks/prod-health-check.json`
- `examples/runbooks/staging-deploy-smoke.json`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-runbooks.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- Runbooks are now Markdown/frontmatter-friendly, but advanced templating, branching, and typed parameter schemas are still out of scope.
- The `/ssh-runbooks` filter uses simple substring matching rather than fuzzy search.

## Next
- If approved, prepare a patch release for the expanded runbook feature set.
