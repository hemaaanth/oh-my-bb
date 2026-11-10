import {execFile} from 'node:child_process';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';

export type ConnectStatus=()=>Promise<string>;

/** Called only on explicit viewer issue, never during plugin registration. */
export async function viewerOrigins(bb:BbPluginApi,connect?:ConnectStatus){
 const read=connect??(()=>{
  const {promise,resolve,reject}=Promise.withResolvers<string>();
  execFile(process.env.BB_CLI||'bb',['connect','status','--json'],{timeout:15000,maxBuffer:1024*1024,env:{...process.env,BB_SERVER_URL:bb.server.loopbackBaseUrl}},(error,stdout)=>error?reject(error):resolve(stdout));
  return promise;
 });
 const status=z.object({state:z.string(),url:z.string().nullable().optional()}).parse(JSON.parse(await read()));
 const values=[bb.server.loopbackBaseUrl,bb.server.experimental_appUrl,...status.state==='connected'?[status.url]:[]];
 return [...new Set(values.filter((value):value is string=>!!value).map(value=>{
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid BB viewer origin');
  return url.origin;
 }))];
}
