# pi-extension-ssh runbooks

## Goal
Add an initial runbook capability on top of the SSH operational foundation so teams can execute repeatable SSH workflows with preview, confirmation, and logging.

## Context
The extension already had target management, preflight, health checks, session summaries, and structured logs. The next natural step was a runbook layer for repeatable operational sequences.

## Decisions
- Added JSON-based runbook discovery from project-local and global runbook directories.
- Added `/ssh-runbooks` for listing available runbooks.
- Added `/ssh-runbook` to preview and execute a runbook against its default target, an explicit target override, or a selected configured target.
- Kept runbook execution under the same SSH target resolution and environment policy checks.
- Added example runbooks for production health checks and staging smoke checks.
- Deferred markdown/frontmatter runbooks for now to keep the first version simple and predictable.
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
- `examples/runbooks/prod-health-check.json`
- `examples/runbooks/staging-deploy-smoke.json`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-runbooks.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- Runbooks are JSON-only for now.
- Execution is sequential and simple by design; there is no branching, templating, or parameter interpolation yet.

## Next
- Run final validation.
- If approved later, prepare a patch release for the runbook feature.
