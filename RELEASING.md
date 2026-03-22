# Releasing

This repository supports:
- unpinned installs from the default branch
- pinned installs from tags such as `@v0.1.0`

## Release flow

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Run full validation:

```bash
npm install
npm run validate
```

4. Commit the release changes:

```bash
git add .
git commit -m "chore: release v0.1.0"
```

5. Create and push the tag:

```bash
git tag v0.1.0
git push origin main --tags
```

## Release automation

The GitHub release workflow should:
- install dependencies
- run `npm run validate`
- create the package tarball
- create a GitHub Release
- attach the `.tgz` artifact

## Recommended release notes focus

For this package, release notes should always call out changes in:
- remote tool routing (`read/write/edit/bash/grep/find/ls`)
- profiles / allowlist behavior
- environment policies and confirmations
- audit logging format
