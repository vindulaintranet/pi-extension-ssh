import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from '@mariozechner/pi-coding-agent';
import {
  SSH_PROMPT_HINT,
  buildRemoteCommand,
  ensureLogPath,
  logSshCall,
  parseSshInvocation,
  parseSshTarget,
  truncateOutput,
} from './ssh-core';

/**
 * pi-extension-ssh
 * Created by Fabio Rizzo Matos
 * GitHub: https://github.com/fabiorizzomatos
 * Contact: fabiorizzo@vindula.com.br
 */

function sshExec(remote: string, command: string, type: string, cwd?: string, logPath?: string | null): Promise<Buffer> {
  if (logPath) {
    logSshCall({ remote, command, type, cwd }, logPath);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [remote, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (data) => chunks.push(data));
    child.stderr.on('data', (data) => errChunks.push(data));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string, logPath?: string | null): ReadOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`, 'read', localCwd, logPath),
    access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`, 'access', localCwd, logPath).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`, 'mime', localCwd, logPath);
        const m = r.toString().trim();
        return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string, logPath?: string | null): WriteOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString('base64');
      await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`, 'write', localCwd, logPath);
    },
    mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`, 'mkdir', localCwd, logPath).then(() => {}),
  };
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string, logPath?: string | null): EditOperations {
  const r = createRemoteReadOps(remote, remoteCwd, localCwd, logPath);
  const w = createRemoteWriteOps(remote, remoteCwd, localCwd, logPath);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string, logType: string, logPath?: string | null): BashOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const resolvedCwd = toRemote(cwd);
        const cmd = `cd ${JSON.stringify(resolvedCwd)} && ${command}`;
        if (logPath) {
          logSshCall({ remote, command: cmd, type: logType, cwd: resolvedCwd }, logPath);
        }

        const child = spawn('ssh', [remote, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener('abort', onAbort, { once: true });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) reject(new Error('aborted'));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  };
}

export default function sshExtension(pi: ExtensionAPI) {
  pi.registerFlag('ssh', { description: 'SSH remote: user@host or user@host:/path', type: 'string' });

  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
  let logPath: string | null = null;

  const getSsh = () => resolvedSsh;
  const getLogPath = () => logPath;

  pi.registerCommand('ssh-run', {
    description: 'Run a remote command via SSH (example: /ssh-run user@host:/path ls -la)',
    handler: async (args, ctx) => {
      const parsed = parseSshTarget(args);
      if (!parsed) {
        const message = 'Usage: /ssh-run user@host:/path command';
        ctx.hasUI ? ctx.ui.notify(message, 'warning') : console.log(message);
        return;
      }

      logPath = ensureLogPath(ctx.cwd, logPath);
      const fullCommand = buildRemoteCommand(parsed.remoteCwd, parsed.command);
      try {
        const output = await sshExec(parsed.remote, fullCommand, 'ssh-run', ctx.cwd, getLogPath());
        const result = truncateOutput(output.toString());
        if (ctx.hasUI) {
          await ctx.ui.editor(`SSH: ${parsed.remote}`, result || '(no output)');
        } else {
          console.log(result || '(no output)');
        }
      } catch (error) {
        const err = error as Error;
        ctx.hasUI ? ctx.ui.notify(`SSH error: ${err.message}`, 'error') : console.error(err.message);
      }
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createReadTool(localCwd, {
          operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localRead.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createWriteTool(localCwd, {
          operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localWrite.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createEditTool(localCwd, {
          operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd, getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localEdit.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createBashTool(localCwd, {
          operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd, 'bash', getLogPath()),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const command = (event.input as { command?: string } | undefined)?.command;
    if (!command || !command.trim().startsWith('ssh ')) return;

    logPath = ensureLogPath(ctx.cwd, logPath);
    const parsed = parseSshInvocation(command);
    if (parsed) {
      logSshCall({ remote: parsed.remote, command: parsed.command, type: 'bash-ssh', cwd: ctx.cwd }, getLogPath()!);
    } else {
      logSshCall({ remote: 'unknown', command, type: 'bash-ssh', cwd: ctx.cwd }, getLogPath()!);
    }
  });

  pi.on('session_start', async (_event, ctx) => {
    logPath = ensureLogPath(ctx.cwd, logPath);
    const arg = pi.getFlag('ssh') as string | undefined;
    if (arg) {
      if (arg.includes(':')) {
        const [remote, remoteCwd] = arg.split(':');
        resolvedSsh = { remote, remoteCwd };
      } else {
        const remote = arg;
        const pwd = (await sshExec(remote, 'pwd', 'pwd', ctx.cwd, getLogPath())).toString().trim();
        resolvedSsh = { remote, remoteCwd: pwd };
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus('ssh', ctx.ui.theme.fg('accent', `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
        ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, 'info');
        ctx.ui.notify(`SSH log: ${path.relative(ctx.cwd, getLogPath() ?? '')}`, 'info');
      }
    }
  });

  pi.on('user_bash', (event, ctx) => {
    const trimmed = event.command.trim();
    if (trimmed.startsWith('ssh ')) {
      logPath = ensureLogPath(ctx.cwd, logPath);
      const parsed = parseSshInvocation(trimmed);
      if (parsed) {
        logSshCall({ remote: parsed.remote, command: parsed.command, type: 'user_bash', cwd: ctx.cwd }, getLogPath()!);
      } else {
        logSshCall({ remote: 'unknown', command: trimmed, type: 'user_bash', cwd: ctx.cwd }, getLogPath()!);
      }
    }

    const ssh = getSsh();
    if (!ssh) return;
    return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd, 'user_bash', getLogPath()) };
  });

  pi.on('before_agent_start', async (event) => {
    const ssh = getSsh();
    let systemPrompt = event.systemPrompt;
    if (ssh) {
      systemPrompt = systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
      );
    }
    if (!systemPrompt.includes(SSH_PROMPT_HINT)) {
      systemPrompt = `${systemPrompt}\n\n${SSH_PROMPT_HINT}`;
    }
    return { systemPrompt };
  });
}
