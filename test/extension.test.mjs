import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
test('extension pairing keeps only upload credential in trusted local storage and requires explicit preview',async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8')),state={},requests=[];let access;
 const chrome={storage:{local:{setAccessLevel:async x=>{access=x.accessLevel;},get:async()=>({...state}),set:async x=>Object.assign(state,x),remove:async key=>{delete state[key];}}}};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({uploadToken:'b'.repeat(43)})};};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',legalComments:'none'});
 runInNewContext(bundle.outputFiles[0].text,{document,chrome,fetch,AbortSignal,URL,Blob,console});await new Promise(r=>setImmediate(r));
 assert.equal(access,'TRUSTED_CONTEXTS');assert.equal(document.getElementById('upload').disabled,true);
 document.getElementById('pair-code').value='a'.repeat(43);await document.getElementById('pair').onclick();
 assert.equal(requests[0].url,'https://mcp.kazuhahub.com/ubc/api/claim');assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');assert.equal(document.getElementById('pair-code').value,'');
 assert.deepEqual(Object.keys(state),['ubcUploadToken']);assert.equal(state.ubcUploadToken,'b'.repeat(43));
 await document.getElementById('upload').onclick();assert.equal(requests.length,1);assert.match(document.getElementById('status').textContent,/Preview data first/);
 await document.getElementById('forget').onclick();assert.equal(state.ubcUploadToken,undefined);assert.equal(document.getElementById('upload').disabled,true);
});
