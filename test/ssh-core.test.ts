import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRemoteCommand,
  createStarterSshConfig,
  ensureLogPath,
  filterSshLogEntries,
  formatSshLogSummary,
  getBlockedCommandReason,
  getEnvironmentPolicy,
  isPotentiallyMutatingCommand,
  isSshTargetAllowed,
  listConfiguredTargets,
  listSshRunbooks,
  loadSshConfig,
  logSshCall,
  mapLocalPathToRemote,
  normalizeSshConfig,
  normalizeSshRunbook,
  parseSshInvocation,
  parseSshTarget,
  readSshLogEntries,
  removeSshTargetFromRawConfig,
  resolveSshTarget,
  summarizeSshLogEntries,
  truncateOutput,
  upsertSshTargetInRawConfig,
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

test("createStarterSshConfig builds a prod-safe starter config", () => {
  const text = createStarterSshConfig({
    targetName: "prod-app",
    remote: "ops@prod-host",
    cwd: "/srv/app",
    environment: "prod",
    aliases: ["production", " live "],
  });
  const parsed = JSON.parse(text);

  assert.deepEqual(parsed.allowlist, ["prod-app"]);
  assert.equal(parsed.targets["prod-app"].remote, "ops@prod-host");
  assert.equal(parsed.targets["prod-app"].cwd, "/srv/app");
  assert.equal(parsed.targets["prod-app"].requiresConfirmation, true);
  assert.deepEqual(parsed.targets["prod-app"].aliases, ["production", "live"]);
  assert.equal(parsed.environmentPolicies.prod.confirmWriteOperations, true);
  assert.match(text, /"blockedCommands"/);
});

test("upsertSshTargetInRawConfig adds and renames targets while keeping allowlist in sync", () => {
  const initial = {
    allowlist: ["staging-app"],
    targets: {
      "staging-app": {
        remote: "ops@staging-host",
        cwd: "/srv/app",
        environment: "staging",
      },
    },
  };

  const renamed = upsertSshTargetInRawConfig(
    initial,
    {
      targetName: "prod-app",
      remote: "ops@prod-host",
      cwd: "/srv/app",
      environment: "prod",
      aliases: ["production"],
    },
    { previousName: "staging-app" },
  );

  assert.deepEqual(renamed.allowlist, ["prod-app"]);
  assert.equal((renamed.targets as Record<string, any>)["prod-app"].remote, "ops@prod-host");
  assert.equal((renamed.targets as Record<string, any>)["prod-app"].requiresConfirmation, true);
  assert.equal((renamed.targets as Record<string, any>)["staging-app"], undefined);
});

test("removeSshTargetFromRawConfig removes target and allowlist entry", () => {
  const initial = {
    allowlist: ["prod-app", "staging-app"],
    targets: {
      "prod-app": { remote: "ops@prod-host", environment: "prod" },
      "staging-app": { remote: "ops@staging-host", environment: "staging" },
    },
  };

  const updated = removeSshTargetFromRawConfig(initial, "prod-app");
  assert.deepEqual(updated.allowlist, ["staging-app"]);
  assert.equal((updated.targets as Record<string, any>)["prod-app"], undefined);
  assert.equal((updated.targets as Record<string, any>)["staging-app"].remote, "ops@staging-host");
});

test("normalizeSshRunbook supports string and object steps", () => {
  const runbook = normalizeSshRunbook(
    {
      title: "Production health",
      target: "prod-app",
      parameters: {
        container: {
          description: "Container name",
          default: "app",
        },
      },
      steps: [
        "pwd",
        { title: "List processes", command: "ps aux", confirm: false, expectedExitCodes: [0] },
      ],
    },
    "prod-health",
  );

  assert.equal(runbook?.name, "prod-health");
  assert.equal(runbook?.title, "Production health");
  assert.equal(runbook?.target, "prod-app");
  assert.equal(runbook?.parameters?.container?.default, "app");
  assert.equal(runbook?.steps[0]?.command, "pwd");
  assert.equal(runbook?.steps[1]?.title, "List processes");
});

test("listSshRunbooks merges global and project runbooks with project override", async () => {
  await withTempDir(async (dir) => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = path.join(dir, "agent-home");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await fs.mkdir(path.join(agentDir, "ssh", "runbooks"), { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "ssh", "runbooks", "shared-checks.md"),
      [
        "---",
        "title: Shared checks",
        "target: shared-support",
        "parameters:",
        "  service:",
        "    default: app",
        "---",
        "## Steps",
        "### Show current directory",
        "```sh",
        "pwd",
        "```",
      ].join("\n"),
      "utf8",
    );

    await fs.mkdir(path.join(dir, ".pi", "ssh", "runbooks"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".pi", "ssh", "runbooks", "shared-checks.json"),
      JSON.stringify({ title: "Project checks", steps: ["ls -la"] }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, ".pi", "ssh", "runbooks", "deploy-checks.md"),
      [
        "---",
        "title: Deploy checks",
        "target: staging-app",
        "parameters:",
        "  container:",
        "    default: app",
        "tags:",
        "  - staging",
        "  - smoke",
        "---",
        "## Steps",
        "### Show current directory",
        "```sh",
        "pwd",
        "```",
        "### Check container [confirm]",
        "```sh",
        "docker logs --tail 20 {{container}}",
        "```",
      ].join("\n"),
      "utf8",
    );

    try {
      const runbooks = listSshRunbooks(dir);
      assert.deepEqual(runbooks.map((runbook) => runbook.name), ["deploy-checks", "shared-checks"]);
      assert.equal(runbooks.find((runbook) => runbook.name === "shared-checks")?.title, "Project checks");
      assert.equal(runbooks.find((runbook) => runbook.name === "shared-checks")?.source, "project");
      assert.equal(runbooks.find((runbook) => runbook.name === "deploy-checks")?.target, "staging-app");
      assert.equal(runbooks.find((runbook) => runbook.name === "deploy-checks")?.parameters?.container?.default, "app");
      assert.equal(runbooks.find((runbook) => runbook.name === "deploy-checks")?.steps[1]?.confirm, true);
      assert.equal(runbooks.find((runbook) => runbook.name === "deploy-checks")?.steps[1]?.command, "docker logs --tail 20 {{container}}");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

test("read/filter/summarize SSH logs support session export flows", async () => {
  await withTempDir(async (dir) => {
    const logPath = ensureLogPath(dir, null);
    logSshCall(
      {
        remote: "ops@prod-host",
        command: "connect prod-app",
        type: "session-start",
        cwd: dir,
        mode: "session",
        environment: "prod",
        profile: "prod-app",
        decision: "executed",
      },
      logPath,
    );
    logSshCall(
      {
        remote: "ops@prod-host",
        command: "docker ps",
        type: "bash",
        cwd: dir,
        mode: "session",
        environment: "prod",
        profile: "prod-app",
        decision: "executed",
      },
      logPath,
    );
    logSshCall(
      {
        remote: "ops@prod-host",
        command: "rm -rf /tmp/foo",
        type: "policy",
        cwd: dir,
        mode: "policy",
        environment: "prod",
        profile: "prod-app",
        decision: "blocked",
        reason: "Blocked by SSH environment policy: rm -rf",
      },
      logPath,
    );

    const entries = readSshLogEntries(logPath);
    const filtered = filterSshLogEntries(entries, {
      remote: "ops@prod-host",
      profile: "prod-app",
      startedAt: entries[0]!.timestamp,
      endedAt: entries[entries.length - 1]!.timestamp,
    });
    const summary = summarizeSshLogEntries(filtered);
    const markdown = formatSshLogSummary(summary, "markdown");

    assert.equal(filtered.length, 3);
    assert.equal(summary.totalEntries, 3);
    assert.equal(summary.decisions.executed, 2);
    assert.equal(summary.decisions.blocked, 1);
    assert.equal(summary.operationTypes.policy, 1);
    assert.match(markdown, /SSH Session Summary/);
    assert.match(markdown, /blocked: 1/);
    assert.match(markdown, /rm -rf \/tmp\/foo/);
  });
});
