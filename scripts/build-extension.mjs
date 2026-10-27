import {copyFile} from 'node:fs/promises';
import {build} from 'esbuild';
await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'esm',target:'chrome120',outfile:'extension/popup.js',legalComments:'none'});
await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'esm',target:'chrome120',outfile:'extension/background.js',legalComments:'none'});
await build({entryPoints:['src/collector/hub-link.ts'],bundle:true,platform:'browser',format:'iife',target:'chrome120',outfile:'extension/hub-link.js',legalComments:'none'});
console.log('Built extension popup, background and Hub authorization bridge');

await copyFile('LICENSE','extension/LICENSE.txt');
await copyFile('node_modules/zod/LICENSE','extension/THIRD_PARTY_NOTICES.txt');
