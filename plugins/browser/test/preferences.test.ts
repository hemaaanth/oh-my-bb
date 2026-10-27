import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { afterEach, expect, it, vi } from 'vitest';
import plugin from '../src/server.js';
import { loadBrowserSettings, preferencesContract, type BrowserSettingsStore } from '../src/preferences.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of close.splice(0)) await dispose(); });
const parse = preferencesContract.browserPreferences.output;

it('moves saved behavior out of native Configuration without moving keys or authentication files', async () => {
  let fake = createFakePluginHost({ pluginId: 'browser', experimental_hostEntry: true, settings: {
    sandboxesIntegration: false, homeRouting: true, sharePersonalLogins: true,
    browserExitNode: 'fixture-home', browserHomeEgressIp: '198.51.100.9',
    browserUserAgent: 'Fixture browser', legacyLiveSync: true,
    fastRunner: true, fastEndpoint: 'https://model.example.test/v1', fastModel: 'fixture/model',
    browserTailscaleAuthKey: 'fixture-private-key', fastApiKey: 'fixture-model-key',
    browserTailscaleAuthKeyFile: '/fixture/enrollment-key', browserStateFile: '/fixture/authentication.json',
  } });
  close.push(() => fake.harness.lifecycle.dispose());
  let settings: BrowserSettingsStore;
  const factory = async (bb: typeof fake.bb) => { settings = await loadBrowserSettings(bb); };
  await factory(fake.bb);
  const before = parse.parse(await fake.harness.behavior.callRpc('browserPreferences', null));
  expect(before).toMatchObject({ migrationPending: true, values: { sandboxesIntegration: false, homeRouting: true, sharePersonalLogins: true, fastRunner: true, browserExitNode: 'fixture-home' } });
  expect(JSON.stringify(before)).not.toMatch(/fixture-private-key|fixture-model-key|enrollment-key|authentication.json/);
  await fake.harness.behavior.callRpc('updateBrowserPreferences', { homeRouting: false, browserExitNode: 'changed-home' });
  await fake.harness.behavior.setSettings({ browserUserAgent: 'Changed browser', fastApiKey: 'replacement-model-key' });
  fake = await fake.harness.lifecycle.reload(factory);
  const after = parse.parse(await fake.harness.behavior.callRpc('browserPreferences', null));
  expect(after).toMatchObject({ migrationPending: false, values: { sandboxesIntegration: false, homeRouting: false, browserExitNode: 'changed-home', browserUserAgent: 'Changed browser', sharePersonalLogins: true, fastRunner: true } });
  expect(Object.keys(fake.harness.registrations.settingsDescriptors).sort()).toEqual(['browserStateFile', 'browserTailscaleAuthKey', 'browserTailscaleAuthKeyFile', 'fastApiKey']);
  await expect(fake.harness.behavior.setSettings({ homeRouting: true })).rejects.toThrow('unknown setting');
  expect(await settings!.get()).toMatchObject({ browserTailscaleAuthKey: 'fixture-private-key', fastApiKey: 'replacement-model-key', browserStateFile: '/fixture/authentication.json' });
});

it('merges concurrent edits and persists consent independently of old native values', async () => {
  let fake = createFakePluginHost({ pluginId: 'browser', experimental_hostEntry: true });
  close.push(() => fake.harness.lifecycle.dispose());
  await plugin(fake.bb);
  await Promise.all([
    fake.harness.behavior.callRpc('updateBrowserPreferences', { homeRouting: true, browserExitNode: 'fixture-home' }),
    fake.harness.behavior.callRpc('updateBrowserPreferences', { sharePersonalLogins: true, sandboxesIntegration: true }),
  ]);
  fake = await fake.harness.lifecycle.reload(plugin);
  expect(parse.parse(await fake.harness.behavior.callRpc('browserPreferences', null)).values).toMatchObject({ homeRouting: true, browserExitNode: 'fixture-home', sharePersonalLogins: true, sandboxesIntegration: true });
  await fake.harness.behavior.callRpc('updateBrowserPreferences', { sandboxesIntegration: false });
  fake = await fake.harness.lifecycle.reload(plugin);
  expect(parse.parse(await fake.harness.behavior.callRpc('browserPreferences', null)).values.sandboxesIntegration).toBe(false);
});

it('rejects credential writes and invalid preference patches without changing saved behavior', async () => {
  const fake = createFakePluginHost({ pluginId: 'browser', experimental_hostEntry: true });
  close.push(() => fake.harness.lifecycle.dispose());
  await plugin(fake.bb);
  const before = await fake.harness.behavior.callRpc('browserPreferences', null);
  for (const patch of [{ fastApiKey: 'not-a-preference' }, { homeRouting: 'yes' }, { unknown: true }]) {
    await expect(fake.harness.behavior.callRpc('updateBrowserPreferences', patch)).rejects.toThrow();
    expect(await fake.harness.behavior.callRpc('browserPreferences', null)).toEqual(before);
  }
  vi.spyOn(fake.bb.storage.kv, 'set').mockRejectedValueOnce(Error('Fixture write failure'));
  await expect(fake.harness.behavior.callRpc('updateBrowserPreferences', { homeRouting: true })).rejects.toThrow('Fixture write failure');
  expect(await fake.harness.behavior.callRpc('browserPreferences', null)).toEqual(before);
  expect(parse.parse(await fake.harness.behavior.callRpc('updateBrowserPreferences', { browserExitNode: 'fixture-recovered' })).values.browserExitNode).toBe('fixture-recovered');
});

it('refuses fast-task configuration without a private key and exposes only readiness', async () => {
  const fake = createFakePluginHost({ pluginId: 'browser', experimental_hostEntry: true });
  close.push(() => fake.harness.lifecycle.dispose());
  await plugin(fake.bb);
  expect(await fake.harness.behavior.callRpc('browserPreferences', null)).toMatchObject({ fastApiKeyConfigured: false });
  for (const patch of [{ fastRunner: true }, { fastModel: 'fixture-model' }, { fastEndpoint: 'https://fixture.invalid' }]) {
    await expect(fake.harness.behavior.callRpc('updateBrowserPreferences', patch)).rejects.toThrow('API key');
  }
  await fake.harness.behavior.setSettings({ fastApiKey: 'fixture-private-key' });
  const view = await fake.harness.behavior.callRpc('browserPreferences', null);
  expect(view).toMatchObject({ fastApiKeyConfigured: true });
  expect(JSON.stringify(view)).not.toContain('fixture-private-key');
  await expect(fake.harness.behavior.callRpc('updateBrowserPreferences', { fastRunner: true })).resolves.toMatchObject({ values: { fastRunner: true } });
});
