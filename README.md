# pi-extension-ssh

A public-ready [Pi](https://github.com/badlogic/pi-mono) package for remote operations over SSH, with both a useful public baseline and enterprise-oriented controls.

Created by [Fabio Rizzo Matos](https://github.com/fabiorizzomatos) · contact: `fabiorizzo@vindula.com.br`

## Why install this instead of just using `bash` + `ssh`

This package is useful when you want SSH to become a **repeatable Pi capability**, not just an occasional shell trick.

It gives you:
- remote **session mode** with `--ssh`
- remote routing for Pi tools:
  - `read`
  - `write`
  - `edit`
  - `bash`
  - `grep`
  - `find`
  - `ls`
- `/ssh-run` for explicit ad-hoc remote commands
- local structured SSH **audit logging** in `.pi/ssh/ssh.log`
- host **profiles**
- **allowlist** support
- environment **guardrails**
- **confirmation for prod** and other protected targets

That means Pi can operate with the remote host as the working environment instead of mixing local file tools with one-off SSH shell commands.

## What this package does

### 1. Remote session mode

Examples:

```bash
pi -e ./ssh.ts --ssh user@host
pi -e ./ssh.ts --ssh user@host:/remote/path
pi -e ./ssh.ts --ssh prod-app
```

When `--ssh` is active:
- Pi resolves a remote working directory
- `read/write/edit/bash/grep/find/ls` operate on the remote machine
- user `!commands` also execute remotely
- the session status bar shows the remote target
- the system prompt reflects the remote cwd and environment

### 2. `/ssh-run`

Examples:

```text
/ssh-run user@host:/srv/app ls -la
/ssh-run prod-app docker ps
```

Use this when you want one explicit remote command without switching the whole session.

### 3. Audit logging

SSH activity is logged locally to:

```text
.pi/ssh/ssh.log
```

Each line is structured JSON and includes metadata such as:
- target remote
- profile
- environment
- mode
- decision (`executed`, `blocked`, `confirmed`, `denied`)

### 4. Host profiles and allowlist

The package supports project-local or global config files:

- project: `<project>/.pi/ssh/config.json`
- global: `~/.pi/agent/ssh/config.json`

Example:

```json
{
  "allowlist": ["prod-app", "staging-app"],
  "targets": {
    "prod-app": {
      "remote": "ops@prod-host",
      "cwd": "/srv/app",
      "environment": "prod",
      "requiresConfirmation": true,
      "aliases": ["production"]
    },
    "staging-app": {
      "remote": "ops@staging-host",
      "cwd": "/srv/app",
      "environment": "staging"
    }
  },
  "environmentPolicies": {
    "prod": {
      "requiresConfirmation": true,
      "confirmWriteOperations": true,
      "confirmMutatingCommands": true,
      "blockedCommands": [
        "rm -rf",
        "git reset --hard",
        "terraform destroy"
      ]
    }
  }
}
```

List configured targets with:

```text
/ssh-targets
```

## Enterprise-oriented features included

This package now includes the phase-2 capabilities agreed for the enterprise track:

- **allowlist**
- **host profiles**
- remote **`grep` / `find` / `ls`**
- **guardrails by environment**
- **structured logs**
- **confirmation for prod**

## Requirements

- SSH key-based authentication
- `bash` on the remote host
- remote utilities used by the extension:
  - `cat`
  - `test`
  - `mkdir`
  - `base64`
  - `file`
  - `rg` for remote `grep`
  - `fd` for remote `find`

## Current limitations

- `find` remote routing currently expects `fd` on the remote host
- `grep` remote routing currently expects `rg` on the remote host
- host profile switching is config-driven; this version does not yet add a full interactive connection manager
- logs are structured JSONL locally, but no external export sink is included yet

## Validation

```bash
npm install
npm run validate
```

This runs:
- unit tests for SSH parsing, config loading, allowlist/policy behavior, logging, command building, and truncation
- bundle validation for the Pi extension entrypoint
- package validation with `npm pack --dry-run`

## Contributing and releasing

See:
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [RELEASING.md](./RELEASING.md)

## License

MIT
