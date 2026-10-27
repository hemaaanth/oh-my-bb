import {rolldown} from 'rolldown';
import {copyFile} from 'node:fs/promises';
const bundle=await rolldown({input:new URL('../src/desktop-client.ts',import.meta.url).pathname,platform:'browser'});
try{await bundle.write({file:new URL('../dist/desktop-client.js',import.meta.url).pathname,format:'esm',minify:true});}finally{await bundle.close();}
await copyFile(new URL('../THIRD-PARTY-NOTICES',import.meta.url),new URL('../dist/desktop-licenses.txt',import.meta.url));
