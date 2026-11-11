#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, process.argv[2]);
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
for (const deps of [manifest.dependencies, manifest.devDependencies]) {
  for (const name of Object.keys(deps ?? {})) assert.doesNotMatch(name, /^(?:@hugeicons\/|lucide-react$)/, `${dir}: use the host icon renderer`);
}
function scan(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'vendor', '.git', 'coverage'].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (/\.[cm]?[jt]sx?$/.test(file) && !entry.name.endsWith('.generated.ts')) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:from\s*|import\s*\()\s*['"](?:@hugeicons\/|lucide-react)/, file);
    }
  }
}
scan(dir);
const wrapper = join(dir, 'components/ui/icon.tsx');
if (existsSync(wrapper)) {
  const source = readFileSync(wrapper, 'utf8');
  assert.match(source, /experimental_Icon/, wrapper);
  const guestPath = join(dir, 'public-icons.json');
  if (existsSync(guestPath)) {
    const guestIcons = JSON.parse(readFileSync(guestPath, 'utf8'));
    for (const match of source.matchAll(/"\w+": "([^"]+)"/g)) {
      assert.ok(guestIcons[match[1]], `Guest icon adapter is missing ${match[1]}`);
    }
  }
  for (const match of source.matchAll(/"([a-z0-9-]+)\/([a-z0-9-]+)"/g)) {
    const id = manifest.name.replace(/^bb-plugin-/, '');
    assert.equal(match[1], id);
    const asset = manifest.bb.branding.experimental_icons?.[match[2]];
    assert.ok(asset, match[0]);
    assert.match(readFileSync(join(dir, asset), 'utf8'), /<svg\b/);
  }
}
console.log(`Shared icon contract passed: ${process.argv[2]}`);
