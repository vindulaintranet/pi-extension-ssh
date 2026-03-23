# Example SSH configs

These are copy-paste-ready starting points for common `pi-extension-ssh` setups.

## Why examples/ exists if README already has a config?

The README includes a compact inline example to explain the feature set.

The files in `examples/` are different:
- each one is tailored to a real usage pattern
- they are easier to copy into `.pi/ssh/config.json`
- they show naming conventions, aliases, allowlists, and guardrails for specific scenarios

## Available templates

- `dev-staging-prod.config.json` — classic internal app environments
- `bastion-jumpbox.config.json` — bastion/jump-host oriented setup
- `customer-environments.config.json` — multiple customer/region targets

## How to use

1. Pick the closest file.
2. Copy it to your project as `.pi/ssh/config.json`.
3. Replace hostnames, usernames, paths, and blocked commands for your environment.
4. Run:

```bash
pi -e ./ssh.ts --ssh <target>
```

Or inside Pi:

```text
/ssh-connect
```
