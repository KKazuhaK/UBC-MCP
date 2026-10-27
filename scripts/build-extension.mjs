import {copyFile} from 'node:fs/promises';
import {build} from 'esbuild';
await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'esm',target:'chrome120',outfile:'extension/popup.js',legalComments:'none'});
console.log('Built extension/popup.js');

await copyFile('LICENSE','extension/LICENSE.txt');
await copyFile('node_modules/zod/LICENSE','extension/THIRD_PARTY_NOTICES.txt');
