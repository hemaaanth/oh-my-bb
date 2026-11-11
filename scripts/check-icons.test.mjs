import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = new URL('./check-icons.mjs', import.meta.url).pathname;
test('icon guard allows host rendering and rejects direct imports and dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-icon-contract-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bb-plugin-fixture' }));
    writeFileSync(join(dir, 'app.tsx'), 'import { experimental_Icon } from "@get-bb/plugin-sdk/app";');
    assert.equal(spawnSync(process.execPath, [script, dir]).status, 0);
    writeFileSync(join(dir, 'app.tsx'), 'import { HugeiconsIcon } from "@hugeicons/react";');
    assert.notEqual(spawnSync(process.execPath, [script, dir]).status, 0);
    writeFileSync(join(dir, 'app.tsx'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@hugeicons/react': '*' } }));
    assert.notEqual(spawnSync(process.execPath, [script, dir]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
