import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {snapshot,section} from './fixtures.mjs';
test('extension pairing keeps only upload credential in trusted local storage and requires explicit preview',async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8')),state={},requests=[];let access;
 const chrome={storage:{local:{setAccessLevel:async x=>{access=x.accessLevel;},get:async()=>({...state}),set:async x=>Object.assign(state,x),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete state[key];}}}};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({uploadToken:'b'.repeat(43)})};};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',legalComments:'none'});
 runInNewContext(bundle.outputFiles[0].text,{document,chrome,fetch,AbortSignal,URL,Blob,console,setTimeout,clearTimeout});await new Promise(r=>setImmediate(r));
 assert.equal(access,'TRUSTED_CONTEXTS');assert.equal(document.getElementById('upload').disabled,true);
 document.getElementById('hub-origin').value='https://mcp.kazuhahub.com';document.getElementById('pair-code').value='a'.repeat(43);await document.getElementById('pair').onclick();
 assert.equal(requests[0].url,'https://mcp.kazuhahub.com/ubc/api/claim');assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');assert.equal(document.getElementById('pair-code').value,'');
 assert.deepEqual(Object.keys(state),['ubcConnection']);assert.equal(state.ubcConnection.uploadToken,'b'.repeat(43));assert.equal(state.ubcConnection.origin,'https://mcp.kazuhahub.com');
 assert.equal(document.getElementById('connect-setup').hidden,true);assert.equal(document.getElementById('connected-actions').hidden,false);
 await document.getElementById('upload').onclick();assert.equal(requests.length,1);assert.match(document.getElementById('status').textContent,/Preview data first/);
 const timestamp=new Date().toISOString(),data=snapshot({capturedAt:timestamp,sections:[section({observedAt:timestamp})]});
 const input=document.getElementById('snapshot-file');input.files=[{size:100,text:async()=>JSON.stringify(data)}];
 await input.onchange();assert.equal(document.getElementById('upload').disabled,false);assert.equal(requests.length,1);
 document.getElementById('hub-origin').value='https://different.example.com';
 await document.getElementById('upload').onclick();assert.equal(requests.length,2);assert.equal(requests[1].url,'https://mcp.kazuhahub.com/v1/snapshots');assert.equal(requests[1].options.headers.Authorization,'Bearer '+'b'.repeat(43));assert.equal(JSON.parse(requests[1].options.body).capturedAt,timestamp);
 input.files=[{size:100,text:async()=>'{"not":"snapshot"}'}];await input.onchange();assert.equal(document.getElementById('upload').disabled,true);
 await document.getElementById('forget').onclick();assert.equal(state.ubcConnection,undefined);assert.equal(document.getElementById('upload').disabled,true);
 assert.equal(document.getElementById('connect-setup').hidden,false);assert.equal(document.getElementById('connected-actions').hidden,true);
});

test('extension shows pairing progress immediately, blocks duplicate actions and recovers after failure',async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));let finish,requests=0;
 const chrome={storage:{local:{setAccessLevel:async()=>{},get:async()=>({}),set:async()=>{},remove:async()=>{}}}};
 const fetch=()=>{requests++;return new Promise(r=>finish=r);};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',legalComments:'none'});
 runInNewContext(bundle.outputFiles[0].text,{document,chrome,fetch,AbortSignal,URL,Blob,console,setTimeout,clearTimeout});await new Promise(r=>setImmediate(r));
 const pair=document.getElementById('pair');document.getElementById('hub-origin').value='https://mcp.kazuhahub.com';document.getElementById('pair-code').value='a'.repeat(43);
 const task=pair.onclick();assert.match(pair.textContent,/Pairing/);assert.equal(pair.getAttribute('aria-busy'),'true');assert.equal(document.getElementById('status').dataset.state,'loading');assert.equal(document.getElementById('forget').disabled,true);
 await pair.onclick();await document.getElementById('forget').onclick();assert.equal(requests,1);
 finish({ok:false,status:401});await task;
 assert.equal(pair.textContent,'Pair extension');assert.equal(pair.disabled,false);assert.equal(pair.hasAttribute('aria-busy'),false);assert.equal(document.getElementById('status').dataset.state,'error');assert.match(document.getElementById('status').textContent,/Generate a new code/);assert.equal(document.getElementById('upload').disabled,true);
});

for(const scenario of ['Firefox without Chrome API','storage failure','storage timeout'])test(`startup exits checking state: ${scenario}`,async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 const browser={storage:{local:{get:scenario==='storage failure'?async()=>{throw new Error('Storage blocked');}:scenario==='storage timeout'?()=>new Promise(()=>{}):async()=>({})}}};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'firefox140',legalComments:'none'});
 const context={document,browser,fetch:async()=>{throw new Error('Startup must not contact server');},AbortSignal,URL,Blob,console,clearTimeout,setTimeout:scenario==='storage timeout'?(fn)=>{queueMicrotask(fn);return 1;}:setTimeout};
 runInNewContext(bundle.outputFiles[0].text,context);await new Promise(r=>setImmediate(r));
 assert.notEqual(document.getElementById('status').dataset.state,'loading');assert.equal(document.getElementById('pair').disabled,false);assert.equal(document.getElementById('pair-code').disabled,false);
 if(scenario==='Firefox without Chrome API')assert.match(document.getElementById('status').textContent,/Ready/);
 else assert.equal(document.getElementById('status').dataset.state,'error');
});

test('Firefox HTTP 403 pairing error distinguishes missing server support from an expired code',async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 const browser={storage:{local:{get:async()=>({})}}};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'firefox142',legalComments:'none'});
 runInNewContext(bundle.outputFiles[0].text,{document,browser,fetch:async()=>({ok:false,status:403}),AbortSignal,URL,Blob,console,setTimeout,clearTimeout});await new Promise(r=>setImmediate(r));
 document.getElementById('hub-origin').value='https://mcp.kazuhahub.com';document.getElementById('pair-code').value='a'.repeat(43);await document.getElementById('pair').onclick();
 assert.match(document.getElementById('status').textContent,/upgrade the UBC connector/);assert.doesNotMatch(document.getElementById('status').textContent,/expired/);assert.equal(document.getElementById('pair').disabled,false);
});

test('connected users can pause and resume automatic sync without reconnecting',async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 const state={ubcConnection:{origin:'https://hub.example.com',uploadToken:'b'.repeat(43)},ubcAutoSync:true};const messages=[];
 const chrome={runtime:{sendMessage:async msg=>{messages.push(msg);return {ok:true};}},permissions:{request:async()=>true},storage:{local:{get:async()=>({...state}),set:async x=>Object.assign(state,x),remove:async()=>{}}}};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false});
 runInNewContext(bundle.outputFiles[0].text,{document,chrome,AbortSignal,URL,Blob,console,setTimeout,clearTimeout});await new Promise(r=>setImmediate(r));
 const toggle=document.getElementById('auto-toggle');assert.equal(toggle.textContent,'Pause automatic sync');
 await toggle.onclick();assert.equal(state.ubcAutoSync,false);assert.equal(toggle.textContent,'Enable automatic sync');
 await toggle.onclick();assert.equal(state.ubcAutoSync,true);assert.equal(toggle.textContent,'Pause automatic sync');
 assert.deepEqual(messages.map(m=>m.type),['ubc.sync.configure','ubc.sync.configure']);
});
