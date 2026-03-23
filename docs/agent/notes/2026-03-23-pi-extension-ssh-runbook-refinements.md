# pi-extension-ssh runbook refinements

## Goal
Refine the new runbook capability with better selection UX, clearer generic parameter support, and a dedicated export path for runbook execution reports.

## Context
The previous runbook iteration added Markdown/frontmatter support, parameter prompting, and session-summary integration. The next step was improving day-to-day usability without changing the core execution model.

## Decisions
- Added interactive filter/search inside the `/ssh-runbook` selector so larger runbook catalogs remain usable.
- Expanded runbook filtering to consider step content and parameter metadata, not just top-level names and tags.
- Documented and supported generic parameter passing via `--param key=value`, while keeping simple `--service`, `--container`, and `--path` style flags working.
- Added `/ssh-runbook-report` so teams can export only runbook execution artifacts without the broader SSH session summary.
- Kept report export formats aligned with existing summary formats: `text`, `markdown`, and `json`.

## Commands run
- `npm test`
- `npm run check:bundle`
- `npm run validate`
- `git diff --check`

## Files changed
- `ssh.ts`
- `README.md`
- `CHANGELOG.md`
- `examples/README.md`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-runbook-refinements.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- The interactive selector still uses simple substring filtering rather than fuzzy ranking.
- Generic parameter parsing is intentionally lightweight and favors predictable CLI patterns over a more complex parser.

## Next
- Run final validation.
- If approved, roll this into the next runbook-focused patch release.
