import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { expect, it } from 'vitest';
import { provisionTrustedBrowser } from '../src/trusted-browser.js';

it('replaces a stale executable, preserves its files, and reuses a matching runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-upgrade-'));
  const bin = join(root, 'bin'), old = join(root, 'old');
  const fake = createFakePluginHost({ pluginId: 'sandboxes', sdk: { plugins: { callRpc: async () => ({}) } } });
  let transfers = 0;
  try {
    await mkdir(bin); await mkdir(join(old, 'docker'), { recursive: true });
    const prior = join(old, 'docker/trusted-browser.mjs');
    await writeFile(prior, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await symlink(prior, join(bin, 'bb-browser'));
    const executor = { exec: async (request: { command: string[]; stdin: string }) => {
      if (request.command[0] === 'bb-browser') return { exitCode: 0 };
      let command = request.command[2].replaceAll('/opt/bb-browser', join(root, 'opt')).replaceAll('/usr/local/bin/bb-browser', join(bin, 'bb-browser'));
      if (command.includes('base64 -d >>')) transfers++;
      const result = spawnSync('sh', ['-c', command], { input: request.stdin, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
      return { exitCode: result.status ?? 1 };
    } };
    const input = { bb: fake.bb, hostId: 'fixture', enabled: true, signal: new AbortController().signal, executor, report: { log: () => {} } };
    await provisionTrustedBrowser(input as never);
    expect(transfers).toBeGreaterThan(0);
    expect(await readlink(join(bin, 'bb-browser'))).toContain('/opt/runtimes/');
    expect(await readFile(prior, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    const before = transfers;
    await provisionTrustedBrowser(input as never);
    expect(transfers).toBe(before);
  } finally {
    await fake.harness.lifecycle.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
