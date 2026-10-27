import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {hubOrigin,storedConnection} from '../dist/collector/connection.js';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {snapshot,section} from './fixtures.mjs';

async function background(){
 const state={},requests=[],tabs=[],injected=[];let listener;
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:fn=>listener=fn}},tabs:{create:async x=>{tabs.push(x);return {id:7};},get:async()=>({status:'loading'}),onUpdated:{addListener:()=>{}}},scripting:{executeScript:async x=>injected.push(x)},storage:{local:{get:async()=>state,set:async x=>Object.assign(state,x),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete state[k];},setAccessLevel:async()=>{}}}};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/capabilities')?{extensionAuthorization:1}:{uploadToken:'t'.repeat(43)}};};
 const code=await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120'});
 runInNewContext(code.outputFiles[0].text,{chrome,fetch,crypto:webcrypto,URL,AbortSignal,console,Date});
 const send=(message,sender={id:'extension-id'})=>new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);});
 return {state,requests,tabs,injected,send};
}
test('new extension installation has no prefilled or required Hub host',()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 assert.equal(document.getElementById('hub-origin').getAttribute('value'),null);
 const manifest=JSON.parse(readFileSync('extension/manifest.json','utf8'));
 assert.equal(manifest.host_permissions,undefined);assert.deepEqual(manifest.optional_host_permissions,['https://*/*']);
});
test('Hub addresses are explicit HTTPS origins and a saved token stays bound to its origin',()=>{
 for(const value of ['', 'http://hub.example.com','https://a:b@hub.example.com','https://hub.example.com/path','https://hub.example.com?token=secret','https://hub.example.com#secret'])assert.throws(()=>hubOrigin(value));
 assert.equal(hubOrigin(' https://my-hub.example.com/ '),'https://my-hub.example.com');
 const data={ubcConnection:{origin:'https://original.example.com',uploadToken:'a'.repeat(43)},ubcHubOrigin:'https://other.example.com'};
 assert.equal(storedConnection(data).origin,'https://original.example.com');
 // No origin is built in: a legacy token without an origin is not connected unless the build supplied one.
 assert.equal(storedConnection({ubcUploadToken:'b'.repeat(43)}),null);
 globalThis.__UBC_LEGACY_HUB__='https://legacy.example.test/';
 try{assert.equal(storedConnection({ubcUploadToken:'b'.repeat(43)}).origin,'https://legacy.example.test');}finally{delete globalThis.__UBC_LEGACY_HUB__;}
});
test('Hub authorization opens the chosen host and only its original browser tab may claim',async()=>{
 const b=await background(),origin='https://my-hub.example.com';
 assert.equal((await b.send({type:'ubc.authorize.start',origin})).ok,true);
 assert.match(b.tabs[0].url,/^https:\/\/my-hub.example.com\/ubc\/#extension-auth=[a-f0-9]{64}$/);
 const a=b.state.ubcAuthorization,message={type:'ubc.authorize.claim',state:a.state,code:'c'.repeat(43)};
 for(const sender of [{id:'extension-id',tab:{id:99},url:origin+'/ubc/'},{id:'extension-id',tab:{id:7},url:'https://wrong.example.com/ubc/'},{id:'another-extension',tab:{id:7},url:origin+'/ubc/'}])assert.equal((await b.send(message,sender)).ok,false);
 assert.equal((await b.send({...message,state:'x'.repeat(64)},{id:'extension-id',tab:{id:7},url:origin+'/ubc/'})).ok,false);
 assert.equal(b.requests.length,1);assert.equal(b.state.ubcConnection,undefined);
 assert.equal((await b.send(message,{id:'extension-id',tab:{id:7},url:origin+'/ubc/'})).ok,true);
 assert.equal(b.requests[1].url,origin+'/ubc/api/claim');assert.equal(b.requests[1].options.credentials,'omit');assert.equal(b.requests[1].options.redirect,'error');
 assert.equal(b.state.ubcConnection.origin,origin);assert.equal(b.state.ubcConnection.uploadToken,'t'.repeat(43));
 assert.equal(b.state.ubcAuthorization.state,undefined);assert.equal(b.state.ubcAuthorization.status,'connected');
 assert.equal((await b.send(message,{id:'extension-id',tab:{id:7},url:origin+'/ubc/'})).ok,false);
});
test('a webpage cannot start extension authorization and expired requests cannot claim',async()=>{
 const b=await background(),origin='https://mine.example.com';
 assert.equal((await b.send({type:'ubc.authorize.start',origin},{id:'extension-id',tab:{id:1}})).ok,false);
 assert.equal(b.requests.length,0);
 assert.equal((await b.send({type:'ubc.authorize.start'})).ok,false);assert.equal(b.requests.length,0);
 await b.send({type:'ubc.authorize.start',origin});b.state.ubcAuthorization.expires=0;
 assert.equal((await b.send({type:'ubc.authorize.claim',state:b.state.ubcAuthorization.state,code:'x'.repeat(43)},{id:'extension-id',tab:{id:7},url:origin+'/ubc/'})).ok,false);
 assert.equal(b.requests.length,1);
});
test('automatic sync accepts only the UBC Workday tab and uses the saved Hub',async()=>{
 const b=await background();
 b.state.ubcConnection={origin:'https://chosen-hub.example.com',uploadToken:'t'.repeat(43)};
 b.state.ubcAutoSync=true;
 const timestamp=new Date().toISOString();
 const data=snapshot({capturedAt:timestamp,sections:[section({observedAt:timestamp})]});
 const message={type:'ubc.sync.snapshots',snapshots:[data]};
 for(const sender of [
  {id:'extension-id'},
  {id:'extension-id',tab:{id:1},url:'https://wd10.myworkday.com/other/'},
  {id:'other-extension',tab:{id:1},url:'https://wd10.myworkday.com/ubc/'},
  {id:'extension-id',tab:{id:1},url:'https://wd10.myworkday.com.evil.example/ubc/'}
 ])assert.equal((await b.send(message,sender)).ok,false);
 assert.equal(b.requests.length,0);
 b.state.ubcAutoSync=false;
 const sender={id:'extension-id',tab:{id:1},url:'https://wd10.myworkday.com/ubc/d/task/123'};
 assert.equal((await b.send(message,sender)).ok,false);assert.equal(b.requests.length,0);
 b.state.ubcAutoSync=true;
 assert.equal((await b.send(message,sender)).ok,true);
 assert.equal(b.requests[0].url,'https://chosen-hub.example.com/v1/snapshots');
 assert.equal(b.requests[0].options.credentials,'omit');
 assert.equal(b.requests[0].options.headers.Authorization,'Bearer '+'t'.repeat(43));
 assert.equal(b.state.ubcLastSync.count,1);
});

test('sync now opens a temporary Workday registration page and schedules background refresh',async()=>{
 const state={ubcConnection:{origin:'https://mine.example.com',uploadToken:'t'.repeat(43)},ubcAutoSync:true},removed=[],alarms=[],injected=[];let listener;
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:fn=>listener=fn}},
  storage:{local:{get:async()=>state,set:async x=>Object.assign(state,x),setAccessLevel:async()=>{}}},
  permissions:{contains:async()=>true},
  tabs:{query:async()=>[],create:async x=>({id:123,...x}),get:async()=>({id:123,status:'complete',url:'https://wd10.myworkday.com/ubc/d/task/2998$28771.htmld',active:false}),
   sendMessage:async()=>({ok:true,count:2,kinds:['registrations']}),remove:async id=>removed.push(id),onUpdated:{addListener:()=>{}}},
  alarms:{get:async()=>null,create:async(...x)=>alarms.push(x),clear:async()=>{},onAlarm:{addListener:()=>{}}},
  scripting:{executeScript:async x=>injected.push(x)}};
 const code=await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120'});
 runInNewContext(code.outputFiles[0].text,{chrome,URL,AbortSignal,console,Date,setTimeout:fn=>queueMicrotask(fn)});
 const response=await new Promise(resolve=>listener({type:'ubc.sync.all'},{id:'extension-id'},resolve));
 assert.equal(response.ok,true);assert.equal(response.count,2);
 assert.equal(alarms[0][1].periodInMinutes,15);assert.deepEqual(removed,[123]);
 assert.equal(injected[0].files[0],'auto-sync.js');
});
