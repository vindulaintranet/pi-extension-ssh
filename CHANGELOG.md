# Changelog

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
