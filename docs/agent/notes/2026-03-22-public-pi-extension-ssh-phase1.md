# Public pi-extension-ssh phase 1 scaffold

## Goal
Prepare a phase-1 public-ready package scaffold for the SSH extension, aligned with the agreed positioning:
- public useful package first
- enterprise guardrails and governance later

## Context
The original implementation lives in `vindulautils/projects/pi-extensions/ssh.ts`. The current phase focuses on extracting the SSH value proposition clearly:
- remote session mode
- `/ssh-run`
- local SSH audit log

## Decisions
- Created a dedicated local package scaffold at `~/projetos/pi-extension-ssh`.
- Split helper logic into `ssh-core.ts` for testability.
- Added unit tests for parsing, logging, command building, and truncation.
- Documented phase-1 scope and phase-2 enterprise roadmap in the README.
- Kept the phase-1 package intentionally narrow: no allowlist, no profiles, no remote `grep/find/ls` yet.

## Commands run
- `npm install`
- `npm test`
- `npm run validate`
- `npm pack --dry-run`
- `git init -b main`

## Files changed
- `package.json`
- `ssh.ts`
- `ssh-core.ts`
- `test/ssh-core.test.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `.gitignore`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `CONTRIBUTING.md`
- `RELEASING.md`
- `docs/agent/notes/2026-03-22-public-pi-extension-ssh-phase1.md`

## Tests
- parsing helpers
- command building helper
- truncation helper
- logging helper
- bundle check via `esbuild`
- package check via `npm pack --dry-run`

## Risks
- This scaffold is local only for now; no GitHub repository was created in this step.
- Remote tool behavior is not fully integration-tested against a live SSH host in this phase.

## Next
- Decide repository name and visibility
- Publish phase-1 package repo
- Only after that, layer enterprise features in phase 2
