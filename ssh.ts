import { spawn } from "node:child_process";
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
  ensureLogPath,
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
  resolveSshTarget,
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

function formatTargetLabel(target: ResolvedSshTarget): string {
  const base = target.profile ? `${target.profile} -> ${target.remote}` : target.remote;
  const cwd = target.remoteCwd ? `:${target.remoteCwd}` : "";
  const environment = target.environment && target.environment !== "default" ? ` [${target.environment}]` : "";
  return `${base}${cwd}${environment}`;
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
      const lines = output
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines;
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
  let logPath: string | null = null;
  let sshConfig: SshConfig = loadSshConfig(localCwd);

  const getLogPath = () => logPath;
  const getTarget = () => activeTarget;
  const reloadConfig = (cwd: string) => {
    sshConfig = loadSshConfig(cwd);
    return sshConfig;
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

    const policy = getEnvironmentPolicy(target.environment, sshConfig);
    if (policy.requiresConfirmation && !(await confirmTarget(ctx, target, "This target requires confirmation.", commandForLog))) {
      ctx.hasUI ? ctx.ui.notify("SSH action cancelled.", "warning") : console.warn("SSH action cancelled.");
      return false;
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

      if (!(await validateTarget(ctx, target, parsed.command))) {
        return;
      }

      const fullCommand = buildRemoteCommand(target.remoteCwd, parsed.command);
      try {
        const output = await sshExec(target, fullCommand, "ssh-run", ctx.cwd, getLogPath(), "command");
        const result = truncateOutput(output.toString());
        if (ctx.hasUI) {
          await ctx.ui.editor(`SSH: ${formatTargetLabel(target)}`, result || "(no output)");
        } else {
          console.log(result || "(no output)");
        }
      } catch (error) {
        const err = error as Error;
        ctx.hasUI ? ctx.ui.notify(`SSH error: ${err.message}`, "error") : console.error(err.message);
      }
    },
  });

  pi.registerCommand("ssh-targets", {
    description: "List configured SSH target profiles",
    handler: async (_args, ctx) => {
      reloadConfig(ctx.cwd);
      const targets = listConfiguredTargets(sshConfig);
      if (targets.length === 0) {
        ctx.hasUI ? ctx.ui.notify("No SSH target profiles configured.", "info") : console.log("No SSH target profiles configured.");
        return;
      }
      const lines = targets.map((target) => {
        const cwdLabel = target.cwd ? `:${target.cwd}` : "";
        const envLabel = target.environment && target.environment !== "default" ? ` [${target.environment}]` : "";
        return `- ${target.name} -> ${target.remote}${cwdLabel}${envLabel}`;
      });
      const message = lines.join("\n");
      if (ctx.hasUI) {
        await ctx.ui.editor("SSH Targets", message);
      } else {
        console.log(message);
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
      if (policy.confirmWriteOperations && ctx.hasUI) {
        const filePath = (event.input as { path?: string } | undefined)?.path || "(unknown path)";
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
        if (policy.confirmMutatingCommands && isPotentiallyMutatingCommand(command) && ctx.hasUI) {
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
          if (resolved.requiresConfirmation && ctx.hasUI) {
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
    if (!arg) return;

    const target = resolveSshTarget(arg, sshConfig);
    if (!target) {
      ctx.hasUI ? ctx.ui.notify("Could not resolve SSH target.", "error") : console.error("Could not resolve SSH target.");
      return;
    }

    if (!(await validateTarget(ctx, target, `connect ${arg}`))) {
      return;
    }

    if (!target.remoteCwd) {
      try {
        const pwd = (await sshExec(target, "pwd", "pwd", ctx.cwd, getLogPath(), "session")).toString().trim();
        target.remoteCwd = pwd;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI ? ctx.ui.notify(`SSH target failed: ${message}`, "error") : console.error(message);
        return;
      }
    }

    activeTarget = target;
    if (ctx.hasUI) {
      ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${formatTargetLabel(target)}`));
      ctx.ui.notify(`SSH mode: ${formatTargetLabel(target)}`, "info");
      ctx.ui.notify(`SSH log: ${path.relative(ctx.cwd, getLogPath() ?? "")}`, "info");
    }
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
