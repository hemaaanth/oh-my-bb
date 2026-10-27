import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** The reviewed receipt is the trust root, not the archive's version string. */
export function verifyBrowserRuntime(directory) {
  const receipt = JSON.parse(readFileSync(join(directory, 'browser-runtime.provenance.json'), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.packageName !== 'bb-plugin-browser' ||
      receipt.sourceRepository !== 'https://github.com/hemaaanth/oh-my-bb' ||
      !commit(receipt.sourceCommit) || !commit(receipt.sourcePackageTree) ||
      receipt.buildRecipe !== 'gnu-tar-sort-name-mtime-0-owner-0-v1' ||
      !sha(receipt.archiveSha256) || !sha(receipt.inputsSha256) ||
      !receipt.inputs || typeof receipt.inputs !== 'object') throw new Error('Unverified Browser runtime provenance receipt');
  const archive = join(directory, 'browser-runtime.tar');
  if (!lstatSync(archive).isFile()) throw new Error('Browser runtime must be an independent package artifact, not a sibling symlink');
  if (hash(readFileSync(archive)) !== receipt.archiveSha256) throw new Error('Browser runtime archive SHA-256 does not match its reviewed receipt');
  const names = Object.keys(receipt.inputs).sort();
  const manifest = names.map(name => {
    const entry = receipt.inputs[name];
    if (!name || name.startsWith('/') || name.split('/').some(part => part === '..') || !sha(entry.sha256) || !Number.isInteger(entry.mode)) throw new Error('Invalid Browser runtime input manifest');
    return `${name}\0${entry.mode}\0${entry.sha256}\n`;
  }).join('');
  if (hash(manifest) !== receipt.inputsSha256) throw new Error('Browser runtime build inputs do not match their reviewed digest');
  const list = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n').filter(name => !name.endsWith('/')).sort();
  if (JSON.stringify(list) !== JSON.stringify(names)) throw new Error('Browser runtime archive file set differs from the reviewed inputs');
  for (const name of names) {
    const bytes = execFileSync('tar', ['-xOf', archive, '--', name], { maxBuffer: 8 * 1024 * 1024 });
    if (hash(bytes) !== receipt.inputs[name].sha256) throw new Error(`Browser runtime input mismatch: ${name}`);
  }
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package.json'], { encoding: 'utf8' }));
  if (pkg.name !== receipt.packageName || pkg.version !== receipt.version) throw new Error('Browser runtime package identity differs from the receipt');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = verifyBrowserRuntime(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  for (const [name, field] of [['BROWSER_SOURCE_COMMIT', 'sourceCommit'], ['BROWSER_INPUTS_SHA256', 'inputsSha256'], ['BROWSER_ARCHIVE_SHA256', 'archiveSha256']]) {
    if (process.env[name] !== undefined && process.env[name] !== receipt[field]) throw new Error(`Browser build argument ${name} differs from the reviewed artifact`);
  }
  process.stdout.write(JSON.stringify({ sourceCommit: receipt.sourceCommit, inputsSha256: receipt.inputsSha256, archiveSha256: receipt.archiveSha256 }) + '\n');
}
