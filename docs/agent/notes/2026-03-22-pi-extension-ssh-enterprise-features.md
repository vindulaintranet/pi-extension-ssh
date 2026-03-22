# pi-extension-ssh enterprise feature implementation

## Goal
Move `pi-extension-ssh` beyond the phase-1 public scaffold and implement the agreed phase-2 enterprise features in the same package.

## Context
The initial scaffold already covered:
- `ssh.ts`
- `ssh-core.ts`
- tests
- CI
- docs
- remote session mode
- `/ssh-run`
- local audit logging

The next agreed step was to also implement:
- allowlist
- host profiles
- remote `grep/find/ls`
- environment guardrails
- structured logs
- confirmation for prod

## Decisions
- Kept the package as a single public package and added the enterprise-oriented controls directly in the first release candidate.
- Added config-driven target profiles via:
  - project: `.pi/ssh/config.json`
  - global: `~/.pi/agent/ssh/config.json`
- Added allowlist enforcement for SSH targets.
- Added environment policies with defaults for `prod`.
- Added structured JSONL logs with fields such as profile, environment, source, mode, and decision.
- Added `/ssh-targets` to inspect configured target profiles.
- Implemented remote overrides for `grep`, `find`, and `ls`.
- Kept the implementation config-driven instead of introducing a full connection manager UI in this iteration.

## Commands run
- `npm install`
- `npm test`
- `npm run validate`
- `npm pack --dry-run`

## Files changed
- `ssh-core.ts`
- `ssh.ts`
- `test/ssh-core.test.ts`
- `README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `RELEASING.md`
- `docs/agent/notes/2026-03-22-pi-extension-ssh-enterprise-features.md`

## Tests
- Added coverage for:
  - config normalization
  - config loading and merging
  - target resolution by profile and alias
  - allowlist behavior
  - environment policy blocking
  - mutating command detection
  - local→remote path mapping
  - parsing/logging/truncation helpers
- `npm run validate`: required before publication

## Risks
- Remote `find` currently depends on `fd` being present on the remote host.
- Remote `grep` currently depends on `rg` being present on the remote host.
- Confirmation flows are strongest in interactive mode; in non-interactive mode, protected flows may be blocked instead of confirmed.

## Next
- Publish the package repository to GitHub.
- Tag the first release after the final validation run.
