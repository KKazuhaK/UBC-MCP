import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {snapshot,section} from './fixtures.mjs';
test('popup has no manual pairing controls',()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 for(const id of ['pair','pair-code'])assert.equal(document.getElementById(id),null);assert.ok(document.getElementById('hub-login'));
 assert.doesNotMatch(readFileSync('src/collector/popup.ts','utf8'),/pair-code|ubcLegacyToken|api\/claim/);
});
test('a stored connection keeps only the upload credential in trusted local storage and requires explicit preview',async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8')),state={ubcConnection:{origin:'https://hub.example.test',uploadToken:'b'.repeat(43)}},requests=[];let access;
 const chrome={storage:{local:{setAccessLevel:async x=>{access=x.accessLevel;},get:async()=>({...state}),set:async x=>Object.assign(state,x),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete state[key];}}}};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,body:{cancel:async()=>{}}};};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',legalComments:'none'});
 runInNewContext(bundle.outputFiles[0].text,{document,chrome,fetch,AbortSignal,URL,Blob,console,setTimeout,clearTimeout});await new Promise(r=>setImmediate(r));
 assert.equal(access,'TRUSTED_CONTEXTS');assert.equal(document.getElementById('upload').disabled,true);
 assert.deepEqual(Object.keys(state),['ubcConnection']);
 assert.equal(document.getElementById('connect-setup').hidden,true);assert.equal(document.getElementById('connected-actions').hidden,false);
 await document.getElementById('upload').onclick();assert.equal(requests.length,0);assert.match(document.getElementById('status').textContent,/Preview data first/);
 const timestamp=new Date().toISOString(),data=snapshot({capturedAt:timestamp,sections:[section({observedAt:timestamp})]});
 const input=document.getElementById('snapshot-file');input.files=[{size:100,text:async()=>JSON.stringify(data)}];
 await input.onchange();assert.equal(document.getElementById('upload').disabled,false);assert.equal(requests.length,0);
 document.getElementById('hub-origin').value='https://different.example.com';
 await document.getElementById('upload').onclick();assert.equal(requests.length,1);assert.equal(requests[0].url,'https://hub.example.test/v1/snapshots');assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.headers.Authorization,'Bearer '+'b'.repeat(43));assert.equal(JSON.parse(requests[0].options.body).capturedAt,timestamp);
 input.files=[{size:100,text:async()=>'{"not":"snapshot"}'}];await input.onchange();assert.equal(document.getElementById('upload').disabled,true);
 await document.getElementById('forget').onclick();assert.equal(state.ubcConnection,undefined);assert.equal(document.getElementById('upload').disabled,true);
 assert.equal(document.getElementById('connect-setup').hidden,false);assert.equal(document.getElementById('connected-actions').hidden,true);
});

for(const scenario of ['Firefox without Chrome API','storage failure','storage timeout'])test(`startup exits checking state: ${scenario}`,async()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 const browser={storage:{local:{get:scenario==='storage failure'?async()=>{throw new Error('Storage blocked');}:scenario==='storage timeout'?()=>new Promise(()=>{}):async()=>({})}}};
 const bundle=await build({entryPoints:['src/collector/popup.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'firefox140',legalComments:'none'});
 const context={document,browser,fetch:async()=>{throw new Error('Startup must not contact server');},AbortSignal,URL,Blob,console,clearTimeout,setTimeout:scenario==='storage timeout'?(fn)=>{queueMicrotask(fn);return 1;}:setTimeout};
 runInNewContext(bundle.outputFiles[0].text,context);await new Promise(r=>setImmediate(r));
 assert.notEqual(document.getElementById('status').dataset.state,'loading');assert.equal(document.getElementById('hub-login').disabled,false);assert.equal(document.getElementById('hub-origin').disabled,false);
 if(scenario==='Firefox without Chrome API')assert.match(document.getElementById('status').textContent,/Ready/);
 else assert.equal(document.getElementById('status').dataset.state,'error');
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

test('a legacy token is not a connection',async()=>{
 const {storedConnection}=await import('../dist/collector/connection.js');
 assert.equal(storedConnection({ubcUploadToken:'b'.repeat(43)}),null);assert.equal(storedConnection({ubcLegacyToken:'b'.repeat(43)}),null);
});
