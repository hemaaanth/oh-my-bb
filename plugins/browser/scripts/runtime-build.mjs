import { mkdir, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
await chmod(join(root, 'docker/trusted-browser.mjs'), 0o755);
const result = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', join(root, 'dist/runtime.tar'), '-C', root, 'package.json', 'docker', 'browser-extension', 'THIRD-PARTY-NOTICES'], { stdio: 'inherit' });
if (result.status !== 0) process.exitCode = result.status ?? 1;
