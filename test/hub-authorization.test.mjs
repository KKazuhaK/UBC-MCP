import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {hubOrigin,storedConnection} from '../dist/collector/connection.js';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {snapshot,section} from './fixtures.mjs';
import {hubDefine} from '../scripts/default-hub.mjs';

async function background(){
 const state={},requests=[],tabs=[],injected=[];let listener;
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:fn=>listener=fn}},tabs:{create:async x=>{tabs.push(x);return {id:7};},get:async()=>({status:'loading'}),onUpdated:{addListener:()=>{}}},scripting:{executeScript:async x=>injected.push(x)},storage:{local:{get:async()=>state,set:async x=>Object.assign(state,x),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete state[k];},setAccessLevel:async()=>{}}}};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/capabilities')?{extensionAuthorization:1}:{uploadToken:'t'.repeat(43)}};};
 const code=await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120'});
 runInNewContext(code.outputFiles[0].text,{chrome,fetch,crypto:webcrypto,URL,AbortSignal,console,Date});
 const send=(message,sender={id:'extension-id'})=>new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);});
 return {state,requests,tabs,injected,send};
}
test('the extension needs only the default Hub and UBC Workday up front; other Hubs stay optional',()=>{
 const {document}=parseHTML(readFileSync('extension/popup.html','utf8'));
 assert.equal(document.getElementById('hub-origin').getAttribute('value'),null);
 const manifest=JSON.parse(readFileSync('extension/manifest.json','utf8'));
 assert.deepEqual(manifest.host_permissions,['https://mcp.kazuhahub.com/*','https://wd10.myworkday.com/*']);assert.deepEqual(manifest.optional_host_permissions,['https://*/*']);
 // The page bridge runs only on the default Hub's UBC page, in the top frame.
 assert.deepEqual(manifest.content_scripts,[{matches:['https://mcp.kazuhahub.com/ubc/*'],js:['bridge.js'],run_at:'document_idle'}]);
});
test('Hub addresses are explicit HTTPS origins and a saved token stays bound to its origin',()=>{
 for(const value of ['', 'http://hub.example.com','https://a:b@hub.example.com','https://hub.example.com?token=secret','https://hub.example.com#secret','https://hub.example.com/mcp/ubc-personal?token=secret','https://hub.example.com/mcp/ubc-personal#secret'])assert.throws(()=>hubOrigin(value));
 assert.equal(hubOrigin(' https://my-hub.example.com/ '),'https://my-hub.example.com');
 assert.equal(hubOrigin('https://my-hub.example.com/mcp/ubc-personal'),'https://my-hub.example.com');
 const data={ubcConnection:{origin:'https://original.example.com',uploadToken:'a'.repeat(43)},ubcHubOrigin:'https://other.example.com'};
 assert.equal(storedConnection(data).origin,'https://original.example.com');
 assert.equal(storedConnection({ubcUploadToken:'b'.repeat(43)}),null);
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

async function bridgeBackground(extra={}){
 const state={},requests=[],tabs=[];let listener,onAdded,onInstalled;
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:fn=>listener=fn},onInstalled:{addListener:fn=>onInstalled=fn}},
  permissions:{contains:async({origins})=>origins.every(o=>(extra.granted??[]).includes(o)),onAdded:{addListener:fn=>onAdded=fn}},
  tabs:{create:async x=>{tabs.push(x);return {id:7};},get:async()=>({status:'loading'}),query:async()=>[],onUpdated:{addListener:()=>{}}},
  scripting:{executeScript:async()=>{}},
  storage:{local:{get:async()=>state,set:async x=>Object.assign(state,x),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete state[k];},setAccessLevel:async()=>{}}}};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/capabilities')?{extensionAuthorization:1}:{uploadToken:'t'.repeat(43)}};};
 const code=await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',define:hubDefine()});
 runInNewContext(code.outputFiles[0].text,{chrome,fetch,crypto:webcrypto,URL,AbortSignal,console,Date,setTimeout:()=>0});
 const send=(message,sender={id:'extension-id'})=>new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);});
 return {state,requests,tabs,send,added:()=>onAdded(),installed:d=>onInstalled(d)};
}
test('the default Hub page connects this browser with one click; other pages and frames cannot',async()=>{
 const b=await bridgeBackground(),code='c'.repeat(43),page={id:'extension-id',tab:{id:3},frameId:0,url:'https://mcp.kazuhahub.com/ubc/?connected=1'};
 for(const sender of [{...page,url:'https://evil.example/ubc/'},{...page,url:'https://mcp.kazuhahub.com/other/'},{...page,frameId:2},{...page,id:'another-extension'},{id:'extension-id'}]){
  assert.equal((await b.send({type:'ubc.bridge.claim',code},sender)).ok,false);
  assert.equal((await b.send({type:'ubc.bridge.status'},sender)).ok,false);
 }
 assert.equal(b.requests.length,0);
 assert.equal((await b.send({type:'ubc.bridge.status'},page)).connected,false);
 assert.equal((await b.send({type:'ubc.bridge.claim',code:'short'},page)).ok,false);
 assert.equal((await b.send({type:'ubc.bridge.claim',code},page)).ok,true);
 assert.equal(b.requests[0].url,'https://mcp.kazuhahub.com/ubc/api/claim');assert.equal(b.requests[0].options.credentials,'omit');
 assert.deepEqual(JSON.parse(b.requests[0].options.body),{code});
 assert.deepEqual(JSON.parse(JSON.stringify(b.state.ubcConnection)),{origin:'https://mcp.kazuhahub.com',uploadToken:'t'.repeat(43)});
 assert.equal(b.state.ubcAutoSync,true);
 assert.equal((await b.send({type:'ubc.bridge.status'},page)).connected,true);
});
test('a popup request interrupted by the access prompt is finished once access is granted',async()=>{
 const b=await bridgeBackground({granted:['https://other-hub.example.com/*']});
 b.state.ubcPendingIntent={type:'pair',origin:'https://other-hub.example.com',code:'c'.repeat(43),at:Date.now()};
 b.added();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(b.state.ubcPendingIntent,undefined);
 assert.equal(b.requests[0].url,'https://other-hub.example.com/ubc/api/claim');
 assert.equal(b.state.ubcConnection.origin,'https://other-hub.example.com');
 // A stale request, or one for a Hub without access, does nothing.
 const late=await bridgeBackground({granted:['https://other-hub.example.com/*']});
 late.state.ubcPendingIntent={type:'pair',origin:'https://other-hub.example.com',code:'c'.repeat(43),at:Date.now()-6*60_000};
 assert.equal((await late.send({type:'ubc.intent.resume'})).ok,false);assert.equal(late.requests.length,0);
 const denied=await bridgeBackground();
 denied.state.ubcPendingIntent={type:'authorize',origin:'https://other-hub.example.com',at:Date.now()};
 assert.equal((await denied.send({type:'ubc.intent.resume'})).ok,false);assert.equal(denied.tabs.length,0);
 assert.equal((await denied.send({type:'ubc.intent.resume'},{id:'extension-id',tab:{id:1},url:'https://mcp.kazuhahub.com/ubc/'})).ok,false);
});
test('a new installation opens the Hub UBC page; an update does not',async()=>{
 const b=await bridgeBackground();
 b.installed({reason:'update'});b.installed({reason:'install'});await new Promise(r=>setImmediate(r));
 assert.deepEqual(JSON.parse(JSON.stringify(b.tabs)),[{url:'https://mcp.kazuhahub.com/ubc/'}]);
});
test('the default Hub page can ask for a sync now; other pages cannot, and it needs a connection',async()=>{
 const b=await bridgeBackground(),page={id:'extension-id',tab:{id:3},frameId:0,url:'https://mcp.kazuhahub.com/ubc/'};
 assert.equal((await b.send({type:'ubc.bridge.sync'},{...page,url:'https://evil.example/ubc/'})).ok,false);
 const notConnected=await b.send({type:'ubc.bridge.sync'},page);assert.equal(notConnected.ok,false);assert.match(notConnected.error,/Connect this browser/);
 b.state.ubcConnection={origin:'https://mcp.kazuhahub.com',uploadToken:'t'.repeat(43)};
 b.state.ubcLastSync={at:'2026-11-20T00:00:00.000Z',count:1};b.state.ubcSyncError='old problem';
 const status=await b.send({type:'ubc.bridge.status'},page);
 assert.equal(status.connected,true);assert.equal(status.lastSyncAt,'2026-11-20T00:00:00.000Z');assert.equal(status.syncError,'old problem');
 // No Workday tab and no Workday access in this stand-in: the page hears why.
 const r=await b.send({type:'ubc.bridge.sync'},page);
 assert.equal(r.ok,false);assert.ok(r.error);assert.equal(b.state.ubcAutoSync,true);
});
