---
name: prod-health-check
title: Production health check
description: Verify basic production health indicators before or after an incident change.
target: prod-app
requiresConfirmation: true
tags:
  - prod
  - health
  - incident
parameters:
  container:
    description: Docker container name
    default: app
  service:
    description: Systemd service name
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

### Inspect application path
```sh
ls -la {{path}}
```

### Show running containers
```sh
docker ps --filter name={{container}}
```

### Check recent container logs
```sh
docker logs --tail 100 {{container}}
```

### Inspect service status [confirm]
```sh
systemctl status {{service}} --no-pager
```
