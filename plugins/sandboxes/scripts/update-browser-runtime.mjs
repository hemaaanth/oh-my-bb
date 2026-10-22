import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const source=process.argv[2];
if(!source)throw Error('Usage: npm run browser:runtime -- /path/to/browser/dist/runtime.tar');
const target=fileURLToPath(new URL('../docker/browser-runtime.tar',import.meta.url));
const bytes=await readFile(source);
await copyFile(source,target);
await writeFile(new URL('../docker/browser-runtime.json',import.meta.url),JSON.stringify({sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
