---
name: staging-deploy-smoke
title: Staging deploy smoke test
description: Basic smoke checks for a staging deploy.
target: staging-app
tags:
  - staging
  - deploy
  - smoke
parameters:
  container:
    description: Docker container name
    default: app
  path:
    description: Application path on the remote host
    default: /srv/app
---

## Steps

### Show current directory
```sh
pwd
```

### Confirm deploy path
```sh
ls -la {{path}}
```

### Show git revision
```sh
git -C {{path}} rev-parse --short HEAD
```

### List containers
```sh
docker ps --filter name={{container}}
```

### Open recent logs
```sh
docker logs --tail 50 {{container}}
```
