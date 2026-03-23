# pi-extension-ssh runbooks release v0.1.7

## Goal
Package and publish the expanded SSH runbook feature set as the next patch release.

## Context
Runbooks had already grown from initial JSON-only support into a broader operator workflow: Markdown/frontmatter support, parameterized execution, interactive filtering, and dedicated report export. The repository was validated and ready for release.

## Decisions
- Released the expanded runbook capability as `v0.1.7`.
- Bumped package metadata in `package.json` and `package-lock.json`.
- Moved the runbook changes from `## Unreleased` into the `## 0.1.7` changelog section.
- Kept the release as a patch version because it adds backward-compatible capability without changing the public install model.

## Commands run
- `npm run validate`
- `git diff --check`
- `git tag v0.1.7`
- `git push origin main --tags`

## Files changed
- `package.json`
- `package-lock.json`
- `CHANGELOG.md`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-runbooks-release.md`

## Tests
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- GitHub Release creation still depends on the tag-triggered Actions workflow.
- The existing `softprops/action-gh-release` Node 20 deprecation warning may still appear, though prior releases completed successfully.

## Next
- Confirm the GitHub Actions release workflow completes for `v0.1.7`.
