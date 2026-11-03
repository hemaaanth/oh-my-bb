// Explicit maintainer action. Package startup never probes a sibling package.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserRuntime } from '../docker/verify-browser-runtime.mjs';
const repository = process.argv[2];
if (!repository) throw Error('Usage: node scripts/update-browser-runtime.mjs <repository> [committed-ref]');
const git = args => execFileSync('git', ['-C', resolve(repository), ...args], { maxBuffer: 32 * 1024 * 1024 });
const commit = git(['rev-parse', '--verify', `${process.argv[3] || 'HEAD'}^{commit}`]).toString().trim();
const source = 'plugins/browser';
const tree = git(['rev-parse', `${commit}:${source}`]).toString().trim();
const temporary = mkdtempSync(join(tmpdir(), 'bb-browser-artifact-'));
const directory = fileURLToPath(new URL('../docker/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  execFileSync('tar', ['-xf', '-', '-C', temporary], { input: git(['archive', commit, source]) });
  const root = join(temporary, source);
  const names = ['package.json', 'docker', 'browser-extension', 'THIRD-PARTY-NOTICES', 'LICENSE'];
  const inputs = {};
  const visit = name => {
    const path = join(root, name), stat = statSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(`${name}/${child}`);
    else inputs[name] = { mode: stat.mode & 0o777, sha256: hash(readFileSync(path)) };
  };
  names.forEach(visit);
  const archive = execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', root, ...names], { maxBuffer: 16 * 1024 * 1024 });
  const receipt = {
    schemaVersion: 1, packageName: 'bb-plugin-browser', version: JSON.parse(readFileSync(join(root, 'package.json'))).version,
    sourceRepository: 'https://github.com/hemaaanth/oh-my-bb', sourceCommit: commit, sourcePackageTree: tree,
    buildRecipe: 'gnu-tar-sort-name-mtime-0-owner-0-v1',
    inputsSha256: hash(Object.keys(inputs).sort().map(name => `${name}\0${inputs[name].mode}\0${inputs[name].sha256}\n`).join('')),
    archiveSha256: hash(archive), inputs,
  };
  writeFileSync(join(directory, 'browser-runtime.tar'), archive);
  writeFileSync(join(directory, 'browser-runtime.provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
  verifyBrowserRuntime(directory);
  const path = join(directory, 'browser-runtime.compatibility.json');
  const compatibility = JSON.parse(readFileSync(path));
  const identity = { sourceCommit: commit, inputsSha256: receipt.inputsSha256, archiveSha256: receipt.archiveSha256 };
  if (!compatibility.artifacts.some(item => item.archiveSha256 === identity.archiveSha256)) compatibility.artifacts.push(identity);
  writeFileSync(path, JSON.stringify(compatibility, null, 2) + '\n');
  console.log(JSON.stringify(identity));
} finally { rmSync(temporary, { recursive: true, force: true }); }
