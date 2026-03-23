# pi-extension-ssh target manager filter and release

## Goal
Finish the enterprise target manager UX with filtering/search for larger target catalogs and publish a patch release.

## Context
The manager already showed local/global targets and supported global-to-local import. The remaining UX gap for enterprise-scale use was navigation when many targets exist.

## Decisions
- Added filter/search state inside `/ssh-manage`.
- Applied filtering across local and global target lists shown by the manager.
- Kept the search lightweight and TUI-native using existing dialog/input flows instead of a custom full-screen component.
- Updated docs to frame filtering as part of the enterprise workflow for larger target inventories.
- Proceeded with a patch release after validation.

## Commands run
- `npm test`
- `npm run check:bundle`
- `npm run validate`
- `git diff --check`
- `npm version 0.1.6 --no-git-tag-version`
- `git commit -m "feat: add ssh target manager filtering"`
- `git push`
- `git tag -a v0.1.6 -m "v0.1.6"`
- `git push origin v0.1.6`

## Files changed
- `ssh.ts`
- `README.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `examples/README.md`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-target-manager-filter-release.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- Filtering is intentionally simple substring matching over visible target fields; it does not provide fuzzy search or advanced query syntax.
- The manager still uses sequential TUI dialogs rather than a custom component with live incremental search.

## Next
- Consider fuzzy matching and keyboard-first quick-open if target catalogs become very large.
- Consider surfacing the same filter/search affordance in `/ssh-connect` directly.
