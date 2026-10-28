import {build} from 'esbuild';
import {define} from './release-config.mjs';
import {mkdir,readFile,writeFile,copyFile,cp} from 'node:fs/promises';
const out='.data/firefox-extension';await mkdir(out,{recursive:true});
const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));
manifest.background={scripts:['background.js']};
manifest.browser_specific_settings={gecko:{id:process.env.UBC_FIREFOX_ADDON_ID||'ubc-course-capture@mcp.kazuhahub.com',strict_min_version:'142.0',data_collection_permissions:{required:['authenticationInfo','websiteContent']}}};
await writeFile(out+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');
await copyFile('extension/popup.html',out+'/popup.html');
await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'esm',target:'firefox142',outfile:out+'/popup.js',legalComments:'none',define});
console.log('Prepared Firefox submission directory: '+out+' (unsigned; signing required for persistent installation)');

await copyFile('LICENSE',out+'/LICENSE.txt');
await copyFile('node_modules/zod/LICENSE',out+'/THIRD_PARTY_NOTICES.txt');

await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',target:'firefox142',outfile:out+'/background.js',legalComments:'none',define});
await build({entryPoints:['src/collector/hub-link.ts'],bundle:true,platform:'browser',format:'iife',target:'firefox142',outfile:out+'/hub-link.js',legalComments:'none',define});

await build({entryPoints:['src/collector/auto-sync.ts'],bundle:true,platform:'browser',format:'iife',target:'firefox142',outfile:out+'/auto-sync.js',legalComments:'none',define});

await cp(out,'extension-firefox',{recursive:true,force:true});
console.log('Firefox: load extension-firefox/manifest.json; extension/ is Chrome-only.');
