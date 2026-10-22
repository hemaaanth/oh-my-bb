import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect,it } from 'vitest';
it('runs worker code with standalone Node even when the embedding host has another executable',()=>{
 const module=fileURLToPath(new URL('../docker/node-runtime.mjs',import.meta.url));
 const code=`import {nodeRuntime} from ${JSON.stringify('file://'+module)};import {execFileSync} from 'node:child_process';Object.defineProperty(process,'execPath',{value:'/nonexistent/packaged-host'});console.log(execFileSync(nodeRuntime(),['-p','JSON.stringify({node:!!process.versions.node,electron:!!process.versions.electron})'],{encoding:'utf8'}));`;
 const result=execFileSync('node',['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});
 expect(JSON.parse(result)).toEqual({node:true,electron:false});
});
