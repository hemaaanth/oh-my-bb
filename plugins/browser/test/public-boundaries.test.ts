import { createFakePluginHost, makeHostResponse, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { afterEach, expect, it } from 'vitest';
import plugin from '../src/server.js';

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of dispose.splice(0)) await close(); });

it('keeps fresh installs inert and refuses sandbox preparation without consent', async () => {
  const fake = createFakePluginHost({ pluginId: 'browser', experimental_hostEntry: true });
  dispose.push(() => fake.harness.lifecycle.dispose());
  await plugin(fake.bb);
  await fake.harness.behavior.runSchedule('browser-settings');
  await expect(fake.harness.behavior.runSchedule('browser-cookie-sync')).rejects.toThrow('no schedule');
  await expect(fake.harness.behavior.callRpc('prepareSandboxV1', { hostId: 'sandbox_fixture' }, {
    experimental_caller: { kind: 'plugin', pluginId: 'sandboxes' },
  })).rejects.toThrow('Enable Sandboxes integration');
  expect(fake.harness.inspection.sdk.callsTo('plugins.callRpc')).toEqual([]);
  expect(fake.harness.inspection.sdk.callsTo('hosts.list')).toEqual([]);
  expect(fake.harness.experimental_hostRpcCalls).toEqual([]);
});

it('preserves saved routing consent but respects a later explicit integration opt-out', async () => {
  let fake = createFakePluginHost({ pluginId: 'browser', experimental_hostEntry: true,
    settings: { homeRouting: true, browserExitNode: 'fixture-home' },
    sdk: { plugins: { callRpc: async ({ method }) => {
      if (method === 'browserLegacyV1') throw Error('No legacy state');
      if (method === 'browserAccessV1') return { allowed: true } as never;
      throw Error('Unexpected RPC');
    } } },
  });
  dispose.push(() => fake.harness.lifecycle.dispose());
  await plugin(fake.bb);
  const prepare = () => fake.harness.behavior.callRpc('prepareSandboxV1', { hostId: 'sandbox_fixture' }, {
    experimental_caller: { kind: 'plugin', pluginId: 'sandboxes' },
  });
  expect(await prepare()).toMatchObject({ egress: 'home', exitNode: 'fixture-home', state: null });
  await fake.harness.behavior.setSettings({ sandboxesIntegration: false });
  await expect(prepare()).rejects.toThrow('Enable Sandboxes integration');
  fake = await fake.harness.lifecycle.reload(plugin);
  await expect(prepare()).rejects.toThrow('Enable Sandboxes integration');
});

it('refuses an unapproved sandbox handoff without discarding the existing session', async () => {
  const fake = createFakePluginHost({
    pluginId: 'browser', experimental_hostEntry: true,
    experimental_callHostRpc: async () => ({ ok: true }),
    sdk: {
      threads: { get: async () => makeThreadResponse({ id: 'thr_fixture', environmentId: 'env_fixture' }) },
      environments: { get: async () => ({ hostId: 'host_fixture' }) as never },
      hosts: { get: async () => makeHostResponse({ id: 'host_fixture', machineProviderId: 'sandbox-fixture' }) },
      plugins: { callRpc: async () => null as never },
    },
  });
  dispose.push(() => fake.harness.lifecycle.dispose());
  await plugin(fake.bb);
  await expect(fake.harness.behavior.callAgentTool('browser_handoff', {
    reason: 'login', instructions: 'Use the synthetic account.',
  }, { threadId: 'thr_fixture' })).rejects.toThrow('Enable Sandboxes integration');
  expect(fake.harness.experimental_hostRpcCalls).toEqual([]);
  for (const call of fake.harness.inspection.sdk.callsTo('plugins.callRpc')) {
    expect(call[0]).toMatchObject({ method: 'browserHoldV1', input: { held: false } });
  }
});
