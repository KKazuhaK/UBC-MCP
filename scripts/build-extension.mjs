import {build} from 'esbuild';
await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'esm',target:'chrome120',outfile:'extension/popup.js',legalComments:'none'});
console.log('Built extension/popup.js');
