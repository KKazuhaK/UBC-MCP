import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {hubOrigin,storedConnection} from '../dist/collector/connection.js';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';

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
 assert.equal(storedConnection({ubcUploadToken:'b'.repeat(43)}).origin,'https://mcp.kazuhahub.com');
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
