import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync('docker/trusted-browser.mjs', 'utf8');
const selection = source.slice(source.indexOf('function selectedBackend('), source.indexOf('\nfunction nativeProfile('));
function select(placement: string, thread = 'thr_test', remote = false) {
  return runInNewContext(`${selection}; selectedBackend()`, {
    setting: () => 'native', usesUserspaceTailscale: () => remote,
    hyprlandSession: () => false, threadOwner: () => thread,
    wantedPlacement: () => placement,
    fail: (message: string) => { throw new Error(message); },
  });
}
it('allows a native private display without a Hyprland environment', () => {
  expect(select('private')).toBe('native');
});
it('still requires Hyprland for desktop placement and legacy sessions', () => {
  expect(() => select('desktop')).toThrow('Hyprland');
  expect(() => select('private', '')).toThrow('Hyprland');
});
it('keeps native home-routing restrictions', () => {
  expect(() => select('private', 'thr_test', true)).toThrow('local only');
});
