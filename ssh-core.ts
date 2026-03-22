import * as fs from "node:fs";
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
}

export interface ParsedSshTarget {
  remote: string;
  remoteCwd?: string;
  command: string;
}

export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;
export const SSH_PROMPT_HINT =
  'SSH remote execution is available. When the user asks for remote execution, prefer the SSH session mode or `bash` with `ssh user@host "command"`.';

export function ensureLogPath(cwd: string, currentLogPath?: string | null): string {
  if (currentLogPath) return currentLogPath;
  const dir = path.join(cwd, '.pi', 'ssh');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ssh.log');
}

export function logSshCall(
  entry: Omit<SshLogEntry, 'timestamp'>,
  logFilePath: string,
): void {
  const payload: SshLogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  try {
    fs.appendFileSync(logFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
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
    return kept.join('\n');
  }

  return `${kept.join('\n')}\n\n[Output truncated: ${kept.length}/${lines.length} lines, ${bytes}/${totalBytes} bytes]`;
}

export function parseSshTarget(args: string): ParsedSshTarget | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return null;

  const target = match[1];
  const command = match[2].trim();
  if (!command) return null;

  const [remote, ...pathParts] = target.split(':');
  const remoteCwd = pathParts.length > 0 ? pathParts.join(':') : undefined;
  return { remote, remoteCwd, command };
}

export function parseSshInvocation(command: string): { remote: string; command: string } | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith('ssh ')) return null;

  const tokens = trimmed.split(/\s+/);
  const remoteToken = tokens.find((token, index) => index > 0 && token.includes('@'));
  if (!remoteToken) return null;
  return { remote: remoteToken, command: trimmed };
}

export function buildRemoteCommand(remoteCwd: string | undefined, command: string): string {
  if (!remoteCwd) return command;
  return `cd ${JSON.stringify(remoteCwd)} && ${command}`;
}
