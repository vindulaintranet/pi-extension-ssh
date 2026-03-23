import { spawn } from "node:child_process";
import fs from "node:fs";
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
  loadSshConfig,
  logSshCall,
  mapLocalPathToRemote,
  parseSshInvocation,
  parseSshTarget,
  readSshLogEntries,
  resolveSshTarget,
  summarizeSshLogEntries,
  truncateOutput,
  type ResolvedSshTarget,
  type SshConfig,
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

type SshSessionState = {
  target: ResolvedSshTarget;
  startedAt: string;
  endedAt?: string;
  disconnectReason?: string;
  lastPreflight?: SshHealthReport;
};

type SshSummaryFormat = "text" | "markdown" | "json" | "raw";

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
    const headerLines = [
      `Target: ${formatTargetLabel(session.target)}`,
      `Started: ${session.startedAt}`,
      `Ended: ${session.endedAt || "(active)"}`,
      `Duration: ${formatDuration(session.startedAt, session.endedAt)}`,
      `Disconnect reason: ${session.disconnectReason || (session.endedAt ? "disconnect" : "(active)")}`,
      `Preflight: ${session.lastPreflight ? (session.lastPreflight.missingTools.length === 0 ? "ok" : `warnings (${session.lastPreflight.missingTools.join(", ")})`) : "not run"}`,
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
      payload = JSON.stringify({ session, summary, entries }, null, 2);
    } else if (format === "markdown") {
      const rendered = formatSshLogSummary(summary, "markdown");
      const header = ["# SSH Session Report", "", ...headerLines.map((line) => `- ${line}`), ""].join("\n");
      const details = includeEntries
        ? `\n\n## Filtered entries\n${entries.length === 0 ? "\n- (no entries)" : `\n${entries.map((entry) => `- ${entry.timestamp} · ${entry.type} · ${entry.decision || "n/a"} · ${entry.command}${entry.reason ? ` (${entry.reason})` : ""}`).join("\n")}`}`
        : "";
      payload = `${header}${rendered}${details}`;
    } else {
      const rendered = formatSshLogSummary(summary, "text");
      const header = `${headerLines.join("\n")}\n\n`;
      const details = includeEntries ? `\n\nFiltered entries:\n${detailedEntriesText}` : "";
      payload = `${header}${rendered}${details}`;
    }

    return { display: payload, entries, summary };
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
      const message = [`Created target: ${formatTargetLabel(target)}`, "", "Configured targets:", ...targets].join("\n");
      if (ctx.hasUI) {
        await ctx.ui.editor("SSH Config Created", message);
      } else {
        console.log(message);
      }
    },
  });

  pi.registerCommand("ssh-targets", {
    description: "List configured SSH target profiles",
    handler: async (_args, ctx) => {
      reloadConfig(ctx.cwd);
      let targets = listConfiguredTargets(sshConfig);
      if (targets.length === 0) {
        ctx.hasUI ? ctx.ui.notify("No SSH target profiles configured.", "info") : console.log("No SSH target profiles configured.");
        const targetName = await ensureSshConfigViaTui(ctx);
        if (!targetName) return;
        targets = listConfiguredTargets(sshConfig);
        if (targets.length === 0) return;
      }
      const activeProfile = getTarget()?.profile;
      const lines = targets.map((target) => `- ${formatTargetChoice(target, target.name === activeProfile)}`);
      const message = lines.join("\n");
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
        let targets = listConfiguredTargets(sshConfig);
        if (targets.length === 0) {
          ctx.hasUI ? ctx.ui.notify("No SSH targets configured. Create .pi/ssh/config.json first.", "warning") : console.log("No SSH targets configured. Create .pi/ssh/config.json first.");
          const createdTarget = await ensureSshConfigViaTui(ctx);
          if (!createdTarget) return;
          targets = listConfiguredTargets(sshConfig);
          reference = createdTarget;
        }
        if (!reference) {
          if (!ctx.hasUI) {
            console.log("Usage: /ssh-connect <target>");
            return;
          }
          const items = targets.map((target) => formatTargetChoice(target, target.name === getTarget()?.profile));
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
