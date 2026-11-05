import {copyFile,mkdir} from 'node:fs/promises';
// The desktop viewer serves these notices at /licenses.
await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
await copyFile(new URL('../THIRD-PARTY-NOTICES',import.meta.url),new URL('../dist/desktop-licenses.txt',import.meta.url));
