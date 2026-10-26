import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../docker/session-events.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');

async function monitor({held = false, idle = false, native = false, dead = false, replaced = false, busy = false, refreshed = false} = {}) {
  const killed: Array<[number, string]> = [], removed: string[] = [], written: string[] = [];
  const released: string[][] = [], closed = Promise.withResolvers<void>();
  let reads = 0;
  let scan: (() => Promise<void>) | undefined;
  const record = {pid: 123, start: '42', port: 9000, session: 'fixture', networkGeneration:'a'.repeat(32), native, ownerRecord: '/owner', targetIds: [], lastUsed: Date.now() - (idle ? 31 * 60_000 : 0)};
  // /proc stat: 2 GiB RSS and 20 CPU minutes used by an otherwise healthy browser.
  const fields = Array(22).fill('0');
  fields[0] = dead ? 'Z' : 'S'; fields[1] = '1'; fields[11] = '120000'; fields[19] = '42'; fields[21] = String(2 * 1024 ** 3 / 4096);
  class Socket {
    onopen?: () => void;
    onmessage?: (event: {data: string}) => void;
    onclose?: () => void;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(text: string) {
      const request = JSON.parse(text);
      queueMicrotask(() => this.onmessage?.({data: JSON.stringify({id: request.id, result: {targetInfos: []}})}));
    }
    close() {this.onclose?.();}
  }
  await runInNewContext(`(async () => { ${source} })()`, {
    process: {argv: ['node', 'monitor', '/session', '/home', 'thr_fixture'], pid: 456, kill: (pid: number, signal: string) => killed.push([pid, signal]), on() {}, exit() {closed.resolve();}},
    readFile: async (path: string) => {
      if (path.endsWith('/session.json')) {
        reads++;
        return JSON.stringify(replaced && reads > 1 ? {...record,session:'replacement',networkGeneration:'b'.repeat(32)} : refreshed && reads > 2 ? {...record,lastUsed:Date.now()} : record);
      }
      if (path === '/owner') return JSON.stringify(record);
      if (path === '/home/network-service') return 'sandboxes-v1';
      if (path === '/proc/123/stat') return `123 (browser) ${fields.join(' ')}`;
      throw Error('ENOENT');
    },
    readdir: async () => ['123'],
    writeFile: async (path: string) => {written.push(path);}, rename: async () => {},
    mkdir: async () => {if(busy)throw Object.assign(Error('busy'),{code:'EEXIST'});},
    rm: async (path: string) => {removed.push(path);},
    stat: async () => {if (!held) throw Error('ENOENT'); return {mtimeMs: Date.now()};},
    join: (...parts: string[]) => parts.join('/'),
    fetch: async () => ({json: async () => ({webSocketDebuggerUrl: 'ws://fixture'})}),
    WebSocket: Socket, AbortSignal, Promise, queueMicrotask,
    spawnSync: (_command:string, args:string[]) => {released.push(JSON.parse(Buffer.from(args.at(-1)!, 'base64url').toString()).argv);}, Buffer,
    setTimeout: (fn: () => void, ms: number) => {if (ms === 1000) queueMicrotask(fn); return 1;},
    clearTimeout() {}, clearInterval() {},
    setInterval: (fn: () => Promise<void>) => {scan = fn; return 1;},
  });
  // Exercise subsequent watchdog scans as well as startup.
  if (!killed.length) await scan?.();
  if (dead) {await closed.promise; return {released};}
  return {killed, removed, written};
}

it('keeps a healthy isolated browser above the former RSS and lifetime CPU caps', async () => {
  expect(await monitor()).toEqual({killed: [], removed: [], written: []});
});
it('keeps an active manual handoff even when agent activity is older than idle retention', async () => {
  expect(await monitor({idle: true, held: true})).toEqual({killed: [], removed: [], written: []});
});
it('still reaps an idle isolated browser without an active handoff', async () => {
  const result = await monitor({idle: true});
  expect(result.killed).toContainEqual([123, 'SIGTERM']);
  expect(result.removed).toContain('/session/session.json');
});
it('does not reap the native shared browser', async () => {
  expect(await monitor({native: true, idle: true})).toEqual({killed: [], removed: [], written: []});
});
it('releases only the dead browser generation after a replacement appears', async () => {
  expect(await monitor({dead:true,replaced:true})).toEqual({released:[['network','release','a'.repeat(32)]]});
});
it('does not reap a session while a browser command owns its lock', async () => {
  expect(await monitor({idle:true,busy:true})).toEqual({killed:[],removed:[],written:[]});
});
it('rechecks recent activity under the session lock before reaping', async () => {
  expect((await monitor({idle:true,refreshed:true})).killed).toEqual([]);
});
it('leaves renderer memory and process allocation to Chromium', () => {
  const launch = readFileSync(new URL('../docker/session.mjs', import.meta.url), 'utf8');
  expect(launch).not.toContain('--js-flags=--max-old-space-size=512');
  expect(launch).not.toContain('--renderer-process-limit=4');
});
