import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
it('keeps an idle relay active and clears its heartbeat after disconnection', async () => {
  vi.useFakeTimers();
  const instances: Peer[] = [];
  class Peer {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1; onopen?: () => void; onclose?: () => void;
    sent: string[] = [];
    constructor(_url: URL) { instances.push(this); }
    send(message: string) { this.sent.push(message); }
  }
  const source = await readFile('browser-extension/relay.js', 'utf8');
  const connect = source.slice(source.indexOf('async function connect()'), source.indexOf('chrome.alarms.onAlarm'));
  await runInNewContext(connect + ';connect()', {
    chrome: { storage: { local: { get: async () => ({ serverUrl: 'https://example.test', token: 'fixture' }) } } },
    socket: undefined, WebSocket: Peer, URL, installation: 'fixture', run: 'fixture',
    setInterval, clearInterval, attached: new Set(),
  });
  const peer = instances[0]; peer.onopen!();
  expect(JSON.parse(peer.sent[0]).protocol).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.sent.slice(1).map(value => JSON.parse(value))).toEqual([{type:'ping'}, {type:'ping'}, {type:'ping'}]);
  peer.onclose!();
  expect(vi.getTimerCount()).toBe(0);
});
it('reloads the paired extension explicitly and preserves paused handoffs', async () => {
  vi.useFakeTimers();
  const source = await readFile('browser-extension/relay.js', 'utf8');
  const execute = source.slice(source.indexOf('async function execute(request)'), source.indexOf('async function connect()'));
  const reload = vi.fn(), sessions = new Map();
  const request = { threadId: 'fixture', argv: ['extension','reload'], deadline: Date.now()+1000 };
  sessions.set('paused', { paused: true });
  await expect(runInNewContext(execute+';execute(request)', {request, Date, sessions, setTimeout, chrome:{runtime:{reload}}})).rejects.toThrow('handoffs');
  sessions.clear();
  await expect(runInNewContext(execute+';execute(request)', {request, Date, sessions, setTimeout, chrome:{runtime:{reload}}})).resolves.toMatchObject({reloading:true});
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(reload).toHaveBeenCalledOnce();
});
