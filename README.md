# pi-extension-ssh

A public-ready [Pi](https://github.com/badlogic/pi-mono) package for remote operations over SSH.

Created by [Fabio Rizzo Matos](https://github.com/fabiorizzomatos) · contact: `fabiorizzo@vindula.com.br`

## Why install this instead of just using `bash` + `ssh`

This package is useful when you want SSH to be a **repeatable Pi capability**, not just an occasional shell trick.

Its practical differentiators are:
- remote **session mode** with `--ssh`
- local SSH **audit log** in `.pi/ssh/ssh.log`
- `/ssh-run` for ad-hoc remote commands
- remote routing for Pi core tools:
  - `read`
  - `write`
  - `edit`
  - `bash`

That means Pi can operate with the remote host as the working environment instead of mixing local file tools with one-off SSH shell commands.

## What this package does

### 1. Remote session mode

Examples:

```bash
pi -e ./ssh.ts --ssh user@host
pi -e ./ssh.ts --ssh user@host:/remote/path
```

When `--ssh` is active:
- Pi resolves a remote working directory
- `read/write/edit/bash` operate on the remote machine
- user `!commands` also execute remotely
- the session status bar shows the remote target
- the system prompt reflects the remote cwd

### 2. `/ssh-run`

Examples:

```text
/ssh-run user@host:/srv/app ls -la
/ssh-run user@host docker ps
```

Use this when you want one explicit remote command without switching the whole session.

### 3. Audit logging

SSH activity is logged locally to:

```text
.pi/ssh/ssh.log
```

This gives you a lightweight execution trail for:
- remote session operations
- `/ssh-run`
- direct `bash` calls that start with `ssh ...`
- user `!ssh ...` invocations

## Install

### From GitHub

```bash
pi install git:github.com/vindulaintranet/pi-extension-ssh
```

### From a local path

```bash
pi install /absolute/path/to/pi-extension-ssh
```

After installing, restart Pi or run:

```text
/reload
```

## Requirements

- SSH key-based authentication
- `bash` on the remote host
- remote utilities used by the extension:
  - `cat`
  - `test`
  - `mkdir`
  - `base64`
  - `file`

## Current limitations

This phase-1 package intentionally focuses on the essentials.

Today it does **not** provide remote routing for:
- `grep`
- `find`
- `ls`

It also does not yet include:
- host allowlists
- environment policies (`prod`, `staging`, etc.)
- saved host profiles
- structured enterprise log export
- production confirmation flows

Those are planned phase-2 enterprise upgrades.

## Validation

```bash
npm install
npm run validate
```

This runs:
- unit tests for SSH parsing/logging/truncation helpers
- bundle validation for the Pi extension entrypoint
- package validation with `npm pack --dry-run`

## Contributing and releasing

See:
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [RELEASING.md](./RELEASING.md)

## Roadmap

### Phase 1 — public useful package
- `ssh.ts`
- `ssh-core.ts`
- tests
- CI
- clear docs
- explicit value around session mode, logging, and `/ssh-run`

### Phase 2 — enterprise features
- allowlist
- host profiles
- remote `grep/find/ls`
- environment guardrails
- structured logs
- production confirmation flows

## License

MIT
