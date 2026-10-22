import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { registerRelay } from "../src/relay.js";
import { BrowserCookieConnection } from "../src/browser-cookie-connection.js";
import { browserExtensionOrigin } from "../src/browser-extension-download.js";
import { browserSettingDescriptors } from "../src/config.js";
const dispose:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of dispose.splice(0))await fn();});
async function setup(){const fake=createFakePluginHost({pluginId:'browser',sdk:{threads:{get:async()=>null as never}}});dispose.push(()=>fake.harness.lifecycle.dispose());const settings=fake.bb.settings.define(browserSettingDescriptors);const cookies=new BrowserCookieConnection(fake.bb,'/nonexistent/fixture');const token='t'.repeat(43);await fake.bb.storage.kv.set('browser-cookie-connection',{tokenHash:createHash('sha256').update(token).digest('hex'),lastSyncAt:null,cookies:0,skippedPartitioned:0,localImported:null});registerRelay(fake.bb,cookies,()=>settings.get());const origin=await browserExtensionOrigin();const open=()=>fake.harness.behavior.experimental_openWebSocket('/relay',{headers:{origin}});const command=(argv:string[],threadId='thr_a')=>fake.harness.behavior.runCli([Buffer.from(JSON.stringify({argv})).toString('base64url')],{threadId});return {...fake,token,open,command};
}
it('rejects unauthenticated extension messages and revoked pairing',async()=>{
 const {open,token,command,bb}=await setup();const bad=await open();await bad.receive(JSON.stringify({token:'wrong',protocol:1,installation:'installation-fixture',run:'run-fixture'}));expect(bad.closeCalls).toEqual([{code:1008,reason:"Invalid or unauthorized relay"}]);
 const socket=await open();await socket.receive(JSON.stringify({token,protocol:1,installation:'installation-fixture',run:'run-fixture'}));
 await bb.storage.kv.delete('browser-cookie-connection');expect((await command(['observe'])).stderr).toContain('revoked');expect(socket.sent).toEqual([]);
});
it('pins browser-run identity and sends only the requesting thread context',async()=>{
 const {open,token,command,bb}=await setup();const socket=await open();await socket.receive(JSON.stringify({token,protocol:1,installation:'installation-fixture',run:'run-fixture'}));
 await bb.storage.kv.set('relay:thr_a','installation-fixture:previous-run');
 expect((await command(['click','#submit'])).stderr).toContain('restarted');expect(socket.sent).toEqual([]);
 const pending=command(['observe'],'thr_b');
 await Promise.resolve();await Promise.resolve();
 // Wait for the command's own send, not a fixed transport delay.
 await expect.poll(()=>socket.sent.length).toBe(1);
 const request=JSON.parse(socket.sent[0] as string);expect(request.threadId).toBe('thr_b');
 await socket.receive(JSON.stringify({id:request.id,result:{revision:'fixture',controls:[]}}));expect((await pending).exitCode).toBe(0);
});
