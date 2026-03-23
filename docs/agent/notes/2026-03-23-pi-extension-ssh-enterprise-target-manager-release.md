# pi-extension-ssh enterprise target manager and release

## Goal
Make SSH target management more enterprise-friendly by exposing local/global target layers in the TUI manager, enabling global-to-local import, and preparing a public patch release.

## Context
`/ssh-manage` already handled local add/edit/remove flows, but enterprise UX still lacked two important capabilities: visibility into shared global targets and a safe way to import them into project-local config for overrides.

## Decisions
- Extended the TUI manager to show both project-local and global targets in one view.
- Marked global targets as read-only in the manager and local targets as editable.
- Marked shadowed global targets when a local target with the same name exists.
- Added import flow from global target to project-local target.
- Updated `/ssh-targets` and `/ssh-connect` to better reflect local/global target sources.
- Added enterprise-oriented examples for global shared targets and project-local overrides.
- Proceeded with a patch release after validation and user approval.

## Commands run
- `npm test`
- `npm run check:bundle`
- `npm run validate`
- `git diff --check`
- `npm version 0.1.5 --no-git-tag-version`
- `git commit -m "feat: add enterprise ssh target manager views"`
- `git push`
- `git tag -a v0.1.5 -m "v0.1.5"`
- `git push origin v0.1.5`

## Files changed
- `ssh.ts`
- `ssh-core.ts`
- `test/ssh-core.test.ts`
- `README.md`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `examples/README.md`
- `examples/global-shared-platform.config.json`
- `examples/project-local-overrides.config.json`
- `docs/agent/notes/2026-03-23-pi-extension-ssh-enterprise-target-manager-release.md`

## Tests
- `npm test`: OK
- `npm run check:bundle`: OK
- `npm run validate`: OK
- `git diff --check`: OK

## Risks
- The manager still edits only project-local config directly; global config remains intentionally read-only in the TUI flow.
- Global target import copies target details but does not attempt deep policy migration beyond the imported target profile data.

## Next
- Consider adding a dedicated badge or section for targets inherited only from global config in the active session widget.
- Consider adding “promote local target to shared/global” as a future admin-focused workflow.
