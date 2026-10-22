// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

it('shows connection and sync health, disables unavailable export, and opens settings', async () => {
  document.body.innerHTML = (await readFile('browser-extension/popup.html','utf8')).split('<body class="popup">')[1].split('</body>')[0];
  let state = {paired:true,cookieExport:true,relay:'connected',syncState:'synced',lastSyncAt:Date.now(),cookieCount:12};
  const sendMessage = vi.fn(async () => state), openOptionsPage = vi.fn();
  let refresh: (() => Promise<void>) | undefined;
  runInNewContext(await readFile('browser-extension/popup.js','utf8'), {
    document,Date,chrome:{runtime:{sendMessage,openOptionsPage}},setInterval:(fn: typeof refresh) => {refresh=fn;},
  });
  await waitFor(() => expect(document.querySelector('#health')!.textContent).toBe('Connected to BB'));
  expect(document.querySelector('#detail')!.textContent).toBe('12 cookies exported.');
  expect((document.querySelector('#sync') as HTMLButtonElement).disabled).toBe(false);
  document.querySelector<HTMLButtonElement>('#sync')!.click();
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({type:'sync'}));
  state={...state,relay:'disconnected',syncState:'error'};
  await refresh!();
  expect(document.querySelector('#health')!.textContent).toBe('Needs attention');
  expect(document.querySelector('#export')!.textContent).toBe('Sync failed');
  expect(document.querySelector('#last')!.textContent).not.toBe('Never');
  state={...state,cookieExport:false};await refresh!();
  expect((document.querySelector('#sync') as HTMLButtonElement).disabled).toBe(true);
  state={...state,paired:false};await refresh!();
  expect(document.querySelector('#health')!.textContent).toBe('Not paired');
  expect(document.querySelector('#detail')!.textContent).toContain('without pairing');
  document.querySelector<HTMLButtonElement>('#settings')!.click();
  expect(openOptionsPage).toHaveBeenCalledOnce();
});
