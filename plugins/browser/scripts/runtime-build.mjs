import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
await chmod(join(root, 'docker/trusted-browser.mjs'), 0o755);
// BB's virtual Zod locale source includes the build machine's absolute path.
for (const bundle of ['server', 'host']) {
  const file = join(root, 'dist', `${bundle}.js.map`);
  const map = JSON.parse(await readFile(file, 'utf8'));
  const prefix = `bb-zod-locale-stub:${root}`;
  map.sources = map.sources.map(source => source.startsWith(prefix) ? `bb-zod-locale-stub:${source.slice(prefix.length)}` : source);
  if (JSON.stringify(map).includes(root)) throw new Error('Source map contains the build directory');
  await writeFile(file, JSON.stringify(map) + '\n');
}
const result = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', join(root, 'dist/runtime.tar'), '-C', root, 'package.json', 'docker', 'browser-extension', 'THIRD-PARTY-NOTICES', 'LICENSE'], { stdio: 'inherit' });
if (result.status !== 0) process.exitCode = result.status ?? 1;
