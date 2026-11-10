import {registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createFakePluginHost,makeHostResponse,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import ts from 'typescript';

// Node runs the package's actual TypeScript without a build or a sibling import.
registerHooks({resolve(specifier,context,next){
 try{return next(specifier,context);}catch(error){
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){
   const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
   if(existsSync(fileURLToPath(source)))return next(source.href,context);
  }
  throw error;
 }
},load(url,context,next){
 if(url.endsWith('.ts'))return {format:'module',source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,shortCircuit:true};
 return next(url,context);
}});
const {registerDesktops}=await import('../../src/desktop.ts');
const host=makeHostResponse({id:'host_fixture',machineProviderId:null,status:'connected'}),thread=makeThreadResponse({id:'thr_fixture',environmentId:'env_fixture'});
const calls=[],holds=new Set();let sessionLive=false,failClose=true,failOpen=true;
const fake=createFakePluginHost({pluginId:'sandboxes',experimental_hostEntry:true,sdk:{threads:{get:async()=>thread},environments:{get:async()=>({hostId:host.id})},hosts:{get:async()=>host}},experimental_callHostRpc:async({method})=>{
 calls.push(method);
 if(method==='openDesktop'){sessionLive=true;if(failOpen)throw Error('Open acknowledgement lost');return {port:41234,expires:Date.now()+900000};}
 if(method==='closeDesktop'){if(failClose)throw Error('Close acknowledgement lost');sessionLive=false;}
 return null;
}});
registerDesktops(fake.bb,()=>({hold:(_host,key)=>holds.add(key),release:(_host,key)=>holds.delete(key)}),async(args)=>args[1]==='status'?JSON.stringify({state:'connected',url:'https://owner.getbb.app'}):'{}');
let closing=false;
process.on('message',async request=>{
 try{
  let result;
  if(request.method==='inspect')result={calls:[...calls],sessionLive,holds:[...holds]};
  else if(request.method==='allowClose'){failClose=false;result=null;}
  else if(request.method==='openNormally'){failOpen=false;result=null;}
  else if(request.method==='dispose'){closing=true;failClose=false;await fake.harness.lifecycle.dispose();process.send({id:request.id,result:null},()=>process.disconnect());return;}
  else result=await fake.harness.behavior.callRpc(request.method,request.input,{experimental_caller:{kind:'plugin',pluginId:'browser'}});
  process.send({id:request.id,result});
 }catch(error){process.send({id:request.id,error:error.message});}
});
process.on('disconnect',()=>{if(!closing){failClose=false;void fake.harness.lifecycle.dispose();}});
process.send({ready:true});
