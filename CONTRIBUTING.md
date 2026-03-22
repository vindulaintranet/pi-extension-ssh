# Contributing

Thanks for contributing to `pi-extension-ssh`.

## Local setup

```bash
npm install
npm run validate
```

## Test commands

```bash
npm test
npm run check:bundle
npm run check:pack
npm run validate
```

## Making a change

1. Create a branch from `main`
2. Make the change
3. Update docs if behavior changed:
   - `README.md`
   - `CHANGELOG.md`
   - `RELEASING.md` if release flow changed
4. Run:
   ```bash
   npm run validate
   ```
5. Open a pull request

## PR expectations

A good PR should include:
- what changed
- why it changed
- how it was tested
- any impact on SSH behavior, logging, host policies, or remote safety

## Config-related changes

If your change affects profiles, allowlists, or environment policies, include at least one example config snippet in the PR description or README update.

## Update behavior for Pi users

### Unpinned git install

```bash
pi install git:github.com/vindulaintranet/pi-extension-ssh
```

Later:

```bash
pi update
```

Pi will pull the latest default-branch state.

### Pinned install

```bash
pi install git:github.com/vindulaintranet/pi-extension-ssh@v0.1.0
```

Pinned installs stay on that ref until the user upgrades intentionally.
