# Example SSH configs

These are copy-paste-ready starting points for common `pi-extension-ssh` setups.

## Why examples/ exists if README already has a config?

The README includes a compact inline example to explain the feature set.

The files in `examples/` are different:
- each one is tailored to a real usage pattern
- they are easier to copy into `.pi/ssh/config.json`
- they show naming conventions, aliases, allowlists, and guardrails for specific scenarios

## Available templates

### SSH target configs
- `dev-staging-prod.config.json` — classic internal app environments
- `bastion-jumpbox.config.json` — bastion/jump-host oriented setup
- `customer-environments.config.json` — multiple customer/region targets
- `global-shared-platform.config.json` — global/shared platform-owned targets
- `project-local-overrides.config.json` — project-local overrides layered on top of shared/global targets

### SSH runbooks
- `runbooks/prod-health-check.md` — human-friendly Markdown+frontmatter production health verification flow
- `runbooks/staging-deploy-smoke.md` — human-friendly Markdown+frontmatter staging smoke-check flow
- `runbooks/prod-health-check.json` — structured JSON version of the production health flow
- `runbooks/staging-deploy-smoke.json` — structured JSON version of the staging smoke flow

## Enterprise pattern

A common setup is:
- store shared, centrally managed targets in `~/.pi/agent/ssh/config.json`
- store project-specific targets and overrides in `.pi/ssh/config.json`
- use `/ssh-manage` to view both layers, filter/search large target sets, and import global targets into the project when needed
- use `/ssh-runbooks` and `/ssh-runbook` for human-readable operational checklists with optional parameters such as `service`, `container`, and `path`, plus generic `--param key=value` overrides
- use `/ssh-runbook-report` when you want only the runbook execution artifact, separate from the broader session summary

## How to use

1. Pick the closest file.
2. Copy it to the right place:
   - project-local: `.pi/ssh/config.json`
   - global/shared: `~/.pi/agent/ssh/config.json`
3. Replace hostnames, usernames, paths, blocked commands, and runbook steps for your environment.
4. Run:

```bash
pi -e ./ssh.ts --ssh <target>
```

Or inside Pi:

```text
/ssh-connect
```
