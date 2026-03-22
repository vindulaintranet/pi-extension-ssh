import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRemoteCommand,
  ensureLogPath,
  logSshCall,
  parseSshInvocation,
  parseSshTarget,
  truncateOutput,
} from '../ssh-core.ts';

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-extension-ssh-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('parseSshTarget parses user@host:/path plus command', () => {
  const parsed = parseSshTarget('user@host:/srv/app ls -la');
  assert.deepEqual(parsed, {
    remote: 'user@host',
    remoteCwd: '/srv/app',
    command: 'ls -la',
  });
});

test('parseSshTarget parses user@host without remote path', () => {
  const parsed = parseSshTarget('user@host docker ps');
  assert.deepEqual(parsed, {
    remote: 'user@host',
    remoteCwd: undefined,
    command: 'docker ps',
  });
});

test('parseSshInvocation extracts remote from ssh bash command', () => {
  const parsed = parseSshInvocation('ssh user@host "docker ps"');
  assert.deepEqual(parsed, {
    remote: 'user@host',
    command: 'ssh user@host "docker ps"',
  });
});

test('buildRemoteCommand adds cd when remote cwd exists', () => {
  assert.equal(buildRemoteCommand('/srv/app', 'ls -la'), 'cd "/srv/app" && ls -la');
  assert.equal(buildRemoteCommand(undefined, 'ls -la'), 'ls -la');
});

test('truncateOutput marks large output as truncated', () => {
  const output = Array.from({ length: 2500 }, (_, index) => `line ${index}`).join('\n');
  const truncated = truncateOutput(output);
  assert.match(truncated, /Output truncated:/);
  assert.match(truncated, /line 0/);
});

test('ensureLogPath and logSshCall create an audit file', async () => {
  await withTempDir(async (dir) => {
    const logPath = ensureLogPath(dir, null);
    logSshCall(
      {
        remote: 'user@host',
        command: 'docker ps',
        type: 'ssh-run',
        cwd: dir,
      },
      logPath,
    );

    const content = await fs.readFile(logPath, 'utf8');
    assert.match(content, /user@host/);
    assert.match(content, /docker ps/);
    assert.match(content, /ssh-run/);
  });
});
