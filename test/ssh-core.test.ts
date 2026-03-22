import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRemoteCommand,
  ensureLogPath,
  getBlockedCommandReason,
  getEnvironmentPolicy,
  isPotentiallyMutatingCommand,
  isSshTargetAllowed,
  listConfiguredTargets,
  loadSshConfig,
  logSshCall,
  mapLocalPathToRemote,
  normalizeSshConfig,
  parseSshInvocation,
  parseSshTarget,
  resolveSshTarget,
  truncateOutput,
} from "../ssh-core.ts";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-extension-ssh-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("parseSshTarget parses user@host:/path plus command", () => {
  const parsed = parseSshTarget("user@host:/srv/app ls -la");
  assert.deepEqual(parsed, {
    remote: "user@host",
    remoteCwd: "/srv/app",
    command: "ls -la",
  });
});

test("parseSshTarget parses user@host without remote path", () => {
  const parsed = parseSshTarget("user@host docker ps");
  assert.deepEqual(parsed, {
    remote: "user@host",
    remoteCwd: undefined,
    command: "docker ps",
  });
});

test("parseSshInvocation extracts remote from ssh command with alias", () => {
  const parsed = parseSshInvocation("ssh -i ~/.ssh/id_ed25519 prod-app \"docker ps\"");
  assert.deepEqual(parsed, {
    remote: "prod-app",
    command: "ssh -i ~/.ssh/id_ed25519 prod-app \"docker ps\"",
  });
});

test("buildRemoteCommand adds cd when remote cwd exists", () => {
  assert.equal(buildRemoteCommand("/srv/app", "ls -la"), 'cd "/srv/app" && ls -la');
  assert.equal(buildRemoteCommand(undefined, "ls -la"), "ls -la");
});

test("truncateOutput marks large output as truncated", () => {
  const output = Array.from({ length: 2500 }, (_, index) => `line ${index}`).join("\n");
  const truncated = truncateOutput(output);
  assert.match(truncated, /Output truncated:/);
  assert.match(truncated, /line 0/);
});

test("ensureLogPath and logSshCall create a structured audit file", async () => {
  await withTempDir(async (dir) => {
    const logPath = ensureLogPath(dir, null);
    logSshCall(
      {
        remote: "user@host",
        command: "docker ps",
        type: "ssh-run",
        cwd: dir,
        mode: "command",
        environment: "prod",
        profile: "prod-app",
        decision: "executed",
      },
      logPath,
    );

    const content = await fs.readFile(logPath, "utf8");
    assert.match(content, /user@host/);
    assert.match(content, /docker ps/);
    assert.match(content, /ssh-run/);
    assert.match(content, /prod-app/);
    assert.match(content, /"decision":"executed"/);
  });
});

test("normalize config supports targets, aliases, allowlist and environment policies", () => {
  const config = normalizeSshConfig({
    allowlist: ["prod-app", "ops@staging"],
    targets: {
      "prod-app": {
        remote: "ops@prod-host",
        cwd: "/srv/app",
        environment: "prod",
        aliases: ["production"],
      },
    },
    environmentPolicies: {
      prod: {
        blockedCommands: ["terraform destroy"],
      },
    },
  });

  assert.deepEqual(config.allowlist, ["prod-app", "ops@staging"]);
  assert.equal(config.targets["prod-app"]?.remote, "ops@prod-host");
  assert.deepEqual(config.targets["prod-app"]?.aliases, ["production"]);
  assert.deepEqual(config.environmentPolicies.prod?.blockedCommands, ["terraform destroy"]);
});

test("loadSshConfig merges global and project config", async () => {
  await withTempDir(async (dir) => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(dir, "agent-home");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await fs.mkdir(path.join(agentDir, "ssh"), { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "ssh", "config.json"),
      JSON.stringify({
        allowlist: ["staging-app"],
        targets: {
          "staging-app": { remote: "ops@staging", cwd: "/srv/staging", environment: "staging" },
        },
      }),
      "utf8",
    );

    await fs.mkdir(path.join(dir, ".pi", "ssh"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".pi", "ssh", "config.json"),
      JSON.stringify({
        targets: {
          "prod-app": { remote: "ops@prod", cwd: "/srv/prod", environment: "prod" },
        },
        environmentPolicies: {
          prod: { blockedCommands: ["rm -rf"] },
        },
      }),
      "utf8",
    );

    try {
      const config = loadSshConfig(dir);
      assert.equal(config.targets["staging-app"]?.remote, "ops@staging");
      assert.equal(config.targets["prod-app"]?.remote, "ops@prod");
      assert.equal(config.allowlist[0], "staging-app");
      assert.deepEqual(config.environmentPolicies.prod?.blockedCommands, ["rm -rf"]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

test("resolveSshTarget supports profiles and aliases", () => {
  const config = normalizeSshConfig({
    targets: {
      "prod-app": {
        remote: "ops@prod-host",
        cwd: "/srv/app",
        environment: "prod",
        aliases: ["production"],
      },
    },
  });

  const byName = resolveSshTarget("prod-app", config);
  assert.equal(byName?.remote, "ops@prod-host");
  assert.equal(byName?.profile, "prod-app");

  const byAlias = resolveSshTarget("production", config);
  assert.equal(byAlias?.remote, "ops@prod-host");
  assert.equal(byAlias?.profile, "prod-app");

  const raw = resolveSshTarget("ops@host:/srv/app", config);
  assert.equal(raw?.remote, "ops@host");
  assert.equal(raw?.remoteCwd, "/srv/app");
  assert.equal(raw?.source, "raw");
});

test("allowlist blocks unknown raw targets and allows profiles", () => {
  const config = normalizeSshConfig({
    allowlist: ["prod-app"],
    targets: {
      "prod-app": { remote: "ops@prod-host", cwd: "/srv/app", environment: "prod" },
    },
  });

  const allowed = resolveSshTarget("prod-app", config);
  const blocked = resolveSshTarget("ops@other-host", config);
  assert.equal(isSshTargetAllowed(allowed!, config), true);
  assert.equal(isSshTargetAllowed(blocked!, config), false);
});

test("environment policies block dangerous prod commands and detect mutating commands", () => {
  const config = normalizeSshConfig({
    environmentPolicies: {
      prod: {
        blockedCommands: ["rm -rf", "terraform destroy"],
        confirmMutatingCommands: true,
      },
    },
  });

  const policy = getEnvironmentPolicy("prod", config);
  assert.equal(getBlockedCommandReason("rm -rf /tmp/foo", policy), "Blocked by SSH environment policy: rm -rf");
  assert.equal(getBlockedCommandReason("ls -la", policy), null);
  assert.equal(isPotentiallyMutatingCommand("git push origin main"), true);
  assert.equal(isPotentiallyMutatingCommand("kubectl get pods"), false);
});

test("mapLocalPathToRemote maps local repo paths into remote cwd", () => {
  const remote = mapLocalPathToRemote("src/index.ts", "/Users/fabio/project", "/srv/app");
  assert.equal(remote, "/srv/app/src/index.ts");
});

test("listConfiguredTargets returns sorted targets", () => {
  const config = normalizeSshConfig({
    targets: {
      zebra: { remote: "z@host" },
      alpha: { remote: "a@host", environment: "staging" },
    },
  });

  const names = listConfiguredTargets(config).map((target) => target.name);
  assert.deepEqual(names, ["alpha", "zebra"]);
});
