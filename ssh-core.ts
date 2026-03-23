import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * pi-extension-ssh core helpers
 * Created by Fabio Rizzo Matos
 * GitHub: https://github.com/fabiorizzomatos
 * Contact: fabiorizzo@vindula.com.br
 */

export interface SshLogEntry {
  timestamp: string;
  remote: string;
  command: string;
  type: string;
  cwd?: string;
  mode?: "session" | "command" | "bash" | "user_bash" | "policy";
  environment?: string;
  profile?: string;
  source?: "profile" | "raw";
  decision?: "allowed" | "blocked" | "confirmed" | "denied" | "executed";
  reason?: string;
}

export interface SshLogWindow {
  remote: string;
  startedAt: string;
  endedAt?: string;
  profile?: string;
}

export interface SshLogSummary {
  startedAt?: string;
  endedAt?: string;
  durationSeconds: number | null;
  totalEntries: number;
  decisions: Record<string, number>;
  operationTypes: Record<string, number>;
  remotes: string[];
  environments: string[];
  profiles: string[];
  recentEntries: Array<Pick<SshLogEntry, "timestamp" | "type" | "decision" | "command" | "reason">>;
}

export interface ParsedSshTarget {
  remote: string;
  remoteCwd?: string;
  command: string;
}

export interface SshTargetProfile {
  remote: string;
  cwd?: string;
  environment?: string;
  requiresConfirmation?: boolean;
  aliases?: string[];
}

export interface SshEnvironmentPolicy {
  requiresConfirmation?: boolean;
  confirmWriteOperations?: boolean;
  confirmMutatingCommands?: boolean;
  blockedCommands?: string[];
}

export interface SshConfig {
  allowlist: string[];
  targets: Record<string, SshTargetProfile>;
  environmentPolicies: Record<string, SshEnvironmentPolicy>;
}

export interface ResolvedSshTarget {
  reference: string;
  remote: string;
  remoteCwd?: string;
  environment: string;
  requiresConfirmation: boolean;
  profile?: string;
  source: "profile" | "raw";
}

export interface SshConfigTemplateInput {
  targetName: string;
  remote: string;
  cwd?: string;
  environment: "default" | "dev" | "staging" | "prod";
  aliases?: string[];
}

export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;
export const SSH_PROMPT_HINT =
  'SSH remote execution is available. Prefer SSH session mode for repeatable remote work instead of ad-hoc shell hopping.';

const DEFAULT_PROD_BLOCKED_COMMANDS = [
  "rm -rf",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "mkfs",
  "git push --force",
  "git push -f",
  "git reset --hard",
  "systemctl stop",
  "systemctl disable",
  "service stop",
];

const SSH_OPTIONS_WITH_VALUE = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJsonFileIfExists(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function inferEnvironment(value: string | undefined): string {
  const normalized = String(value || "").toLowerCase();
  if (/(^|[^a-z])(prod|production)([^a-z]|$)/.test(normalized)) return "prod";
  if (/(^|[^a-z])(stag|staging|stage)([^a-z]|$)/.test(normalized)) return "staging";
  if (/(^|[^a-z])(dev|development)([^a-z]|$)/.test(normalized)) return "dev";
  return "default";
}

function mergePolicies(
  base: Record<string, SshEnvironmentPolicy>,
  extra?: Record<string, SshEnvironmentPolicy>,
): Record<string, SshEnvironmentPolicy> {
  if (!extra) return { ...base };
  const merged: Record<string, SshEnvironmentPolicy> = { ...base };
  for (const [environment, policy] of Object.entries(extra)) {
    const current = merged[environment] ?? {};
    merged[environment] = {
      ...current,
      ...policy,
      blockedCommands: policy.blockedCommands ?? current.blockedCommands ?? [],
    };
  }
  return merged;
}

export function normalizeSshConfig(raw: unknown): SshConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const targetsRecord = {
    ...((record.targets && typeof record.targets === "object") ? (record.targets as Record<string, unknown>) : {}),
    ...((record.profiles && typeof record.profiles === "object") ? (record.profiles as Record<string, unknown>) : {}),
  };

  const targets: Record<string, SshTargetProfile> = {};
  for (const [key, value] of Object.entries(targetsRecord)) {
    if (!value || typeof value !== "object") continue;
    const profile = value as Record<string, unknown>;
    const remote = typeof profile.remote === "string" ? profile.remote.trim() : "";
    if (!remote) continue;
    targets[key] = {
      remote,
      cwd: typeof profile.cwd === "string" && profile.cwd.trim() ? profile.cwd.trim() : undefined,
      environment:
        typeof profile.environment === "string" && profile.environment.trim()
          ? profile.environment.trim()
          : inferEnvironment(key),
      requiresConfirmation:
        typeof profile.requiresConfirmation === "boolean" ? profile.requiresConfirmation : undefined,
      aliases: Array.isArray(profile.aliases)
        ? profile.aliases.map((alias) => String(alias).trim()).filter(Boolean)
        : undefined,
    };
  }

  const defaultPolicies: Record<string, SshEnvironmentPolicy> = {
    default: {},
    prod: {
      requiresConfirmation: true,
      confirmWriteOperations: true,
      confirmMutatingCommands: true,
      blockedCommands: [...DEFAULT_PROD_BLOCKED_COMMANDS],
    },
    staging: {},
    dev: {},
  };

  const environmentPolicies = mergePolicies(
    defaultPolicies,
    record.environmentPolicies && typeof record.environmentPolicies === "object"
      ? (record.environmentPolicies as Record<string, SshEnvironmentPolicy>)
      : undefined,
  );

  const allowlist = Array.isArray(record.allowlist)
    ? record.allowlist.map((entry) => String(entry).trim()).filter(Boolean)
    : [];

  return {
    allowlist,
    targets,
    environmentPolicies,
  };
}

function mergeConfigs(base: SshConfig, override: SshConfig): SshConfig {
  return {
    allowlist: override.allowlist.length > 0 ? [...override.allowlist] : [...base.allowlist],
    targets: {
      ...base.targets,
      ...override.targets,
    },
    environmentPolicies: mergePolicies(base.environmentPolicies, override.environmentPolicies),
  };
}

export function loadSshConfig(cwd: string): SshConfig {
  const globalConfigPath = path.join(getAgentDir(), "ssh", "config.json");
  const projectConfigPath = path.join(cwd, ".pi", "ssh", "config.json");

  const globalConfig = normalizeSshConfig(readJsonFileIfExists(globalConfigPath));
  const projectConfig = normalizeSshConfig(readJsonFileIfExists(projectConfigPath));

  return mergeConfigs(globalConfig, projectConfig);
}

export function ensureLogPath(cwd: string, currentLogPath?: string | null): string {
  if (currentLogPath) return currentLogPath;
  const dir = path.join(cwd, ".pi", "ssh");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "ssh.log");
}

export function logSshCall(entry: Omit<SshLogEntry, "timestamp">, logFilePath: string): void {
  const payload: SshLogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  try {
    fs.appendFileSync(logFilePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // ignore logging errors
  }
}

export function truncateOutput(output: string): string {
  const lines = output.split(/\r?\n/);
  const totalBytes = Buffer.byteLength(output);
  let bytes = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const nextBytes = Buffer.byteLength(`${line}\n`);
    if (kept.length >= OUTPUT_MAX_LINES || bytes + nextBytes > OUTPUT_MAX_BYTES) {
      break;
    }
    kept.push(line);
    bytes += nextBytes;
  }

  const truncated = kept.length < lines.length || bytes < totalBytes;
  if (!truncated) {
    return kept.join("\n");
  }

  return `${kept.join("\n")}\n\n[Output truncated: ${kept.length}/${lines.length} lines, ${bytes}/${totalBytes} bytes]`;
}

export function parseSshTarget(args: string): ParsedSshTarget | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return null;

  const target = match[1];
  const command = match[2].trim();
  if (!command) return null;

  const { remote, remoteCwd } = splitTargetReference(target);
  return { remote, remoteCwd, command };
}

function splitTargetReference(reference: string): { remote: string; remoteCwd?: string } {
  const trimmed = reference.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0) {
    return { remote: trimmed };
  }

  const remote = trimmed.slice(0, separatorIndex);
  const remoteCwd = trimmed.slice(separatorIndex + 1);
  if (!remoteCwd) {
    return { remote: trimmed };
  }

  return { remote, remoteCwd };
}

export function resolveSshTarget(reference: string, config: SshConfig): ResolvedSshTarget | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  const directProfile = config.targets[trimmed];
  if (directProfile) {
    const environment = directProfile.environment || inferEnvironment(trimmed);
    return {
      reference: trimmed,
      remote: directProfile.remote,
      remoteCwd: directProfile.cwd,
      environment,
      requiresConfirmation:
        directProfile.requiresConfirmation ?? config.environmentPolicies[environment]?.requiresConfirmation ?? false,
      profile: trimmed,
      source: "profile",
    };
  }

  for (const [key, profile] of Object.entries(config.targets)) {
    if (profile.aliases?.includes(trimmed)) {
      const environment = profile.environment || inferEnvironment(key);
      return {
        reference: trimmed,
        remote: profile.remote,
        remoteCwd: profile.cwd,
        environment,
        requiresConfirmation:
          profile.requiresConfirmation ?? config.environmentPolicies[environment]?.requiresConfirmation ?? false,
        profile: key,
        source: "profile",
      };
    }
  }

  const { remote, remoteCwd } = splitTargetReference(trimmed);
  const environment = inferEnvironment(trimmed) || inferEnvironment(remote);
  return {
    reference: trimmed,
    remote,
    remoteCwd,
    environment,
    requiresConfirmation: config.environmentPolicies[environment]?.requiresConfirmation ?? false,
    source: "raw",
  };
}

export function listConfiguredTargets(config: SshConfig): Array<{ name: string; remote: string; cwd?: string; environment: string }> {
  return Object.entries(config.targets)
    .map(([name, profile]) => ({
      name,
      remote: profile.remote,
      cwd: profile.cwd,
      environment: profile.environment || inferEnvironment(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isSshTargetAllowed(target: ResolvedSshTarget, config: SshConfig): boolean {
  if (config.allowlist.length === 0) return true;
  const candidates = new Set<string>([
    target.reference,
    target.remote,
    target.remoteCwd ? `${target.remote}:${target.remoteCwd}` : target.remote,
    ...(target.profile ? [target.profile] : []),
  ]);
  return config.allowlist.some((allowed) => candidates.has(allowed));
}

export function getEnvironmentPolicy(environment: string, config: SshConfig): SshEnvironmentPolicy {
  return config.environmentPolicies[environment] ?? config.environmentPolicies.default ?? {};
}

export function getBlockedCommandReason(command: string, policy: SshEnvironmentPolicy): string | null {
  const blockedCommands = policy.blockedCommands ?? [];
  const normalized = command.toLowerCase();
  const matched = blockedCommands.find((blocked) => normalized.includes(blocked.toLowerCase()));
  if (!matched) return null;
  return `Blocked by SSH environment policy: ${matched}`;
}

export function isPotentiallyMutatingCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  if (!normalized.trim()) return false;

  const readOnlyPrefixes = [
    "pwd",
    "ls",
    "cat ",
    "cat$",
    "head",
    "tail",
    "grep",
    "rg",
    "find",
    "fd",
    "ps",
    "whoami",
    "uname",
    "env",
    "printenv",
    "git status",
    "git log",
    "git diff",
    "git show",
    "docker ps",
    "docker logs",
    "docker inspect",
    "kubectl get",
    "kubectl describe",
    "kubectl logs",
  ];

  if (
    readOnlyPrefixes.some((prefix) =>
      prefix.endsWith("$") ? new RegExp(prefix.slice(0, -1)).test(normalized.trim()) : normalized.trim().startsWith(prefix),
    )
  ) {
    return false;
  }

  const mutatingHints = [
    " >",
    ">>",
    " tee ",
    " rm ",
    "mv ",
    " cp ",
    "mkdir ",
    "chmod ",
    "chown ",
    "touch ",
    "sed -i",
    "perl -i",
    "git commit",
    "git push",
    "git reset",
    "git checkout",
    "git merge",
    "git rebase",
    "systemctl ",
    "service ",
    "docker compose up",
    "docker compose down",
    "docker restart",
    "kubectl apply",
    "kubectl delete",
    "kubectl patch",
    "kubectl exec",
  ];

  return mutatingHints.some((hint) => normalized.includes(hint));
}

export function mapLocalPathToRemote(inputPath: string, localCwd: string, remoteCwd: string): string {
  const absoluteLocalPath = path.resolve(localCwd, inputPath);
  const relativePath = path.relative(localCwd, absoluteLocalPath);
  if (!relativePath || relativePath === ".") {
    return remoteCwd;
  }
  return path.posix.join(remoteCwd, relativePath.split(path.sep).join(path.posix.sep));
}

export function parseSshInvocation(command: string): { remote: string; command: string } | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith("ssh ")) return null;

  const tokens = trimmed.split(/\s+/);
  let skipNext = false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (SSH_OPTIONS_WITH_VALUE.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return { remote: token, command: trimmed };
  }

  return null;
}

export function buildRemoteCommand(remoteCwd: string | undefined, command: string): string {
  if (!remoteCwd) return command;
  return `cd ${JSON.stringify(remoteCwd)} && ${command}`;
}

export function createStarterSshConfig(input: SshConfigTemplateInput): string {
  const aliases = (input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
  const config: Record<string, unknown> = {
    allowlist: [input.targetName],
    targets: {
      [input.targetName]: {
        remote: input.remote,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        environment: input.environment,
        ...(input.environment === "prod" ? { requiresConfirmation: true } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
      },
    },
  };

  if (input.environment === "prod") {
    config.environmentPolicies = {
      prod: {
        requiresConfirmation: true,
        confirmWriteOperations: true,
        confirmMutatingCommands: true,
        blockedCommands: [...DEFAULT_PROD_BLOCKED_COMMANDS],
      },
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

export function readSshLogEntries(logFilePath: string): SshLogEntry[] {
  try {
    if (!fs.existsSync(logFilePath)) return [];
    return fs
      .readFileSync(logFilePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SshLogEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function filterSshLogEntries(entries: SshLogEntry[], window: SshLogWindow): SshLogEntry[] {
  const start = Date.parse(window.startedAt);
  const end = window.endedAt ? Date.parse(window.endedAt) + 1000 : Number.POSITIVE_INFINITY;

  return entries.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) return false;
    if (entry.remote !== window.remote) return false;
    if (window.profile && entry.profile && entry.profile !== window.profile) return false;
    return true;
  });
}

export function summarizeSshLogEntries(entries: SshLogEntry[]): SshLogSummary {
  const decisions: Record<string, number> = {};
  const operationTypes: Record<string, number> = {};
  const remotes = new Set<string>();
  const environments = new Set<string>();
  const profiles = new Set<string>();

  for (const entry of entries) {
    if (entry.decision) decisions[entry.decision] = (decisions[entry.decision] ?? 0) + 1;
    operationTypes[entry.type] = (operationTypes[entry.type] ?? 0) + 1;
    if (entry.remote) remotes.add(entry.remote);
    if (entry.environment) environments.add(entry.environment);
    if (entry.profile) profiles.add(entry.profile);
  }

  const startedAt = entries[0]?.timestamp;
  const endedAt = entries[entries.length - 1]?.timestamp;
  const durationSeconds = startedAt && endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) : null;

  return {
    startedAt,
    endedAt,
    durationSeconds,
    totalEntries: entries.length,
    decisions,
    operationTypes,
    remotes: [...remotes],
    environments: [...environments],
    profiles: [...profiles],
    recentEntries: entries.slice(-20).map((entry) => ({
      timestamp: entry.timestamp,
      type: entry.type,
      decision: entry.decision,
      command: entry.command,
      reason: entry.reason,
    })),
  };
}

export function formatSshLogSummary(summary: SshLogSummary, format: "text" | "markdown" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const decisionLines = Object.entries(summary.decisions)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([decision, count]) => `${decision}: ${count}`);
  const typeLines = Object.entries(summary.operationTypes)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}: ${count}`);
  const recentLines = summary.recentEntries.map((entry) => {
    const reason = entry.reason ? ` (${entry.reason})` : "";
    return `${entry.timestamp} · ${entry.type} · ${entry.decision || "n/a"} · ${entry.command}${reason}`;
  });

  if (format === "markdown") {
    return [
      "# SSH Session Summary",
      "",
      `- Started: ${summary.startedAt || "(unknown)"}`,
      `- Ended: ${summary.endedAt || "(unknown)"}`,
      `- Duration: ${summary.durationSeconds === null ? "(unknown)" : `${summary.durationSeconds}s`}`,
      `- Entries: ${summary.totalEntries}`,
      `- Remotes: ${summary.remotes.join(", ") || "(none)"}`,
      `- Environments: ${summary.environments.join(", ") || "(none)"}`,
      `- Profiles: ${summary.profiles.join(", ") || "(none)"}`,
      "",
      "## Decisions",
      ...(decisionLines.length > 0 ? decisionLines.map((line) => `- ${line}`) : ["- (none)"]),
      "",
      "## Operation types",
      ...(typeLines.length > 0 ? typeLines.map((line) => `- ${line}`) : ["- (none)"]),
      "",
      "## Recent entries",
      ...(recentLines.length > 0 ? recentLines.map((line) => `- ${line}`) : ["- (none)"]),
    ].join("\n");
  }

  return [
    "SSH Session Summary",
    `Started: ${summary.startedAt || "(unknown)"}`,
    `Ended: ${summary.endedAt || "(unknown)"}`,
    `Duration: ${summary.durationSeconds === null ? "(unknown)" : `${summary.durationSeconds}s`}`,
    `Entries: ${summary.totalEntries}`,
    `Remotes: ${summary.remotes.join(", ") || "(none)"}`,
    `Environments: ${summary.environments.join(", ") || "(none)"}`,
    `Profiles: ${summary.profiles.join(", ") || "(none)"}`,
    "",
    "Decisions:",
    ...(decisionLines.length > 0 ? decisionLines.map((line) => `- ${line}`) : ["- (none)"]),
    "",
    "Operation types:",
    ...(typeLines.length > 0 ? typeLines.map((line) => `- ${line}`) : ["- (none)"]),
    "",
    "Recent entries:",
    ...(recentLines.length > 0 ? recentLines.map((line) => `- ${line}`) : ["- (none)"]),
  ].join("\n");
}
