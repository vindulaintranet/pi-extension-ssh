# Changelog

## Unreleased

- Adds `/ssh-manage` for TUI-based add/edit/remove/review/connect workflows on project-local SSH targets
- Keeps `.pi/ssh/config.json` as the source of truth while reducing manual JSON editing for day-to-day target management

## 0.1.4

- Adds `/ssh-configure` to create `.pi/ssh/config.json` through a TUI wizard
- Makes `/ssh-connect` and `/ssh-targets` offer guided config creation when no targets exist
- Adds starter config generation helper coverage in tests
- Refreshes README for TUI-first SSH setup

## 0.1.3

- Adds packaged `examples/` config templates for dev/staging/prod, bastion, and customer-environment setups
- Adds `/ssh-summary --raw` for raw filtered JSONL export
- Adds `/ssh-summary --include-entries` for fuller text/markdown reports
- Refreshes README to distinguish inline docs from copy-paste-ready example configs

## 0.1.2

- Adds automatic SSH preflight checks on connect and `--ssh` session start
- Adds `/ssh-summary` with text, markdown, and JSON output modes
- Adds summary export to local files via `--output`
- Shows an SSH session summary automatically on disconnect
- Extends the active SSH widget with preflight status
- Adds log summary helper coverage in tests
- Refreshes README for preflight and session-summary workflows

## 0.1.1

- Adds `/ssh-connect` for interactive target selection
- Adds `/ssh-disconnect`
- Adds `/ssh-health`
- Adds `/ssh-context`
- Adds stronger environment-aware active target UI status/widget
- Tightens confirmation-required policy behavior in non-interactive flows
- Refreshes README with launch-ready UX and command documentation

## 0.1.0

- Initial public-ready SSH package release
- Adds remote session mode via `--ssh`
- Adds `/ssh-run` for ad-hoc commands
- Adds local structured SSH audit log in `.pi/ssh/ssh.log`
- Adds host profiles and allowlist support via SSH config files
- Adds environment-based guardrails and confirmation for protected targets such as `prod`
- Adds remote `grep`, `find`, and `ls`
- Adds tests for parsing, config loading, allowlist behavior, policies, logging helpers, command building, and output truncation
- Adds CI validation and release docs
