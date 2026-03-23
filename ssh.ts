import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import {
  SSH_PROMPT_HINT,
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
  parseSshInvocation,
  parseSshTarget,
  readSshLogEntries,
  removeSshTargetFromRawConfig,
  resolveSshTarget,
  summarizeSshLogEntries,
  truncateOutput,
  upsertSshTargetInRawConfig,
  type LoadedSshRunbook,
  type ResolvedSshTarget,
  type SshConfig,
  type SshConfigTemplateInput,
} from "./ssh-core";

/**
 * pi-extension-ssh
 * Created by Fabio Rizzo Matos
 * GitHub: https://github.com/fabiorizzomatos
 * Contact: fabiorizzo@vindula.com.br
 */

function quoteArg(value: string): string {
  return JSON.stringify(value);
}

function joinShellArgs(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

function getEnvironmentTone(environment: string): "error" | "warning" | "success" | "accent" {
  if (environment === "prod") return "error";
  if (environment === "staging") return "warning";
  if (environment === "dev") return "success";
  return "accent";
}

function formatEnvironmentBadge(environment: string): string {
  return environment ? environment.toUpperCase() : "DEFAULT";
}

function formatTargetLabel(target: ResolvedSshTarget): string {
  const base = target.profile ? `${target.profile} -> ${target.remote}` : target.remote;
  const cwd = target.remoteCwd ? `:${target.remoteCwd}` : "";
  const environment = target.environment && target.environment !== "default" ? ` [${target.environment}]` : "";
  return `${base}${cwd}${environment}`;
}

function formatTargetChoice(target: { name: string; remote: string; cwd?: string; environment: string }, active: boolean): string {
  const cwd = target.cwd ? `:${target.cwd}` : "";
  const env = target.environment && target.environment !== "default" ? ` [${target.environment}]` : "";
  const suffix = active ? " [ACTIVE]" : "";
  return `${target.name} -> ${target.remote}${cwd}${env}${suffix}`;
}

function formatManagedTargetChoice(target: ManagedTargetView, active: boolean): string {
  const base = formatTargetChoice(target, active);
  const origin = target.origin === "local" ? " [LOCAL]" : " [GLOBAL]";
  const shadowed = target.shadowed ? " [SHADOWED]" : "";
  return `${base}${origin}${shadowed}`;
}

function buildManagedTargets(config: SshConfig, origin: ManagerTargetOrigin, localNames = new Set<string>()): ManagedTargetView[] {
  return listConfiguredTargets(config).map((target) => ({
    ...target,
    aliases: config.targets[target.name]?.aliases,
    origin,
    shadowed: origin === "global" ? localNames.has(target.name) : false,
  }));
}

function renderTargetSection(title: string, targets: ManagedTargetView[], activeProfile?: string): string[] {
  return [
    `${title}:`,
    ...(targets.length > 0
      ? targets.map((target) => `- ${formatManagedTargetChoice(target, target.name === activeProfile)}`)
      : ["- (none)"]),
  ];
}

function filterManagedTargets(targets: ManagedTargetView[], query: string): ManagedTargetView[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return targets;
  return targets.filter((target) => {
    const haystack = [
      target.name,
      target.remote,
      target.cwd || "",
      target.environment,
      target.origin,
      ...(target.aliases ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function buildManagerOverview(
  projectConfigPath: string,
  globalConfigPath: string,
  localTargets: ManagedTargetView[],
  globalTargets: ManagedTargetView[],
  activeProfile?: string,
  globalParseError?: string,
  filterQuery?: string,
): string {
  const lines = [
    "SSH Target Manager",
    `Project config: ${projectConfigPath}`,
    `Global config: ${globalConfigPath}`,
    "",
    ...renderTargetSection("Project-local targets", localTargets, activeProfile),
    "",
    ...renderTargetSection("Global targets (read-only here)", globalTargets, activeProfile),
  ];

  if (filterQuery?.trim()) {
    lines.push("", `Filter: ${filterQuery.trim()}`);
  }

  if (globalParseError) {
    lines.push("", `Global config warning: ${globalParseError}`);
  }

  lines.push("", "Legend: [LOCAL] editable here · [GLOBAL] read-only here · [SHADOWED] local target overrides same global name");
  return lines.join("\n");
}

function buildTargetManagerActionList(localTargets: ManagedTargetView[], globalTargets: ManagedTargetView[], filterQuery: string): string[] {
  return [
    localTargets.length === 0 ? "Add first local target" : "Add local target",
    ...(localTargets.length > 0 ? ["Edit local target", "Remove local target"] : []),
    ...(globalTargets.length > 0 ? ["Import global target to local"] : []),
    ...(localTargets.length > 0 || globalTargets.some((target) => !target.shadowed) ? ["Connect to target"] : []),
    "Set filter",
    ...(filterQuery.trim() ? ["Clear filter"] : []),
    "Review local JSON",
    "Exit",
  ];
}

function buildImportTargetDefaults(
  target: ManagedTargetView,
  config: SshConfig,
  localNames: Set<string>,
): Partial<SshConfigTemplateInput> {
  const profile = config.targets[target.name];
  return {
    targetName: localNames.has(target.name) ? `${target.name}-local` : target.name,
    remote: target.remote,
    cwd: target.cwd,
    environment: target.environment as SshConfigTemplateInput["environment"],
    aliases: profile?.aliases,
    requiresConfirmation: profile?.requiresConfirmation ?? (target.environment === "prod"),
  };
}

function formatRunbookChoice(runbook: LoadedSshRunbook): string {
  const source = runbook.source === "project" ? "[LOCAL]" : "[GLOBAL]";
  const target = runbook.target ? ` -> ${runbook.target}` : "";
  return `${runbook.name}${target} ${source}`;
}

function filterRunbooks(runbooks: LoadedSshRunbook[], query: string): LoadedSshRunbook[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return runbooks;
  return runbooks.filter((runbook) => {
    const haystack = [
      runbook.name,
      runbook.title,
      runbook.description || "",
      runbook.target || "",
      runbook.source,
      runbook.path,
      ...(runbook.tags ?? []),
      ...Object.keys(runbook.parameters ?? {}),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function extractRunbookParameterNames(runbook: LoadedSshRunbook): string[] {
  const names = new Set<string>(Object.keys(runbook.parameters ?? {}));
  for (const step of runbook.steps) {
    for (const match of step.command.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g)) {
      names.add(match[1]);
    }
    if (step.title) {
      for (const match of step.title.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g)) {
        names.add(match[1]);
      }
    }
  }
  return [...names];
}

function renderTemplate(value: string, params: Record<string, string>): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, key: string) => params[key] ?? "");
}

function formatRunbookReport(report: SshRunbookExecutionReport): string {
  return [
    `Runbook: ${report.title}`,
    `Name: ${report.name}`,
    `Source: ${report.source}`,
    `Path: ${report.path}`,
    `Target: ${report.target}`,
    `Started: ${report.startedAt}`,
    `Ended: ${report.endedAt}`,
    `Parameters: ${Object.keys(report.parameters).length > 0 ? JSON.stringify(report.parameters) : "(none)"}`,
    "",
    "Steps:",
    ...report.steps.flatMap((step) => {
      const lines = [`- ${step.index}. ${step.status.toUpperCase()} · ${step.title}`, `  $ ${step.command}`];
      if (step.reason) lines.push(`  Reason: ${step.reason}`);
      if (step.output) lines.push(...step.output.split(/\r?\n/).map((line) => `  ${line}`));
      return lines;
    }),
  ].join("\n");
}

function formatRunbookReportsBlock(reports: SshRunbookExecutionReport[] | undefined, format: Exclude<SshSummaryFormat, "raw">): string {
  if (!reports || reports.length === 0) return "";
  if (format === "json") {
    return JSON.stringify(reports, null, 2);
  }
  if (format === "markdown") {
    return [
      "## Runbook reports",
      ...reports.flatMap((report) => [
        `### ${report.name}`,
        `- Target: ${report.target}`,
        `- Started: ${report.startedAt}`,
        `- Ended: ${report.endedAt}`,
        `- Parameters: ${Object.keys(report.parameters).length > 0 ? JSON.stringify(report.parameters) : "(none)"}`,
        ...report.steps.map((step) => `- ${step.index}. ${step.status.toUpperCase()} · ${step.title} — \`${step.command}\`${step.reason ? ` (${step.reason})` : ""}`),
        "",
      ]),
    ].join("\n");
  }
  return [
    "Runbook reports:",
    ...reports.flatMap((report) => [
      `- ${report.name} · ${report.target} · ${report.startedAt} -> ${report.endedAt}`,
      `  Parameters: ${Object.keys(report.parameters).length > 0 ? JSON.stringify(report.parameters) : "(none)"}`,
      ...report.steps.map((step) => `  - ${step.index}. ${step.status.toUpperCase()} · ${step.title} · ${step.command}${step.reason ? ` (${step.reason})` : ""}`),
    ]),
  ].join("\n");
}

function renderRunbookPreview(runbook: LoadedSshRunbook, target: ResolvedSshTarget, params: Record<string, string>): string {
  const steps = runbook.steps.map((step, index) => {
    const confirm = step.confirm ? " [confirm]" : "";
    const title = renderTemplate(step.title || step.command, params);
    const command = renderTemplate(step.command, params);
    return `${index + 1}. ${title}${confirm}\n   $ ${command}`;
  });
  return [
    `Runbook: ${runbook.title}`,
    `Name: ${runbook.name}`,
    `Source: ${runbook.source}`,
    `File: ${runbook.path}`,
    `Target: ${formatTargetLabel(target)}`,
    ...(runbook.description ? [`Description: ${runbook.description}`] : []),
    ...(runbook.tags?.length ? [`Tags: ${runbook.tags.join(", ")}`] : []),
    `Parameters: ${Object.keys(params).length > 0 ? JSON.stringify(params) : "(none)"}`,
    `Requires runbook confirmation: ${runbook.requiresConfirmation ? "yes" : "no"}`,
    "",
    "Steps:",
    ...steps,
  ].join("\n");
}

function getRunbookDirs(cwd: string): { project: string; global: string } {
  const globalDir = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "ssh", "runbooks");
  return {
    project: path.join(cwd, ".pi", "ssh", "runbooks"),
    global: globalDir,
  };
}

function buildRunbookListing(runbooks: LoadedSshRunbook[], cwd: string): string {
  const dirs = getRunbookDirs(cwd);
  const lines = [
    "SSH Runbooks",
    `Project dir: ${dirs.project}`,
    `Global dir: ${dirs.global}`,
    "",
  ];

  if (runbooks.length === 0) {
    lines.push("- No runbooks configured");
  } else {
    for (const runbook of runbooks) {
      const tags = runbook.tags?.length ? ` tags=${runbook.tags.join(",")}` : "";
      const params = runbook.parameters ? ` params=${Object.keys(runbook.parameters).join(",")}` : "";
      lines.push(`- ${runbook.name} ${runbook.source === "project" ? "[LOCAL]" : "[GLOBAL]"}${runbook.target ? ` target=${runbook.target}` : ""}${tags}${params}`);
      if (runbook.description) lines.push(`  ${runbook.description}`);
    }
  }

  lines.push("", "Tip: store JSON or Markdown+frontmatter runbooks in .pi/ssh/runbooks/ or ~/.pi/agent/ssh/runbooks/");
  return lines.join("\n");
}

function buildPolicyLog(
  target: ResolvedSshTarget,
  command: string,
  decision: "allowed" | "blocked" | "confirmed" | "denied",
  reason: string | undefined,
  cwd: string,
  logPath: string,
): void {
  logSshCall(
    {
      remote: target.remote,
      command,
      type: "policy",
      cwd,
      mode: "policy",
      environment: target.environment,
      profile: target.profile,
      source: target.source,
      decision,
      reason,
    },
    logPath,
  );
}

type SshHealthReport = {
  checkedAt: string;
  pwd: string;
  checks: Array<{ name: string; status: string }>;
  missingTools: string[];
  status: "ok" | "warning";
};

type SshRunbookStepReport = {
  index: number;
  title: string;
  command: string;
  status: "ok" | "failed" | "blocked" | "cancelled";
  output?: string;
  reason?: string;
};

type SshRunbookExecutionReport = {
  name: string;
  title: string;
  source: "project" | "global";
  path: string;
  target: string;
  startedAt: string;
  endedAt: string;
  parameters: Record<string, string>;
  steps: SshRunbookStepReport[];
};

type SshSessionState = {
  target: ResolvedSshTarget;
  startedAt: string;
  endedAt?: string;
  disconnectReason?: string;
  lastPreflight?: SshHealthReport;
  runbookReports?: SshRunbookExecutionReport[];
};

type SshSummaryFormat = "text" | "markdown" | "json" | "raw";
type ManagerTargetOrigin = "local" | "global";

type ManagedTargetView = {
  name: string;
  remote: string;
  cwd?: string;
  environment: string;
  origin: ManagerTargetOrigin;
  aliases?: string[];
  shadowed?: boolean;
};

function formatPreflightState(report: SshHealthReport | undefined): string {
  if (!report) return "Preflight: pending";
  if (report.missingTools.length === 0) return `Preflight: OK (${report.checkedAt})`;
  return `Preflight warnings: missing ${report.missingTools.join(", ")}`;
}

function formatHealthReport(target: ResolvedSshTarget, report: SshHealthReport, title = "SSH Health"): string {
  return [
    `${title}`,
    `Target: ${formatTargetLabel(target)}`,
    `Connection: OK`,
    `pwd: ${report.pwd}`,
    `Checked at: ${report.checkedAt}`,
    report.missingTools.length === 0 ? "Missing tools: none" : `Missing tools: ${report.missingTools.join(", ")}`,
    "",
    "Checks:",
    ...report.checks.map((check) => `- ${check.name}: ${check.status}`),
  ].join("\n");
}

function formatDuration(startedAt: string, endedAt?: string): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "(unknown)";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return `${seconds}s`;
}

function getProjectSshConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "ssh", "config.json");
}

function getGlobalSshConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "ssh", "config.json");
}

function readConfigRaw(configPath: string): { raw: Record<string, unknown>; sourceText?: string; parseError?: string } {
  if (!fs.existsSync(configPath)) {
    return { raw: {} };
  }

  const sourceText = fs.readFileSync(configPath, "utf8");
  try {
    const parsed = JSON.parse(sourceText) as unknown;
    return {
      raw: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      sourceText,
    };
  } catch (error) {
    return {
      raw: {},
      sourceText,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function readProjectSshConfigRaw(cwd: string): { raw: Record<string, unknown>; sourceText?: string; parseError?: string } {
  return readConfigRaw(getProjectSshConfigPath(cwd));
}

function readGlobalSshConfigRaw(): { raw: Record<string, unknown>; sourceText?: string; parseError?: string } {
  return readConfigRaw(getGlobalSshConfigPath());
}

function writeProjectSshConfigRaw(cwd: string, raw: Record<string, unknown>): string {
  const configPath = getProjectSshConfigPath(cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return configPath;
}

function clearTargetUi(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("ssh", undefined);
  ctx.ui.setWidget("ssh-active", undefined);
}

function updateTargetUi(ctx: ExtensionContext, target: ResolvedSshTarget | null, logPath: string | null, session?: SshSessionState | null): void {
  if (!ctx.hasUI) return;
  if (!target) {
    clearTargetUi(ctx);
    return;
  }

  const tone = getEnvironmentTone(target.environment);
  const envBadge = formatEnvironmentBadge(target.environment);
  const label = formatTargetLabel(target);
  ctx.ui.setStatus("ssh", ctx.ui.theme.fg(tone, `SSH ${envBadge}: ${label}`));
  const relativeLogPath = logPath ? path.relative(ctx.cwd, logPath) || logPath : ".pi/ssh/ssh.log";
  ctx.ui.setWidget(
    "ssh-active",
    [
      `SSH ${envBadge} · ${label}`,
      formatPreflightState(session?.lastPreflight),
      `Commands: /ssh-context · /ssh-health · /ssh-summary · /ssh-disconnect`,
      `Log: ${relativeLogPath}`,
    ],
    { placement: "belowEditor" },
  );
}

async function sshExec(
  target: ResolvedSshTarget,
  command: string,
  type: string,
  cwd: string | undefined,
  logPath: string | null,
  mode: "session" | "command" | "bash" | "user_bash",
  allowedExitCodes: number[] = [],
): Promise<Buffer> {
  if (logPath) {
    logSshCall(
      {
        remote: target.remote,
        command,
        type,
        cwd,
        mode,
        environment: target.environment,
        profile: target.profile,
        source: target.source,
        decision: "executed",
      },
      logPath,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [target.remote, command], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => errChunks.push(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !allowedExitCodes.includes(code ?? -1)) {
        reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

async function remoteExists(target: ResolvedSshTarget, absoluteRemotePath: string, cwd: string, logPath: string | null): Promise<boolean> {
  const output = await sshExec(
    target,
    `if [ -e ${quoteArg(absoluteRemotePath)} ]; then printf '1'; else printf '0'; fi`,
    "exists",
    cwd,
    logPath,
    "session",
  );
  return output.toString().trim() === "1";
}

async function getRemotePwd(target: ResolvedSshTarget, cwd: string, logPath: string | null): Promise<string> {
  return (await sshExec(target, "pwd", "pwd", cwd, logPath, "session")).toString().trim();
}

async function collectHealthDetails(target: ResolvedSshTarget, cwd: string, logPath: string | null): Promise<string> {
  const probe = [
    "pwd",
    'for cmd in bash cat test mkdir base64 file rg fd; do',
    '  if command -v "$cmd" >/dev/null 2>&1; then printf "%s=ok\\n" "$cmd"; else printf "%s=missing\\n" "$cmd"; fi',
    "done",
  ].join("; ");
  return (await sshExec(target, probe, "health", cwd, logPath, "command")).toString().trim();
}

function parseHealthDetails(raw: string): { pwd: string; checks: Array<{ name: string; status: string }> } {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const pwd = lines[0] ?? "(unknown)";
  const checks = lines.slice(1).map((line) => {
    const [name, status] = line.split("=");
    return { name: name || "unknown", status: status || "unknown" };
  });
  return { pwd, checks };
}

async function runHealthCheck(target: ResolvedSshTarget, cwd: string, logPath: string | null): Promise<SshHealthReport> {
  const raw = await collectHealthDetails(target, cwd, logPath);
  const { pwd, checks } = parseHealthDetails(raw);
  const missingTools = checks.filter((check) => check.status !== "ok").map((check) => check.name);
  return {
    checkedAt: new Date().toISOString(),
    pwd,
    checks,
    missingTools,
    status: missingTools.length === 0 ? "ok" : "warning",
  };
}

function createRemoteReadOps(target: ResolvedSshTarget, localCwd: string, logPath: string | null): ReadOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, target.remoteCwd || ".");
  return {
    readFile: (p) => sshExec(target, `cat ${quoteArg(toRemote(p))}`, "read", localCwd, logPath, "session"),
    access: async (p) => {
      const exists = await remoteExists(target, toRemote(p), localCwd, logPath);
      if (!exists) throw new Error(`Path not found: ${p}`);
    },
    detectImageMimeType: async (p) => {
      try {
        const result = await sshExec(
          target,
          `file --mime-type -b ${quoteArg(toRemote(p))}`,
          "mime",
          localCwd,
          logPath,
          "session",
        );
        const mime = result.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(target: ResolvedSshTarget, localCwd: string, logPath: string | null): WriteOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, target.remoteCwd || ".");
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      await sshExec(
        target,
        `echo ${quoteArg(b64)} | base64 -d > ${quoteArg(toRemote(p))}`,
        "write",
        localCwd,
        logPath,
        "session",
      );
    },
    mkdir: (dir) =>
      sshExec(
        target,
        `mkdir -p ${quoteArg(toRemote(dir))}`,
        "mkdir",
        localCwd,
        logPath,
        "session",
      ).then(() => {}),
  };
}

function createRemoteEditOps(target: ResolvedSshTarget, localCwd: string, logPath: string | null): EditOperations {
  const readOps = createRemoteReadOps(target, localCwd, logPath);
  const writeOps = createRemoteWriteOps(target, localCwd, logPath);
  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
}

function createRemoteLsOps(target: ResolvedSshTarget, localCwd: string, logPath: string | null): LsOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, target.remoteCwd || ".");
  return {
    exists: (absolutePath) => remoteExists(target, toRemote(absolutePath), localCwd, logPath),
    stat: async (absolutePath) => {
      const remotePath = toRemote(absolutePath);
      const output = await sshExec(
        target,
        `if [ -d ${quoteArg(remotePath)} ]; then printf 'dir'; elif [ -e ${quoteArg(remotePath)} ]; then printf 'file'; else exit 1; fi`,
        "stat",
        localCwd,
        logPath,
        "session",
      );
      const kind = output.toString().trim();
      return {
        isDirectory: () => kind === "dir",
      };
    },
    readdir: async (absolutePath) => {
      const remotePath = toRemote(absolutePath);
      const output = await sshExec(
        target,
        `ls -1A ${quoteArg(remotePath)}`,
        "ls-read-dir",
        localCwd,
        logPath,
        "session",
      );
      return output
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    },
  };
}

function createRemoteFindOps(target: ResolvedSshTarget, localCwd: string, logPath: string | null): FindOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, target.remoteCwd || ".");
  return {
    exists: (absolutePath) => remoteExists(target, toRemote(absolutePath), localCwd, logPath),
    glob: async (pattern, searchCwd, options) => {
      const remoteSearchPath = toRemote(searchCwd);
      const command = [
        "bash",
        "-lc",
        [
          `cd ${quoteArg(remoteSearchPath)}`,
          "&&",
          "if command -v fd >/dev/null 2>&1; then",
          joinShellArgs(["fd", "--hidden", "--glob", "--max-results", String(options.limit), pattern, "."]),
          "; else",
          "echo 'fd is required on the remote host for the find tool' >&2; exit 127;",
          "fi",
        ].join(" "),
      ];
      const output = await sshExec(target, joinShellArgs(command), "find", localCwd, logPath, "session");
      return output
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^\.\//, ""));
    },
  };
}

function createRemoteBashOps(target: ResolvedSshTarget, remoteCwd: string, localCwd: string, logType: string, logPath: string | null): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const resolvedCwd = mapLocalPathToRemote(cwd, localCwd, remoteCwd);
        const remoteCommand = `cd ${quoteArg(resolvedCwd)} && ${command}`;
        if (logPath) {
          logSshCall(
            {
              remote: target.remote,
              command: remoteCommand,
              type: logType,
              cwd: resolvedCwd,
              mode: "session",
              environment: target.environment,
              profile: target.profile,
              source: target.source,
              decision: "executed",
            },
            logPath,
          );
        }

        const child = spawn("ssh", [target.remote, remoteCommand], { stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  };
}

async function executeRemoteGrep(
  target: ResolvedSshTarget,
  params: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
  },
  localCwd: string,
  logPath: string | null,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const searchPath = params.path ? mapLocalPathToRemote(params.path, localCwd, target.remoteCwd || ".") : target.remoteCwd || ".";
  const args = ["rg", "--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.context && params.context > 0) args.push("-C", String(params.context));
  if (params.limit && params.limit > 0) args.push("--max-count", String(params.limit));
  if (params.glob) args.push("--glob", params.glob);
  args.push(params.pattern, searchPath);

  const remoteCommand = [
    "bash",
    "-lc",
    [
      "if command -v rg >/dev/null 2>&1; then",
      `${joinShellArgs(args)}; code=$?; if [ $code -le 1 ]; then exit 0; else exit $code; fi;`,
      "else",
      "echo 'rg is required on the remote host for the grep tool' >&2; exit 127;",
      "fi",
    ].join(" "),
  ];

  const output = await sshExec(target, joinShellArgs(remoteCommand), "grep", localCwd, logPath, "session");
  const text = output.toString().trim();
  if (!text) {
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: { source: "remote-grep", target: target.remote },
    };
  }

  return {
    content: [{ type: "text", text: truncateOutput(text) }],
    details: {
      source: "remote-grep",
      target: target.remote,
      environment: target.environment,
      profile: target.profile,
    },
  };
}

export default function sshExtension(pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: target profile, user@host or user@host:/path", type: "string" });

  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localGrep = createGrepTool(localCwd);

  let activeTarget: ResolvedSshTarget | null = null;
  let activeSession: SshSessionState | null = null;
  let lastSession: SshSessionState | null = null;
  let logPath: string | null = null;
  let sshConfig: SshConfig = loadSshConfig(localCwd);

  const getLogPath = () => logPath;
  const getTarget = () => activeTarget;
  const getSession = () => activeSession;
  const getSummarySession = (): SshSessionState | null => activeSession ?? lastSession;
  const reloadConfig = (cwd: string) => {
    sshConfig = loadSshConfig(cwd);
    return sshConfig;
  };

  const ensureSshConfigViaTui = async (ctx: ExtensionContext): Promise<string | null> => {
    if (!ctx.hasUI) {
      console.log("No SSH targets configured. Create .pi/ssh/config.json first.");
      return null;
    }

    const createNow = await ctx.ui.confirm(
      "No SSH targets configured",
      "No SSH targets configured. Create .pi/ssh/config.json now using the TUI wizard?",
    );
    if (!createNow) return null;

    const targetName = (await ctx.ui.input("SSH target profile name", "prod-app"))?.trim();
    if (!targetName) return null;

    const remote = (await ctx.ui.input("SSH remote (user@host)", "ops@prod-host"))?.trim();
    if (!remote) return null;

    const remoteCwd = (await ctx.ui.input("Remote working directory", "/srv/app"))?.trim();
    const environment = await ctx.ui.select("SSH environment", ["default", "dev", "staging", "prod"]);
    if (!environment) return null;

    const aliasesInput = (await ctx.ui.input("Aliases (optional, comma-separated)", environment === "prod" ? "production, live" : ""))?.trim() || "";
    const aliases = aliasesInput
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const configPath = getProjectSshConfigPath(ctx.cwd);
    if (fs.existsSync(configPath)) {
      const overwrite = await ctx.ui.confirm(
        "Project SSH config already exists",
        `A project SSH config already exists at ${path.relative(ctx.cwd, configPath) || configPath}. Overwrite it with the reviewed wizard draft?`,
      );
      if (!overwrite) return null;
    }

    let draft = createStarterSshConfig({
      targetName,
      remote,
      cwd: remoteCwd || undefined,
      environment: environment as "default" | "dev" | "staging" | "prod",
      aliases,
    });

    while (true) {
      const edited = await ctx.ui.editor("Review SSH config", draft);
      if (edited === undefined) return null;
      try {
        JSON.parse(edited);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8");
        reloadConfig(ctx.cwd);
        ctx.ui.notify(`Created ${path.relative(ctx.cwd, configPath) || configPath}`, "info");
        return targetName;
      } catch (error) {
        draft = edited;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid JSON: ${message}`, "error");
      }
    }
  };

  const loadEditableProjectConfig = async (ctx: ExtensionContext): Promise<Record<string, unknown> | null> => {
    const loaded = readProjectSshConfigRaw(ctx.cwd);
    if (!loaded.parseError) {
      return loaded.raw;
    }

    if (!ctx.hasUI) {
      console.warn(`Project SSH config is invalid JSON: ${loaded.parseError}`);
      return null;
    }

    ctx.ui.notify(`Project SSH config is invalid JSON: ${loaded.parseError}`, "error");
    let draft = loaded.sourceText || "{}\n";
    while (true) {
      const edited = await ctx.ui.editor("Repair project SSH config", draft);
      if (edited === undefined) return null;
      try {
        const parsed = JSON.parse(edited) as unknown;
        const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        writeProjectSshConfigRaw(ctx.cwd, raw);
        reloadConfig(ctx.cwd);
        ctx.ui.notify(`Saved ${path.relative(ctx.cwd, getProjectSshConfigPath(ctx.cwd)) || getProjectSshConfigPath(ctx.cwd)}`, "info");
        return raw;
      } catch (error) {
        draft = edited;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid JSON: ${message}`, "error");
      }
    }
  };

  const collectTargetInputViaTui = async (
    ctx: ExtensionContext,
    title: string,
    initial?: Partial<SshConfigTemplateInput>,
  ): Promise<SshConfigTemplateInput | null> => {
    if (!ctx.hasUI) return null;

    const targetName = (await ctx.ui.input(`${title}: profile name`, initial?.targetName || "prod-app"))?.trim();
    if (!targetName) return null;

    const remote = (await ctx.ui.input(`${title}: remote (user@host)`, initial?.remote || "ops@prod-host"))?.trim();
    if (!remote) return null;

    const cwd = (await ctx.ui.input(`${title}: remote working directory`, initial?.cwd || "/srv/app"))?.trim() || "";
    const environments = ["default", "dev", "staging", "prod"] as const;
    const preferredEnvironment = initial?.environment || "default";
    const environment = await ctx.ui.select(
      `${title}: environment`,
      [preferredEnvironment, ...environments.filter((value) => value !== preferredEnvironment)],
    );
    if (!environment) return null;

    const aliasesInput = (await ctx.ui.input(
      `${title}: aliases (optional, comma-separated)`,
      initial?.aliases?.join(", ") || (environment === "prod" ? "production, live" : ""),
    ))?.trim() || "";
    const aliases = aliasesInput.split(",").map((value) => value.trim()).filter(Boolean);

    const defaultConfirmation = initial?.requiresConfirmation ?? (environment === "prod");
    const confirmationChoice = await ctx.ui.select(
      `${title}: require confirmation before connect?`,
      defaultConfirmation ? ["yes", "no"] : ["no", "yes"],
    );
    if (!confirmationChoice) return null;

    return {
      targetName,
      remote,
      cwd: cwd || undefined,
      environment: environment as SshConfigTemplateInput["environment"],
      aliases,
      requiresConfirmation: confirmationChoice === "yes",
    };
  };

  const saveProjectConfigAndReload = (ctx: ExtensionContext, raw: Record<string, unknown>, verb: string): string => {
    const configPath = writeProjectSshConfigRaw(ctx.cwd, raw);
    reloadConfig(ctx.cwd);
    if (ctx.hasUI) {
      ctx.ui.notify(`${verb} ${path.relative(ctx.cwd, configPath) || configPath}`, "info");
    }
    return configPath;
  };

  const openProjectConfigEditor = async (ctx: ExtensionContext, title = "Review project SSH config"): Promise<boolean> => {
    if (!ctx.hasUI) return false;
    const current = loadEditableProjectConfig(ctx);
    let raw = await current;
    if (!raw) return false;

    let draft = `${JSON.stringify(raw, null, 2)}\n`;
    while (true) {
      const edited = await ctx.ui.editor(title, draft);
      if (edited === undefined) return false;
      try {
        const parsed = JSON.parse(edited) as unknown;
        raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        saveProjectConfigAndReload(ctx, raw, "Saved");
        return true;
      } catch (error) {
        draft = edited;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid JSON: ${message}`, "error");
      }
    }
  };

  const manageSshTargetsViaTui = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      console.log("/ssh-manage requires interactive mode.");
      return;
    }

    let filterQuery = "";
    while (true) {
      const raw = await loadEditableProjectConfig(ctx);
      if (!raw) return;

      const globalLoaded = readGlobalSshConfigRaw();
      const localConfig = normalizeSshConfig(raw);
      const globalConfig = normalizeSshConfig(globalLoaded.raw);
      const localNames = new Set(Object.keys(localConfig.targets));
      const allLocalTargets = buildManagedTargets(localConfig, "local");
      const allGlobalTargets = buildManagedTargets(globalConfig, "global", localNames);
      const localTargets = filterManagedTargets(allLocalTargets, filterQuery);
      const globalTargets = filterManagedTargets(allGlobalTargets, filterQuery);
      const projectConfigPath = path.relative(ctx.cwd, getProjectSshConfigPath(ctx.cwd)) || getProjectSshConfigPath(ctx.cwd);
      const globalConfigPath = getGlobalSshConfigPath();
      const overview = buildManagerOverview(projectConfigPath, globalConfigPath, localTargets, globalTargets, getTarget()?.profile, globalLoaded.parseError, filterQuery);
      const actions = buildTargetManagerActionList(localTargets, globalTargets, filterQuery);

      const choice = await ctx.ui.select(overview, actions);
      if (!choice || choice === "Exit") return;

      if (choice === "Set filter") {
        const nextFilter = await ctx.ui.input("Filter SSH targets", filterQuery || "prod, bastion, customer-a...");
        if (nextFilter === undefined) continue;
        filterQuery = nextFilter.trim();
        continue;
      }

      if (choice === "Clear filter") {
        filterQuery = "";
        continue;
      }

      if (choice === "Add first local target" || choice === "Add local target") {
        const input = await collectTargetInputViaTui(ctx, "Add local SSH target");
        if (!input) continue;
        const nextRaw = upsertSshTargetInRawConfig(raw, input);
        saveProjectConfigAndReload(ctx, nextRaw, "Updated");
        continue;
      }

      if (choice === "Edit local target") {
        const selected = await ctx.ui.select("Select local target to edit", localTargets.map((target) => target.name));
        if (!selected) continue;
        const currentTargets = raw.targets && typeof raw.targets === "object" ? (raw.targets as Record<string, unknown>) : {};
        const currentTarget = currentTargets[selected] && typeof currentTargets[selected] === "object"
          ? (currentTargets[selected] as Record<string, unknown>)
          : {};
        const input = await collectTargetInputViaTui(ctx, "Edit local SSH target", {
          targetName: selected,
          remote: typeof currentTarget.remote === "string" ? currentTarget.remote : localConfig.targets[selected]?.remote,
          cwd: typeof currentTarget.cwd === "string" ? currentTarget.cwd : localConfig.targets[selected]?.cwd,
          environment: typeof currentTarget.environment === "string"
            ? (currentTarget.environment as SshConfigTemplateInput["environment"])
            : (localConfig.targets[selected]?.environment as SshConfigTemplateInput["environment"] | undefined),
          aliases: Array.isArray(currentTarget.aliases)
            ? currentTarget.aliases.map((value) => String(value))
            : localConfig.targets[selected]?.aliases,
          requiresConfirmation:
            typeof currentTarget.requiresConfirmation === "boolean"
              ? currentTarget.requiresConfirmation
              : localConfig.targets[selected]?.requiresConfirmation,
        });
        if (!input) continue;
        const nextRaw = upsertSshTargetInRawConfig(raw, input, { previousName: selected });
        saveProjectConfigAndReload(ctx, nextRaw, "Updated");
        if (getTarget()?.profile === selected && input.targetName !== selected) {
          ctx.ui.notify("The active SSH session still references the old target name until you reconnect.", "warning");
        }
        continue;
      }

      if (choice === "Remove local target") {
        const selected = await ctx.ui.select("Select local target to remove", localTargets.map((target) => target.name));
        if (!selected) continue;
        const confirmed = await ctx.ui.confirm("Remove local SSH target", `Remove project-local target ${selected}?`);
        if (!confirmed) continue;
        const nextRaw = removeSshTargetFromRawConfig(raw, selected);
        saveProjectConfigAndReload(ctx, nextRaw, "Updated");
        if (getTarget()?.profile === selected) {
          ctx.ui.notify("Removed target from config. The current SSH session remains active until you disconnect.", "warning");
        }
        continue;
      }

      if (choice === "Import global target to local") {
        const importableTargets = globalTargets;
        const selected = await ctx.ui.select("Select global target to import", importableTargets.map((target) => formatManagedTargetChoice(target, false)));
        if (!selected) continue;
        const selectedTarget = importableTargets[importableTargets.findIndex((target) => formatManagedTargetChoice(target, false) === selected)];
        if (!selectedTarget) continue;
        const defaults = buildImportTargetDefaults(selectedTarget, globalConfig, localNames);
        const input = await collectTargetInputViaTui(ctx, "Import global SSH target", defaults);
        if (!input) continue;
        const nextRaw = upsertSshTargetInRawConfig(raw, input);
        saveProjectConfigAndReload(ctx, nextRaw, "Imported into");
        continue;
      }

      if (choice === "Connect to target") {
        const connectableTargets = [
          ...localTargets,
          ...globalTargets.filter((target) => !target.shadowed),
        ];
        const selected = await ctx.ui.select("Connect to which target?", connectableTargets.map((target) => formatManagedTargetChoice(target, target.name === getTarget()?.profile)));
        if (!selected) continue;
        const selectedTarget = connectableTargets[connectableTargets.findIndex((target) => formatManagedTargetChoice(target, target.name === getTarget()?.profile) === selected)];
        if (!selectedTarget) continue;
        const target = resolveSshTarget(selectedTarget.name, sshConfig);
        if (!target) {
          ctx.ui.notify("Could not resolve SSH target.", "error");
          continue;
        }
        await activateTarget(ctx, target, `connect ${selectedTarget.name}`);
        return;
      }

      if (choice === "Review local JSON") {
        await openProjectConfigEditor(ctx);
      }
    }
  };

  const closeActiveSession = (ctx: ExtensionContext, disconnectReason: string): SshSessionState | null => {
    if (!activeSession) return null;
    const endedSession: SshSessionState = {
      ...activeSession,
      endedAt: new Date().toISOString(),
      disconnectReason,
    };
    lastSession = endedSession;
    activeSession = null;
    if (getLogPath()) {
      logSshCall(
        {
          remote: endedSession.target.remote,
          command: `disconnect ${disconnectReason}`,
          type: "session-end",
          cwd: ctx.cwd,
          mode: "session",
          environment: endedSession.target.environment,
          profile: endedSession.target.profile,
          source: endedSession.target.source,
          decision: "executed",
          reason: disconnectReason,
        },
        getLogPath()!,
      );
    }
    return endedSession;
  };

  const disconnectTarget = async (ctx: ExtensionContext, reason?: string): Promise<void> => {
    const endedSession = closeActiveSession(ctx, reason || "disconnect");
    activeTarget = null;
    clearTargetUi(ctx);

    if (ctx.hasUI && reason) {
      ctx.ui.notify(reason, "info");
    }

    if (endedSession) {
      const summary = buildSessionSummary(endedSession, getLogPath());
      if (summary && ctx.hasUI) {
        await ctx.ui.editor("SSH Session Summary", summary.display);
      } else if (summary) {
        console.log(summary.display);
      }
    }
  };

  const confirmTarget = async (
    ctx: ExtensionContext,
    target: ResolvedSshTarget,
    prompt: string,
    commandForLog: string,
  ): Promise<boolean> => {
    const currentLogPath = ensureLogPath(ctx.cwd, logPath);
    logPath = currentLogPath;
    if (!target.requiresConfirmation) {
      buildPolicyLog(target, commandForLog, "allowed", undefined, ctx.cwd, currentLogPath);
      return true;
    }
    if (!ctx.hasUI) {
      buildPolicyLog(target, commandForLog, "blocked", "Confirmation required but no interactive UI is available", ctx.cwd, currentLogPath);
      return false;
    }

    const confirmed = await ctx.ui.confirm("Confirm remote action", `${prompt}\n\nTarget: ${formatTargetLabel(target)}`);
    buildPolicyLog(target, commandForLog, confirmed ? "confirmed" : "denied", confirmed ? undefined : "User denied confirmation", ctx.cwd, currentLogPath);
    return confirmed;
  };

  const validateTarget = async (ctx: ExtensionContext, target: ResolvedSshTarget, commandForLog: string): Promise<boolean> => {
    const currentLogPath = ensureLogPath(ctx.cwd, logPath);
    logPath = currentLogPath;

    if (!isSshTargetAllowed(target, sshConfig)) {
      buildPolicyLog(target, commandForLog, "blocked", "Target not present in SSH allowlist", ctx.cwd, currentLogPath);
      ctx.hasUI ? ctx.ui.notify("SSH target blocked by allowlist.", "warning") : console.warn("SSH target blocked by allowlist.");
      return false;
    }

    if (target.requiresConfirmation && !(await confirmTarget(ctx, target, "This target requires confirmation.", commandForLog))) {
      ctx.hasUI ? ctx.ui.notify("SSH action cancelled.", "warning") : console.warn("SSH action cancelled.");
      return false;
    }

    return true;
  };

  const ensureTargetReady = async (ctx: ExtensionContext, target: ResolvedSshTarget, commandForLog: string): Promise<ResolvedSshTarget | null> => {
    if (!(await validateTarget(ctx, target, commandForLog))) {
      return null;
    }
    if (!target.remoteCwd) {
      try {
        target.remoteCwd = await getRemotePwd(target, ctx.cwd, getLogPath());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI ? ctx.ui.notify(`SSH target failed: ${message}`, "error") : console.error(message);
        return null;
      }
    }
    return target;
  };

  const runPreflight = async (ctx: ExtensionContext, session: SshSessionState): Promise<SshHealthReport | null> => {
    try {
      const report = await runHealthCheck(session.target, ctx.cwd, getLogPath());
      session.lastPreflight = report;
      if (getLogPath()) {
        logSshCall(
          {
            remote: session.target.remote,
            command: `preflight ${report.status}`,
            type: "preflight",
            cwd: ctx.cwd,
            mode: "command",
            environment: session.target.environment,
            profile: session.target.profile,
            source: session.target.source,
            decision: "executed",
            reason: report.missingTools.length === 0 ? "All required remote tools available" : `Missing tools: ${report.missingTools.join(", ")}`,
          },
          getLogPath()!,
        );
      }
      updateTargetUi(ctx, session.target, getLogPath(), session);
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (getLogPath()) {
        logSshCall(
          {
            remote: session.target.remote,
            command: "preflight failed",
            type: "preflight",
            cwd: ctx.cwd,
            mode: "command",
            environment: session.target.environment,
            profile: session.target.profile,
            source: session.target.source,
            decision: "blocked",
            reason: message,
          },
          getLogPath()!,
        );
      }
      updateTargetUi(ctx, session.target, getLogPath(), session);
      ctx.hasUI ? ctx.ui.notify(`SSH preflight failed: ${message}`, "warning") : console.warn(`SSH preflight failed: ${message}`);
      return null;
    }
  };

  const buildSessionSummary = (
    session: SshSessionState,
    activeLogPath: string | null,
    format: SshSummaryFormat = "text",
    includeEntries = false,
  ) => {
    if (!activeLogPath) return null;
    const entries = filterSshLogEntries(readSshLogEntries(activeLogPath), {
      remote: session.target.remote,
      profile: session.target.profile,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    });
    const summary = summarizeSshLogEntries(entries);
    const runbookReports = session.runbookReports ?? [];
    const headerLines = [
      `Target: ${formatTargetLabel(session.target)}`,
      `Started: ${session.startedAt}`,
      `Ended: ${session.endedAt || "(active)"}`,
      `Duration: ${formatDuration(session.startedAt, session.endedAt)}`,
      `Disconnect reason: ${session.disconnectReason || (session.endedAt ? "disconnect" : "(active)")}`,
      `Preflight: ${session.lastPreflight ? (session.lastPreflight.missingTools.length === 0 ? "ok" : `warnings (${session.lastPreflight.missingTools.join(", ")})`) : "not run"}`,
      `Runbooks executed: ${runbookReports.length}`,
    ];

    const detailedEntriesText = entries.length === 0
      ? "(no entries)"
      : entries
          .map((entry) => {
            const reason = entry.reason ? ` (${entry.reason})` : "";
            return `${entry.timestamp} · ${entry.type} · ${entry.decision || "n/a"} · ${entry.command}${reason}`;
          })
          .join("\n");

    let payload: string;
    if (format === "raw") {
      payload = entries.length === 0 ? "" : entries.map((entry) => JSON.stringify(entry)).join("\n");
    } else if (format === "json") {
      payload = JSON.stringify({ session, summary, entries, runbookReports }, null, 2);
    } else if (format === "markdown") {
      const rendered = formatSshLogSummary(summary, "markdown");
      const header = ["# SSH Session Report", "", ...headerLines.map((line) => `- ${line}`), ""].join("\n");
      const details = includeEntries
        ? `\n\n## Filtered entries\n${entries.length === 0 ? "\n- (no entries)" : `\n${entries.map((entry) => `- ${entry.timestamp} · ${entry.type} · ${entry.decision || "n/a"} · ${entry.command}${entry.reason ? ` (${entry.reason})` : ""}`).join("\n")}`}`
        : "";
      const runbooksBlock = runbookReports.length > 0 ? `\n\n${formatRunbookReportsBlock(runbookReports, "markdown")}` : "";
      payload = `${header}${rendered}${details}${runbooksBlock}`;
    } else {
      const rendered = formatSshLogSummary(summary, "text");
      const header = `${headerLines.join("\n")}\n\n`;
      const details = includeEntries ? `\n\nFiltered entries:\n${detailedEntriesText}` : "";
      const runbooksBlock = runbookReports.length > 0 ? `\n\n${formatRunbookReportsBlock(runbookReports, "text")}` : "";
      payload = `${header}${rendered}${details}${runbooksBlock}`;
    }

    return { display: payload, entries, summary, runbookReports };
  };

  const exportSessionSummary = (ctx: ExtensionContext, content: string, outputPath: string) => {
    const absolutePath = path.isAbsolute(outputPath) ? outputPath : path.join(ctx.cwd, outputPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
    return absolutePath;
  };

  const activateTarget = async (ctx: ExtensionContext, target: ResolvedSshTarget, commandForLog: string): Promise<boolean> => {
    const readyTarget = await ensureTargetReady(ctx, target, commandForLog);
    if (!readyTarget) return false;

    if (activeSession) {
      closeActiveSession(ctx, "replaced by new target");
    }

    activeTarget = readyTarget;
    activeSession = {
      target: { ...readyTarget },
      startedAt: new Date().toISOString(),
    };

    if (getLogPath()) {
      logSshCall(
        {
          remote: readyTarget.remote,
          command: commandForLog,
          type: "session-start",
          cwd: ctx.cwd,
          mode: "session",
          environment: readyTarget.environment,
          profile: readyTarget.profile,
          source: readyTarget.source,
          decision: "executed",
        },
        getLogPath()!,
      );
    }

    updateTargetUi(ctx, readyTarget, getLogPath(), activeSession);
    if (ctx.hasUI) {
      ctx.ui.notify(`SSH mode: ${formatTargetLabel(readyTarget)}`, "info");
      ctx.ui.notify(`SSH log: ${path.relative(ctx.cwd, getLogPath() ?? "")}`, "info");
    }

    const preflight = await runPreflight(ctx, activeSession);
    if (preflight) {
      const preflightMessage = preflight.missingTools.length === 0
        ? "SSH preflight passed."
        : `SSH preflight warnings: missing ${preflight.missingTools.join(", ")}. Run /ssh-health for details.`;
      ctx.hasUI ? ctx.ui.notify(preflightMessage, preflight.missingTools.length === 0 ? "info" : "warning") : console.log(preflightMessage);
    }

    return true;
  };

  const collectRunbookParameters = async (
    ctx: ExtensionContext,
    runbook: LoadedSshRunbook,
    overrides: Record<string, string>,
  ): Promise<Record<string, string> | null> => {
    const names = extractRunbookParameterNames(runbook);
    if (names.length === 0) return {};

    const values: Record<string, string> = {};
    for (const name of names) {
      const definition = runbook.parameters?.[name];
      const provided = overrides[name];
      if (provided !== undefined) {
        values[name] = provided;
        continue;
      }
      if (definition?.default !== undefined) {
        values[name] = definition.default;
        continue;
      }
      if (!ctx.hasUI) {
        console.log(`Missing runbook parameter --${name}`);
        return null;
      }
      const fallback = name === "path" ? "/srv/app" : "app";
      const prompt = definition?.description ? `${name} (${definition.description})` : `Runbook parameter: ${name}`;
      const value = (await ctx.ui.input(prompt, fallback))?.trim();
      if (!value && definition?.required !== false) return null;
      if (value) values[name] = value;
    }
    return values;
  };

  const attachRunbookReport = (target: ResolvedSshTarget, report: SshRunbookExecutionReport): void => {
    if (activeSession && activeSession.target.remote === target.remote && activeSession.target.profile === target.profile) {
      activeSession.runbookReports = [...(activeSession.runbookReports ?? []), report];
      return;
    }
    lastSession = {
      target: { ...target },
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      disconnectReason: "standalone runbook",
      runbookReports: [report],
    };
  };

  const selectRunbookTarget = async (ctx: ExtensionContext, runbook: LoadedSshRunbook, overrideTarget?: string): Promise<ResolvedSshTarget | null> => {
    const reference = overrideTarget || runbook.target || getTarget()?.profile || getTarget()?.reference;
    if (reference) {
      return resolveSshTarget(reference, sshConfig);
    }

    const targets = listConfiguredTargets(sshConfig);
    if (targets.length === 0) {
      const message = "Runbook target is not configured. Connect first or add targets in SSH config.";
      ctx.hasUI ? ctx.ui.notify(message, "warning") : console.log(message);
      return null;
    }
    if (!ctx.hasUI) {
      console.log("Runbook requires a target. Use /ssh-runbook <name> --target <target>.");
      return null;
    }

    const items = targets.map((target) => formatTargetChoice(target, target.name === getTarget()?.profile));
    const selected = await ctx.ui.select(`Select target for runbook ${runbook.name}`, items);
    if (!selected) return null;
    const selectedTarget = targets[items.indexOf(selected)];
    return selectedTarget ? resolveSshTarget(selectedTarget.name, sshConfig) : null;
  };

  const executeRunbook = async (
    ctx: ExtensionContext,
    runbook: LoadedSshRunbook,
    overrideTarget?: string,
    paramOverrides: Record<string, string> = {},
  ): Promise<void> => {
    reloadConfig(ctx.cwd);
    logPath = ensureLogPath(ctx.cwd, logPath);

    const target = await selectRunbookTarget(ctx, runbook, overrideTarget);
    if (!target) {
      ctx.hasUI ? ctx.ui.notify("Could not resolve runbook target.", "error") : console.error("Could not resolve runbook target.");
      return;
    }

    const readyTarget = await ensureTargetReady(ctx, { ...target }, `runbook ${runbook.name}`);
    if (!readyTarget) return;

    const params = await collectRunbookParameters(ctx, runbook, paramOverrides);
    if (!params) return;

    const preview = renderRunbookPreview(runbook, readyTarget, params);
    if (ctx.hasUI) {
      await ctx.ui.editor(`SSH Runbook: ${runbook.name}`, preview);
    } else {
      console.log(preview);
    }

    if (runbook.requiresConfirmation) {
      if (!ctx.hasUI) {
        ctx.hasUI ? ctx.ui.notify("Runbook requires interactive confirmation.", "warning") : console.warn("Runbook requires interactive confirmation.");
        return;
      }
      const confirmed = await ctx.ui.confirm("Confirm runbook", `Run ${runbook.title} against ${formatTargetLabel(readyTarget)}?`);
      if (!confirmed) return;
    }

    const startedAt = new Date().toISOString();
    if (getLogPath()) {
      logSshCall(
        {
          remote: readyTarget.remote,
          command: `runbook:start ${runbook.name}`,
          type: "runbook",
          cwd: ctx.cwd,
          mode: "command",
          environment: readyTarget.environment,
          profile: readyTarget.profile,
          source: readyTarget.source,
          decision: "executed",
          reason: `${runbook.steps.length} step(s) from ${runbook.source}`,
        },
        getLogPath()!,
      );
    }

    const policy = getEnvironmentPolicy(readyTarget.environment, sshConfig);
    const resultLines = [
      `Runbook: ${runbook.title}`,
      `Name: ${runbook.name}`,
      `Target: ${formatTargetLabel(readyTarget)}`,
      `Source: ${runbook.source}`,
      `Parameters: ${Object.keys(params).length > 0 ? JSON.stringify(params) : "(none)"}`,
      "",
      "Results:",
    ];
    const stepReports: SshRunbookStepReport[] = [];

    for (const [index, step] of runbook.steps.entries()) {
      const renderedTitle = renderTemplate(step.title || step.command, params);
      const renderedCommand = renderTemplate(step.command, params);
      const blockedReason = getBlockedCommandReason(renderedCommand, policy);
      if (blockedReason) {
        resultLines.push(`- Step ${index + 1}: BLOCKED · ${renderedTitle}`, `  Reason: ${blockedReason}`);
        stepReports.push({ index: index + 1, title: renderedTitle, command: renderedCommand, status: "blocked", reason: blockedReason });
        if (getLogPath()) {
          logSshCall(
            {
              remote: readyTarget.remote,
              command: `runbook:${runbook.name}:step:${index + 1} ${renderedCommand}`,
              type: "runbook",
              cwd: ctx.cwd,
              mode: "command",
              environment: readyTarget.environment,
              profile: readyTarget.profile,
              source: readyTarget.source,
              decision: "blocked",
              reason: blockedReason,
            },
            getLogPath()!,
          );
        }
        break;
      }

      const needsConfirmation = step.confirm || (policy.confirmMutatingCommands && isPotentiallyMutatingCommand(renderedCommand));
      if (needsConfirmation) {
        if (!ctx.hasUI) {
          resultLines.push(`- Step ${index + 1}: BLOCKED · ${renderedTitle}`, "  Reason: Interactive confirmation required");
          stepReports.push({ index: index + 1, title: renderedTitle, command: renderedCommand, status: "blocked", reason: "Interactive confirmation required" });
          break;
        }
        const confirmed = await ctx.ui.confirm(
          `Confirm runbook step ${index + 1}`,
          `${renderedTitle}\n\nTarget: ${formatTargetLabel(readyTarget)}\nCommand: ${renderedCommand}`,
        );
        if (!confirmed) {
          resultLines.push(`- Step ${index + 1}: CANCELLED · ${renderedTitle}`);
          stepReports.push({ index: index + 1, title: renderedTitle, command: renderedCommand, status: "cancelled" });
          break;
        }
      }

      try {
        const output = await sshExec(
          readyTarget,
          buildRemoteCommand(readyTarget.remoteCwd, renderedCommand),
          "runbook-step",
          ctx.cwd,
          getLogPath(),
          "command",
          step.expectedExitCodes ?? [],
        );
        const text = truncateOutput(output.toString()) || "(no output)";
        resultLines.push(`- Step ${index + 1}: OK · ${renderedTitle}`, ...text.split(/\r?\n/).map((line) => `  ${line}`));
        stepReports.push({ index: index + 1, title: renderedTitle, command: renderedCommand, status: "ok", output: text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resultLines.push(`- Step ${index + 1}: FAILED · ${renderedTitle}`, `  ${message}`);
        stepReports.push({ index: index + 1, title: renderedTitle, command: renderedCommand, status: "failed", reason: message });
        if (step.stopOnFailure !== false) break;
      }
    }

    const endedAt = new Date().toISOString();
    if (getLogPath()) {
      logSshCall(
        {
          remote: readyTarget.remote,
          command: `runbook:end ${runbook.name}`,
          type: "runbook",
          cwd: ctx.cwd,
          mode: "command",
          environment: readyTarget.environment,
          profile: readyTarget.profile,
          source: readyTarget.source,
          decision: "executed",
        },
        getLogPath()!,
      );
    }

    const report: SshRunbookExecutionReport = {
      name: runbook.name,
      title: runbook.title,
      source: runbook.source,
      path: runbook.path,
      target: formatTargetLabel(readyTarget),
      startedAt,
      endedAt,
      parameters: params,
      steps: stepReports,
    };
    attachRunbookReport(readyTarget, report);

    const result = `${resultLines.join("\n")}\n\n${formatRunbookReport(report)}`;
    if (ctx.hasUI) {
      await ctx.ui.editor(`SSH Runbook Result: ${runbook.name}`, result);
    } else {
      console.log(result);
    }
  };

  pi.registerCommand("ssh-run", {
    description: "Run a remote command via SSH (example: /ssh-run app-prod ls -la)",
    handler: async (args, ctx) => {
      const parsed = parseSshTarget(args);
      if (!parsed) {
        const message = "Usage: /ssh-run <target|user@host[:/path]> command";
        ctx.hasUI ? ctx.ui.notify(message, "warning") : console.log(message);
        return;
      }

      reloadConfig(ctx.cwd);
      logPath = ensureLogPath(ctx.cwd, logPath);
      const reference = parsed.remoteCwd ? `${parsed.remote}:${parsed.remoteCwd}` : parsed.remote;
      const target = resolveSshTarget(reference, sshConfig);
      if (!target) {
        ctx.hasUI ? ctx.ui.notify("Could not resolve SSH target.", "error") : console.error("Could not resolve SSH target.");
        return;
      }

      const policy = getEnvironmentPolicy(target.environment, sshConfig);
      const blockedReason = getBlockedCommandReason(parsed.command, policy);
      if (blockedReason) {
        buildPolicyLog(target, parsed.command, "blocked", blockedReason, ctx.cwd, getLogPath()!);
        ctx.hasUI ? ctx.ui.notify(blockedReason, "warning") : console.warn(blockedReason);
        return;
      }

      const readyTarget = await ensureTargetReady(ctx, target, parsed.command);
      if (!readyTarget) return;

      const fullCommand = buildRemoteCommand(readyTarget.remoteCwd, parsed.command);
      try {
        const output = await sshExec(readyTarget, fullCommand, "ssh-run", ctx.cwd, getLogPath(), "command");
        const result = truncateOutput(output.toString());
        if (ctx.hasUI) {
          await ctx.ui.editor(`SSH: ${formatTargetLabel(readyTarget)}`, result || "(no output)");
        } else {
          console.log(result || "(no output)");
        }
      } catch (error) {
        const err = error as Error;
        ctx.hasUI ? ctx.ui.notify(`SSH error: ${err.message}`, "error") : console.error(err.message);
      }
    },
  });

  pi.registerCommand("ssh-configure", {
    description: "Create a project-local .pi/ssh/config.json via TUI",
    handler: async (_args, ctx) => {
      const targetName = await ensureSshConfigViaTui(ctx);
      if (!targetName) return;
      const target = resolveSshTarget(targetName, sshConfig);
      if (!target) {
        ctx.hasUI ? ctx.ui.notify("SSH config was saved, but the new target could not be resolved.", "warning") : console.warn("SSH config was saved, but the new target could not be resolved.");
        return;
      }
      const targets = listConfiguredTargets(sshConfig).map((configured) => `- ${formatTargetChoice(configured, configured.name === target.profile)}`);
      const message = [`Created target: ${formatTargetLabel(target)}`, "", "Configured targets:", ...targets, "", "Tip: run /ssh-manage for add/edit/remove operations."].join("\n");
      if (ctx.hasUI) {
        await ctx.ui.editor("SSH Config Created", message);
      } else {
        console.log(message);
      }
    },
  });

  pi.registerCommand("ssh-manage", {
    description: "Manage project-local SSH targets via TUI",
    handler: async (_args, ctx) => {
      await manageSshTargetsViaTui(ctx);
    },
  });

  pi.registerCommand("ssh-targets", {
    description: "List configured SSH target profiles",
    handler: async (_args, ctx) => {
      reloadConfig(ctx.cwd);
      let localRaw = readProjectSshConfigRaw(ctx.cwd).raw;
      let localConfig = normalizeSshConfig(localRaw);
      let localTargets = buildManagedTargets(localConfig, "local");
      if (localTargets.length === 0 && Object.keys(loadSshConfig(ctx.cwd).targets).length === 0) {
        ctx.hasUI ? ctx.ui.notify("No SSH target profiles configured.", "info") : console.log("No SSH target profiles configured.");
        const targetName = await ensureSshConfigViaTui(ctx);
        if (!targetName) return;
        localRaw = readProjectSshConfigRaw(ctx.cwd).raw;
        localConfig = normalizeSshConfig(localRaw);
        localTargets = buildManagedTargets(localConfig, "local");
      }

      const globalLoaded = readGlobalSshConfigRaw();
      const globalConfig = normalizeSshConfig(globalLoaded.raw);
      const localNames = new Set(localTargets.map((target) => target.name));
      const globalTargets = buildManagedTargets(globalConfig, "global", localNames);
      const message = buildManagerOverview(
        path.relative(ctx.cwd, getProjectSshConfigPath(ctx.cwd)) || getProjectSshConfigPath(ctx.cwd),
        getGlobalSshConfigPath(),
        localTargets,
        globalTargets,
        getTarget()?.profile,
        globalLoaded.parseError,
      );
      if (ctx.hasUI) {
        await ctx.ui.editor("SSH Targets", message);
      } else {
        console.log(message);
      }
    },
  });

  pi.registerCommand("ssh-connect", {
    description: "Interactively connect to a configured SSH target or pass one explicitly",
    handler: async (args, ctx) => {
      reloadConfig(ctx.cwd);
      logPath = ensureLogPath(ctx.cwd, logPath);

      let reference = String(args || "").trim();
      if (!reference) {
        const localRaw = readProjectSshConfigRaw(ctx.cwd).raw;
        const localConfig = normalizeSshConfig(localRaw);
        const localTargets = buildManagedTargets(localConfig, "local");
        const globalTargets = buildManagedTargets(normalizeSshConfig(readGlobalSshConfigRaw().raw), "global", new Set(localTargets.map((target) => target.name)));
        let targets = [...localTargets, ...globalTargets.filter((target) => !target.shadowed)];
        if (targets.length === 0) {
          ctx.hasUI ? ctx.ui.notify("No SSH targets configured. Create .pi/ssh/config.json first.", "warning") : console.log("No SSH targets configured. Create .pi/ssh/config.json first.");
          const createdTarget = await ensureSshConfigViaTui(ctx);
          if (!createdTarget) return;
          const reloadedLocal = buildManagedTargets(normalizeSshConfig(readProjectSshConfigRaw(ctx.cwd).raw), "local");
          const reloadedGlobal = buildManagedTargets(normalizeSshConfig(readGlobalSshConfigRaw().raw), "global", new Set(reloadedLocal.map((target) => target.name)));
          targets = [...reloadedLocal, ...reloadedGlobal.filter((target) => !target.shadowed)];
          reference = createdTarget;
        }
        if (!reference) {
          if (!ctx.hasUI) {
            console.log("Usage: /ssh-connect <target>");
            return;
          }
          const items = targets.map((target) => formatManagedTargetChoice(target, target.name === getTarget()?.profile));
          const selected = await ctx.ui.select("Select SSH target", items);
          if (!selected) return;
          const selectedTarget = targets[items.indexOf(selected)];
          reference = selectedTarget?.name || "";
        }
      }

      const target = resolveSshTarget(reference, sshConfig);
      if (!target) {
        ctx.hasUI ? ctx.ui.notify("Could not resolve SSH target.", "error") : console.error("Could not resolve SSH target.");
        return;
      }

      await activateTarget(ctx, target, `connect ${reference}`);
    },
  });

  pi.registerCommand("ssh-disconnect", {
    description: "Disconnect the current SSH session target",
    handler: async (_args, ctx) => {
      if (!getTarget()) {
        ctx.hasUI ? ctx.ui.notify("No active SSH target.", "info") : console.log("No active SSH target.");
        return;
      }
      await disconnectTarget(ctx, "SSH session disconnected.");
    },
  });

  pi.registerCommand("ssh-context", {
    description: "Show the current SSH context, policies, and log path",
    handler: async (_args, ctx) => {
      reloadConfig(ctx.cwd);
      const target = getTarget();
      if (!target) {
        ctx.hasUI ? ctx.ui.notify("No active SSH target.", "info") : console.log("No active SSH target.");
        return;
      }
      const policy = getEnvironmentPolicy(target.environment, sshConfig);
      const allowlistEnabled = sshConfig.allowlist.length > 0 ? "yes" : "no";
      const blockedCommands = policy.blockedCommands?.length ? policy.blockedCommands.join(", ") : "(none)";
      const logFilePath = getLogPath() ? path.relative(ctx.cwd, getLogPath()!) || getLogPath()! : ".pi/ssh/ssh.log";
      const session = getSession();
      const message = [
        `Target: ${formatTargetLabel(target)}`,
        `Remote: ${target.remote}`,
        `Remote cwd: ${target.remoteCwd || "(resolved on demand)"}`,
        `Environment: ${target.environment}`,
        `Profile: ${target.profile || "(raw target)"}`,
        `Allowlist enabled: ${allowlistEnabled}`,
        `Requires confirmation: ${target.requiresConfirmation ? "yes" : "no"}`,
        `Confirm write operations: ${policy.confirmWriteOperations ? "yes" : "no"}`,
        `Confirm mutating bash commands: ${policy.confirmMutatingCommands ? "yes" : "no"}`,
        `Blocked commands: ${blockedCommands}`,
        `Session started: ${session?.startedAt || "(unknown)"}`,
        `Session duration: ${session ? formatDuration(session.startedAt, session.endedAt) : "(unknown)"}`,
        `Preflight: ${session?.lastPreflight ? (session.lastPreflight.missingTools.length === 0 ? "ok" : `warnings (${session.lastPreflight.missingTools.join(", ")})`) : "not run"}`,
        `Log: ${logFilePath}`,
      ].join("\n");
      if (ctx.hasUI) {
        await ctx.ui.editor("SSH Context", message);
      } else {
        console.log(message);
      }
    },
  });

  pi.registerCommand("ssh-health", {
    description: "Check SSH connectivity and required remote tools for the current or a named target",
    handler: async (args, ctx) => {
      reloadConfig(ctx.cwd);
      logPath = ensureLogPath(ctx.cwd, logPath);
      const reference = String(args || "").trim();
      const target = reference ? resolveSshTarget(reference, sshConfig) : getTarget();
      if (!target) {
        const message = reference ? "Could not resolve SSH target." : "No active SSH target. Pass a target or connect first.";
        ctx.hasUI ? ctx.ui.notify(message, "warning") : console.log(message);
        return;
      }

      const readyTarget = await ensureTargetReady(ctx, { ...target }, `health ${reference || target.reference}`);
      if (!readyTarget) return;

      try {
        const report = await runHealthCheck(readyTarget, ctx.cwd, getLogPath());
        if (activeSession && activeSession.target.remote === readyTarget.remote && activeSession.target.profile === readyTarget.profile) {
          activeSession.lastPreflight = report;
          updateTargetUi(ctx, activeSession.target, getLogPath(), activeSession);
        }
        const message = formatHealthReport(readyTarget, report);
        if (ctx.hasUI) {
          await ctx.ui.editor("SSH Health", message);
          ctx.ui.notify(report.missingTools.length === 0 ? "SSH health check passed." : `SSH health check found ${report.missingTools.length} missing tools.`, report.missingTools.length === 0 ? "info" : "warning");
        } else {
          console.log(message);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI ? ctx.ui.notify(`SSH health failed: ${message}`, "error") : console.error(message);
      }
    },
  });

  pi.registerCommand("ssh-summary", {
    description: "Show or export a summary or raw entry slice of the current or most recent SSH session",
    handler: async (args, ctx) => {
      logPath = ensureLogPath(ctx.cwd, logPath);
      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      let format: SshSummaryFormat = "text";
      let outputPath: string | undefined;
      let useLastSession = false;
      let includeEntries = false;

      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === "--format" && tokens[index + 1]) {
          const value = tokens[index + 1] as SshSummaryFormat;
          if (["text", "markdown", "json", "raw"].includes(value)) {
            format = value;
            index += 1;
          }
          continue;
        }
        if (token === "--output" && tokens[index + 1]) {
          outputPath = tokens[index + 1];
          index += 1;
          continue;
        }
        if (token === "--last") {
          useLastSession = true;
          continue;
        }
        if (token === "--raw") {
          format = "raw";
          continue;
        }
        if (token === "--include-entries") {
          includeEntries = true;
        }
      }

      const session = useLastSession ? lastSession : getSummarySession();
      if (!session) {
        const message = "No SSH session summary is available yet.";
        ctx.hasUI ? ctx.ui.notify(message, "info") : console.log(message);
        return;
      }

      const summary = buildSessionSummary(session, getLogPath(), format, includeEntries);
      if (!summary) {
        const message = "SSH log is not available yet.";
        ctx.hasUI ? ctx.ui.notify(message, "warning") : console.log(message);
        return;
      }

      if (outputPath) {
        const absolutePath = exportSessionSummary(ctx, summary.display, outputPath);
        ctx.hasUI ? ctx.ui.notify(`SSH summary exported to ${absolutePath}`, "info") : console.log(`SSH summary exported to ${absolutePath}`);
      }

      if (ctx.hasUI) {
        await ctx.ui.editor(format === "raw" ? "SSH Session Raw Entries" : "SSH Session Summary", summary.display || "(no entries)");
      } else {
        console.log(summary.display || "(no entries)");
      }
    },
  });

  pi.registerCommand("ssh-runbooks", {
    description: "List available SSH runbooks from project and global runbook directories",
    handler: async (args, ctx) => {
      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      let filterQuery = "";
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === "--filter" && tokens[index + 1]) {
          filterQuery = tokens[index + 1];
          index += 1;
          continue;
        }
      }
      if (!filterQuery && tokens.length > 0 && tokens[0] !== "--filter") {
        filterQuery = tokens.join(" ");
      }

      const runbooks = filterRunbooks(listSshRunbooks(ctx.cwd), filterQuery);
      const message = buildRunbookListing(runbooks, ctx.cwd) + (filterQuery ? `\n\nFilter: ${filterQuery}` : "");
      if (ctx.hasUI) {
        await ctx.ui.editor("SSH Runbooks", message);
      } else {
        console.log(message);
      }
    },
  });

  pi.registerCommand("ssh-runbook", {
    description: "Preview and execute a configured SSH runbook",
    handler: async (args, ctx) => {
      reloadConfig(ctx.cwd);
      const allRunbooks = listSshRunbooks(ctx.cwd);
      if (allRunbooks.length === 0) {
        const message = buildRunbookListing(allRunbooks, ctx.cwd);
        if (ctx.hasUI) {
          await ctx.ui.editor("SSH Runbooks", message);
        } else {
          console.log(message);
        }
        return;
      }

      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      let overrideTarget: string | undefined;
      let filterQuery = "";
      const paramOverrides: Record<string, string> = {};
      const nameTokens: string[] = [];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === "--target" && tokens[index + 1]) {
          overrideTarget = tokens[index + 1];
          index += 1;
          continue;
        }
        if (token === "--filter" && tokens[index + 1]) {
          filterQuery = tokens[index + 1];
          index += 1;
          continue;
        }
        if (token.startsWith("--") && tokens[index + 1]) {
          paramOverrides[token.slice(2)] = tokens[index + 1];
          index += 1;
          continue;
        }
        nameTokens.push(token);
      }

      const runbooks = filterRunbooks(allRunbooks, filterQuery);
      let runbook: LoadedSshRunbook | undefined;
      const requestedName = nameTokens.join(" ").trim();
      if (requestedName) {
        runbook = runbooks.find((item) => item.name === requestedName) ?? allRunbooks.find((item) => item.name === requestedName);
      }

      if (!runbook) {
        if (!ctx.hasUI) {
          console.log(`Usage: /ssh-runbook <name> [--target <target>] [--service <name>] [--container <name>] [--path <path>] [--filter <query>]\n\n${buildRunbookListing(runbooks, ctx.cwd)}`);
          return;
        }
        const items = runbooks.map(formatRunbookChoice);
        const selected = await ctx.ui.select("Select SSH runbook", items);
        if (!selected) return;
        runbook = runbooks[items.indexOf(selected)];
      }

      if (!runbook) {
        ctx.hasUI ? ctx.ui.notify("Runbook not found.", "error") : console.error("Runbook not found.");
        return;
      }

      await executeRunbook(ctx, runbook, overrideTarget, paramOverrides);
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        const tool = createReadTool(localCwd, {
          operations: createRemoteReadOps(target, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localRead.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        const tool = createWriteTool(localCwd, {
          operations: createRemoteWriteOps(target, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localWrite.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        const tool = createEditTool(localCwd, {
          operations: createRemoteEditOps(target, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localEdit.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        const tool = createBashTool(localCwd, {
          operations: createRemoteBashOps(target, target.remoteCwd, localCwd, "bash", getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        const tool = createLsTool(localCwd, {
          operations: createRemoteLsOps(target, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localLs.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        const tool = createFindTool(localCwd, {
          operations: createRemoteFindOps(target, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localFind.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(id, params, signal, onUpdate) {
      const target = getTarget();
      if (target?.remoteCwd) {
        return executeRemoteGrep(target, params as any, localCwd, getLogPath());
      }
      return localGrep.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    reloadConfig(ctx.cwd);
    logPath = ensureLogPath(ctx.cwd, logPath);

    const target = getTarget();
    if (target && ["write", "edit"].includes(event.toolName)) {
      const policy = getEnvironmentPolicy(target.environment, sshConfig);
      const filePath = (event.input as { path?: string } | undefined)?.path || "(unknown path)";
      if (policy.confirmWriteOperations) {
        if (!ctx.hasUI) {
          buildPolicyLog(target, `tool:${event.toolName} ${filePath}`, "blocked", "Remote write requires interactive confirmation", ctx.cwd, getLogPath()!);
          return { block: true, reason: "Remote write requires interactive confirmation" };
        }
        const confirmed = await ctx.ui.confirm(
          "Confirm remote write",
          `Environment ${target.environment} requires confirmation for remote write operations.\n\nTarget: ${formatTargetLabel(target)}\nPath: ${filePath}`,
        );
        buildPolicyLog(target, `tool:${event.toolName} ${filePath}`, confirmed ? "confirmed" : "denied", confirmed ? undefined : "User denied remote write", ctx.cwd, getLogPath()!);
        if (!confirmed) {
          return { block: true, reason: "Remote write denied by environment policy" };
        }
      }
    }

    if (event.toolName === "bash") {
      const command = (event.input as { command?: string } | undefined)?.command || "";

      if (target) {
        const policy = getEnvironmentPolicy(target.environment, sshConfig);
        const blockedReason = getBlockedCommandReason(command, policy);
        if (blockedReason) {
          buildPolicyLog(target, command, "blocked", blockedReason, ctx.cwd, getLogPath()!);
          return { block: true, reason: blockedReason };
        }
        if (policy.confirmMutatingCommands && isPotentiallyMutatingCommand(command)) {
          if (!ctx.hasUI) {
            buildPolicyLog(target, command, "blocked", "Mutating remote command requires interactive confirmation", ctx.cwd, getLogPath()!);
            return { block: true, reason: "Mutating remote command requires interactive confirmation" };
          }
          const confirmed = await ctx.ui.confirm(
            "Confirm remote command",
            `Environment ${target.environment} requires confirmation for mutating remote bash commands.\n\nTarget: ${formatTargetLabel(target)}\nCommand: ${command}`,
          );
          buildPolicyLog(target, command, confirmed ? "confirmed" : "denied", confirmed ? undefined : "User denied remote bash command", ctx.cwd, getLogPath()!);
          if (!confirmed) {
            return { block: true, reason: "Remote command denied by environment policy" };
          }
        }
      }

      if (command.trim().startsWith("ssh ")) {
        const parsed = parseSshInvocation(command);
        const resolved = parsed ? resolveSshTarget(parsed.remote, sshConfig) : null;
        if (resolved) {
          const blockedReason = getBlockedCommandReason(command, getEnvironmentPolicy(resolved.environment, sshConfig));
          if (blockedReason) {
            buildPolicyLog(resolved, command, "blocked", blockedReason, ctx.cwd, getLogPath()!);
            return { block: true, reason: blockedReason };
          }
          if (!isSshTargetAllowed(resolved, sshConfig)) {
            buildPolicyLog(resolved, command, "blocked", "Target not present in SSH allowlist", ctx.cwd, getLogPath()!);
            return { block: true, reason: "SSH target blocked by allowlist" };
          }
          if (resolved.requiresConfirmation) {
            if (!ctx.hasUI) {
              buildPolicyLog(resolved, command, "blocked", "Direct SSH command requires interactive confirmation", ctx.cwd, getLogPath()!);
              return { block: true, reason: "Direct SSH command requires interactive confirmation" };
            }
            const confirmed = await ctx.ui.confirm(
              "Confirm direct SSH command",
              `This SSH target requires confirmation.\n\nTarget: ${formatTargetLabel(resolved)}\nCommand: ${command}`,
            );
            buildPolicyLog(resolved, command, confirmed ? "confirmed" : "denied", confirmed ? undefined : "User denied direct SSH command", ctx.cwd, getLogPath()!);
            if (!confirmed) {
              return { block: true, reason: "Direct SSH command denied by policy" };
            }
          }
        }

        if (parsed) {
          logSshCall(
            {
              remote: parsed.remote,
              command: parsed.command,
              type: "bash-ssh",
              cwd: ctx.cwd,
              mode: "bash",
              profile: resolved?.profile,
              environment: resolved?.environment,
              source: resolved?.source,
              decision: "executed",
            },
            getLogPath()!,
          );
        } else {
          logSshCall(
            {
              remote: "unknown",
              command,
              type: "bash-ssh",
              cwd: ctx.cwd,
              mode: "bash",
              decision: "executed",
            },
            getLogPath()!,
          );
        }
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    reloadConfig(ctx.cwd);
    logPath = ensureLogPath(ctx.cwd, logPath);
    const arg = pi.getFlag("ssh") as string | undefined;
    if (!arg) {
      updateTargetUi(ctx, getTarget(), getLogPath(), getSession());
      return;
    }

    const target = resolveSshTarget(arg, sshConfig);
    if (!target) {
      ctx.hasUI ? ctx.ui.notify("Could not resolve SSH target.", "error") : console.error("Could not resolve SSH target.");
      return;
    }

    await activateTarget(ctx, target, `connect ${arg}`);
  });

  pi.on("user_bash", async (event, ctx) => {
    reloadConfig(ctx.cwd);
    logPath = ensureLogPath(ctx.cwd, logPath);
    const trimmed = event.command.trim();

    if (trimmed.startsWith("ssh ")) {
      const parsed = parseSshInvocation(trimmed);
      const resolved = parsed ? resolveSshTarget(parsed.remote, sshConfig) : null;
      if (resolved) {
        const blockedReason = getBlockedCommandReason(trimmed, getEnvironmentPolicy(resolved.environment, sshConfig));
        if (blockedReason) {
          buildPolicyLog(resolved, trimmed, "blocked", blockedReason, ctx.cwd, getLogPath()!);
          return {
            result: {
              output: blockedReason,
              exitCode: 126,
              cancelled: false,
              truncated: false,
            },
          };
        }
        if (!isSshTargetAllowed(resolved, sshConfig)) {
          buildPolicyLog(resolved, trimmed, "blocked", "Target not present in SSH allowlist", ctx.cwd, getLogPath()!);
          return {
            result: {
              output: "SSH target blocked by allowlist",
              exitCode: 126,
              cancelled: false,
              truncated: false,
            },
          };
        }
      }

      if (parsed) {
        logSshCall(
          {
            remote: parsed.remote,
            command: parsed.command,
            type: "user_bash",
            cwd: ctx.cwd,
            mode: "user_bash",
            profile: resolved?.profile,
            environment: resolved?.environment,
            source: resolved?.source,
            decision: "executed",
          },
          getLogPath()!,
        );
      } else {
        logSshCall(
          {
            remote: "unknown",
            command: trimmed,
            type: "user_bash",
            cwd: ctx.cwd,
            mode: "user_bash",
            decision: "executed",
          },
          getLogPath()!,
        );
      }
    }

    const target = getTarget();
    if (!target?.remoteCwd) return;
    return { operations: createRemoteBashOps(target, target.remoteCwd, localCwd, "user_bash", getLogPath()) };
  });

  pi.on("before_agent_start", async (event) => {
    const target = getTarget();
    let systemPrompt = event.systemPrompt;
    if (target?.remoteCwd) {
      systemPrompt = systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${target.remoteCwd} (via SSH: ${target.remote}, env: ${target.environment})`,
      );
    }
    if (!systemPrompt.includes(SSH_PROMPT_HINT)) {
      systemPrompt = `${systemPrompt}\n\n${SSH_PROMPT_HINT}`;
    }
    return { systemPrompt };
  });
}
