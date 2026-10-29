// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { BrowserPreferencesView } from '../src/preferences.js';
const app = await loadPluginApp(() => import('../app'));

const initial: BrowserPreferencesView = { migrationPending: false, fastApiKeyConfigured: false, values: {
  homeRouting: true, sharePersonalLogins: true, sandboxesIntegration: false,
  browserUserAgent: '', browserExitNode: 'saved-home', browserHomeEgressIp: '',
  fastRunner: false, fastEndpoint: '', fastModel: '',
} };

it('preserves saved choices during loading and unsaved edits during realtime refresh', async () => {
  const pending = Promise.withResolvers<BrowserPreferencesView>();
  let incoming = initial, first = true, fail = true;
  const slot = renderSlot(app.settingsSections.find(section => section.id === 'preferences')!, {}, { rpc: {
    browserPreferences: () => { if (first) { first = false; return pending.promise; } return incoming; },
    updateBrowserPreferences: (patch: Partial<BrowserPreferencesView['values']>) => {
      if (fail) throw Error('Fixture save failure');
      incoming = { ...incoming, values: { ...incoming.values, ...patch } }; return incoming;
    },
  } });
  try {
    expect(slot.queryByRole('switch')).toBeNull();
    await act(async () => { pending.resolve(initial); });
    const routing = await slot.findByRole('switch', { name: 'Route sandbox browsers through home' });
    expect(routing.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(routing);
    fireEvent.change(slot.getByLabelText('Home Tailscale exit node'), { target: { value: 'draft-home' } });
    incoming = { ...initial, values: { ...initial.values, browserExitNode: 'refreshed-home' } };
    await slot.behavior.emitRealtime('browser-preferences', null);
    expect(routing.getAttribute('aria-checked')).toBe('false');
    expect((slot.getByLabelText('Home Tailscale exit node') as HTMLInputElement).value).toBe('draft-home');
    fireEvent.click(slot.getByRole('button', { name: 'Save changes' }));
    await slot.findByRole('alert');
    expect((slot.getByLabelText('Home Tailscale exit node') as HTMLInputElement).value).toBe('draft-home');
    fail = false;
    fireEvent.click(slot.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(incoming.values).toMatchObject({ homeRouting: false, browserExitNode: 'draft-home', sharePersonalLogins: true }));
    await waitFor(() => expect((slot.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true));
  } finally { slot.lifecycle.unmount(); }
});

it('separates a paired source from its live relay and new-session cookie export', async () => {
  let relayConnected = false;
  const slot = renderSlot(app.settingsSections.find(section => section.id === 'more')!, {}, { rpc: {
    browserCookieStatus: () => ({ paired: true, relayConnected, lastSyncAt: null, cookies: 0, skippedPartitioned: 0, localImported: null }),
  } });
  try {
    expect(await slot.findByRole('status')).toHaveProperty('textContent', 'Regular profile: paired, but relay offline.');
    expect(slot.getByRole('button', { name: 'Replace regular profile' })).toBeTruthy();
    expect(slot.getByText(/Agent and sandbox profiles do not pair here/)).toBeTruthy();
    relayConnected = true;
    await slot.behavior.emitRealtime('browser-cookies', null);
    await waitFor(() => expect(slot.getByRole('status').textContent).toBe('Regular profile: connected.'));
  } finally { slot.lifecycle.unmount(); }
});

it('places controls in Preferences and locks fast options until a key is configured', async () => {
  const slot = renderSlot(app.settingsSections.find(section => section.id === 'preferences')!, {}, { rpc: { browserPreferences: () => initial } });
  try {
    const endpoint = await slot.findByLabelText('Fast runner OpenAI-compatible HTTPS endpoint');
    expect((endpoint as HTMLInputElement).disabled).toBe(true);
    expect((slot.getByLabelText('Allow bounded fast tasks') as HTMLButtonElement).disabled).toBe(true);
    expect(slot.getByPlaceholderText('Automatic — browser default')).toBeTruthy();
    expect(slot.queryByText('Advanced')).toBeNull();
    expect(slot.queryByText('Legacy continuous cookie sync')).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});
