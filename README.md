# pi-extension-ssh

[![CI](https://github.com/vindulaintranet/pi-extension-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/vindulaintranet/pi-extension-ssh/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vindulaintranet/pi-extension-ssh)](https://github.com/vindulaintranet/pi-extension-ssh/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Remote operations for [Pi](https://github.com/badlogic/pi-mono) over SSH.

`pi-extension-ssh` turns SSH from an occasional shell escape into a repeatable Pi capability with:
- remote **session mode**
- remote tool routing
- local **audit logging**
- target **profiles**
- **allowlist** support
- environment **guardrails**
- **confirmation for prod** and other protected targets

Created by [Fabio Rizzo Matos](https://github.com/fabiorizzomatos) · contact: `fabiorizzo@vindula.com.br`

---

## Why this exists

You can already do this with plain shell commands:

```bash
ssh user@host "cd /srv/app && docker ps"
```

But that is not the same as giving Pi a real remote operating mode.

With this package installed, Pi can treat the remote host as the working environment itself.

That matters when you want:
- repeatable remote sessions instead of one-off SSH hops
- `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` operating remotely
- an audit trail in `.pi/ssh/ssh.log`
- stable target names like `prod-app`, `staging-app`, `bastion-eu`
- environment-aware controls for sensitive systems

In short:
- **plain SSH** = good for ad-hoc commands
- **pi-extension-ssh** = good for remote operations workflows

---

## What you get

### 1. Remote session mode

Run a whole Pi session against a remote host:

```bash
pi -e ./ssh.ts --ssh user@host
pi -e ./ssh.ts --ssh user@host:/remote/path
pi -e ./ssh.ts --ssh prod-app
```

When `--ssh` is active:
- Pi resolves a remote working directory
- `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` operate on the remote machine
- user `!commands` also execute remotely
- the status bar shows the active remote target
- connect runs an automatic preflight check and surfaces missing remote tools early
- the system prompt reflects the remote cwd and environment

### 2. `/ssh-run`

Run a one-off remote command without switching the whole session:

```text
/ssh-run user@host:/srv/app ls -la
/ssh-run prod-app docker ps
```

### 3. Automatic preflight + manual health checks

On `/ssh-connect` and `--ssh`, the extension runs a lightweight preflight check automatically.

That verifies:
- connectivity
- resolved remote `pwd`
- expected remote tools such as `bash`, `cat`, `mkdir`, `base64`, `file`, `rg`, and `fd`

You can also run the same verification on demand with:

```text
/ssh-health
/ssh-health prod-app
```

### 4. Audit logging

SSH activity is logged locally to:

```text
.pi/ssh/ssh.log
```

Each line is structured JSON and can include metadata such as:
- remote target
- profile
- environment
- mode
- decision (`executed`, `blocked`, `confirmed`, `denied`)
- reason

### 5. Profiles, allowlist, and guardrails

The package supports project-local and global SSH config files:
- project: `<project>/.pi/ssh/config.json`
- global: `~/.pi/agent/ssh/config.json`

This lets you:
- define friendly target names
- restrict where Pi is allowed to connect
- require confirmation for protected targets
- block dangerous commands in certain environments
- keep shared global targets read-only while still importing them into a project when local overrides are needed

### 6. TUI target management

The extension now includes a TUI-first target manager:
- create local config with `/ssh-configure`
- manage local targets with `/ssh-manage`
- view both project-local and global targets in one place
- import global targets into project-local config for safe per-project overrides

---

## Install

### From GitHub

```bash
pi install git:github.com/vindulaintranet/pi-extension-ssh
```

### Pin to a release tag

```bash
pi install git:github.com/vindulaintranet/pi-extension-ssh@v0.1.6
```

### From a local path

```bash
pi install /absolute/path/to/pi-extension-ssh
```

After installing, restart Pi or run:

```text
/reload
```

---

## Quick start

### Ad-hoc remote command

```text
/ssh-run user@host:/srv/app docker ps
```

### Full remote session

```bash
pi -e ./ssh.ts --ssh user@host:/srv/app
```

### Interactive profile connection

```text
/ssh-connect
```

If no targets exist yet, the extension can now open a TUI wizard and create `.pi/ssh/config.json` for you.

After that, use `/ssh-manage` to add, edit, remove, review, filter/search, import, or connect targets without manually opening the JSON first.

### SSH operations context

```text
/ssh-context
/ssh-health
/ssh-summary
/ssh-disconnect
```

### Profile-based session

Add a config file:

```json
{
  "allowlist": ["staging-app", "prod-app"],
  "targets": {
    "staging-app": {
      "remote": "ops@staging-host",
      "cwd": "/srv/app",
      "environment": "staging"
    },
    "prod-app": {
      "remote": "ops@prod-host",
      "cwd": "/srv/app",
      "environment": "prod",
      "requiresConfirmation": true,
      "aliases": ["production"]
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

Then run:

```bash
pi -e ./ssh.ts --ssh prod-app
```

List configured targets with:

```text
/ssh-targets
```

Create a project-local SSH config through the TUI:

```text
/ssh-configure
```

Manage project-local SSH targets through the TUI:

```text
/ssh-manage
```

The manager shows both:
- project-local targets you can edit here
- global targets that are read-only here, but importable into the project
- a filter/search flow so large target sets are easier to navigate

## Operational commands

- `/ssh-configure` — create `.pi/ssh/config.json` through a TUI wizard
- `/ssh-manage` — add, edit, remove, review, filter/search, connect, and import global targets into project-local config from the TUI
- `/ssh-connect` — choose a configured target interactively or pass one explicitly; offers config creation when none exist
- `/ssh-disconnect` — leave the active SSH session target
- `/ssh-context` — inspect the active target, policies, preflight status, and log path
- `/ssh-health [target]` — verify connectivity and required remote tools on demand
- `/ssh-summary [--format text|markdown|json|raw] [--output <path>] [--last] [--include-entries] [--raw]` — review or export the current/recent SSH session summary
- `/ssh-targets` — list project-local and global profiles with source markers
- `/ssh-run <target> <command>` — run one explicit remote command without switching the whole session

Example summary exports:

```text
/ssh-summary
/ssh-summary --format markdown --include-entries --output .pi/ssh/reports/latest.md
/ssh-summary --format json --output .pi/ssh/reports/latest.json --last
/ssh-summary --raw --output .pi/ssh/reports/latest.jsonl --last
```

---

## Commercial / real-world use cases

### Production app operations
Use profile-based access such as `prod-app` with confirmation and blocked commands for safer incident work.

### Staging debugging
Point Pi at `staging-app` and let it inspect logs, config, and code remotely with normal tools.

### Bastion-based admin work
Keep SSH targets named and documented instead of relying on remembered shell snippets.

### Managed customer environments
Use target profiles per customer/tenant/region and maintain a local audit trail of remote activity.

---

## Example config

This inline example is a compact illustration.

If you want copy-paste-ready templates for common setups, use the files in [`examples/`](./examples):
- [`examples/dev-staging-prod.config.json`](./examples/dev-staging-prod.config.json)
- [`examples/bastion-jumpbox.config.json`](./examples/bastion-jumpbox.config.json)
- [`examples/customer-environments.config.json`](./examples/customer-environments.config.json)
- [`examples/global-shared-platform.config.json`](./examples/global-shared-platform.config.json)
- [`examples/project-local-overrides.config.json`](./examples/project-local-overrides.config.json)

```json
{
  "allowlist": ["prod-app", "staging-app", "bastion-eu"],
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
    },
    "bastion-eu": {
      "remote": "admin@bastion-eu",
      "cwd": "/home/admin",
      "environment": "default"
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
        "terraform destroy",
        "shutdown",
        "reboot"
      ]
    }
  }
}
```

---

## Enterprise local/global pattern

A practical enterprise setup is:
- keep shared targets such as bastions, platform hosts, and approved base profiles in the global config
- keep project-specific names, cwd values, aliases, and overrides in the local project config
- use `/ssh-manage` to view both layers and import a global target into the project when you need a local override

That gives you:
- shared platform defaults
- safer per-project customization
- clearer ownership of what is centrally managed vs locally editable

---

## Enterprise-oriented features included

This package already includes the agreed enterprise track features:
- **allowlist**
- **host profiles**
- remote **`grep` / `find` / `ls`**
- **guardrails by environment**
- **structured logs**
- **confirmation for prod**

---

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

---

## Current limitations

- remote `find` currently expects `fd` on the remote host
- remote `grep` currently expects `rg` on the remote host
- target handling is config-driven; this version includes TUI setup and target management, but still keeps JSON as the source of truth
- the TUI manager edits only project-local config; global targets are visible and importable, but remain read-only there
- logs are structured JSONL locally, but no external export sink is included yet
- historical summaries are session-scoped; this version does not provide arbitrary cross-session analytics

---

## Validation

```bash
npm install
npm run validate
```

This runs:
- unit tests for SSH parsing, config loading, allowlist/policy behavior, logging, command building, and truncation
- bundle validation for the Pi extension entrypoint
- package validation with `npm pack --dry-run`

---

## Contributing and releasing

See:
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [RELEASING.md](./RELEASING.md)

---

## License

MIT
