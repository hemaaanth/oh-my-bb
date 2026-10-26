import { spawnSync } from 'node:child_process';
let executable;
export function nodeRuntime(){
  if(executable)return executable;
  const result=spawnSync('node',['-p','JSON.stringify({executable:process.execPath,node:process.versions.node,electron:process.versions.electron||null})'],{encoding:'utf8',timeout:5000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  let identity;try{identity=JSON.parse(result.stdout);}catch{}
  if(result.status!==0||!identity?.node||identity.electron||typeof identity.executable!=='string'||!identity.executable.startsWith('/'))throw Error('A verified standalone Node interpreter is required for browser workers');
  return executable=identity.executable;
}
