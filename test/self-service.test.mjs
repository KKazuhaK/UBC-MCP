import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {snapshot,section} from './fixtures.mjs';
const extension='chrome-extension://'+'a'.repeat(32),origin='https://mcp.kazuhahub.com';
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'ubc-self-')),store=new Store(dir),saved=new Map();
 const hub=createServer(async(req,res)=>{
  const who=req.headers.cookie==='session=A'?'A':req.headers.cookie==='session=B'?'B':null;
  res.setHeader('Content-Type','application/json');
  if(!who){res.writeHead(401);res.end('{}');return;}
  if(req.url==='/api/better-auth/user')res.end(JSON.stringify({success:true,user:{username:who}}));
  else if(req.url==='/api/credentials')res.end(JSON.stringify({success:true,data:[{serverName:'ubc-personal',credentialTemplate:[{target:'env',name:'UBC_CONNECTOR_TOKEN'}]}]}));
  else if(req.url==='/api/credentials/ubc-personal'){
   if(req.method==='PUT'){let body='';for await(const c of req)body+=c;saved.set(who,JSON.parse(body).values['env.UBC_CONNECTOR_TOKEN']);}
   if(req.method==='DELETE')saved.delete(who);
   res.end('{"success":true}');
  }else{res.writeHead(404);res.end('{}');}
 });
 await new Promise(r=>hub.listen(0,'127.0.0.1',r));
 const server=connectorServer(store,{origin,hubUrl:`http://127.0.0.1:${hub.address().port}`});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>hub.close(r))]);store.close();rmSync(dir,{recursive:true,force:true});});
 const call=(action,who='A',extra={})=>fetch(url+'/ubc/api/'+action,{method:action==='status'?'GET':'POST',headers:{Cookie:`session=${who}`,Origin:origin,...extra},redirect:'error'});
 return {store,url,call,saved};
}
test('self-service verifies Hub session, saves only own read credential and pairs upload once',async t=>{
 const {store,url,call,saved}=await setup(t);
 assert.equal((await call('connect','unknown')).status,403);
 assert.equal((await call('connect','A',{Origin:'https://attacker.example'})).status,403);
 assert.equal((await call('connect','A',{Authorization:'Bearer system'})).status,403);
 assert.equal((await call('connect')).status,200);assert.equal((await call('connect','B')).status,200);
 assert.notEqual(saved.get('A'),saved.get('B'));
 const a=store.account('A'),b=store.account('B');assert.equal(saved.get('A'),a.readToken);
 const code=(await (await call('pair')).json()).code;
 const claim=()=>fetch(url+'/ubc/api/claim',{method:'POST',headers:{Origin:extension,'Content-Type':'application/json'},body:JSON.stringify({code})});
 const r=await claim();assert.equal(r.status,200);const credential=await r.json();assert.deepEqual(credential,{uploadToken:a.uploadToken});assert.equal((await claim()).status,401);
 const now=new Date().toISOString(),s=snapshot({capturedAt:now,sections:[section({observedAt:now})]});
 const pushed=await fetch(url+'/v1/snapshots',{method:'POST',headers:{Origin:extension,Authorization:`Bearer ${credential.uploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(s)});assert.equal(pushed.status,200);
 assert.equal((await (await call('status')).json()).scopes.length,1);assert.equal((await (await call('status','B')).json()).scopes.length,0);
 assert.equal(store.authenticate(credential.uploadToken,'read'),null);
 const unused=(await (await call('pair')).json()).code;
 assert.equal((await call('disconnect')).status,200);assert.equal(store.authenticate(a.readToken,'read'),null);assert.equal(store.claim(unused),null);assert.equal(saved.has('A'),false);assert.equal(store.authenticate(b.readToken,'read'),b.id);
 assert.equal((await call('connect')).status,200);assert.equal((await (await call('status')).json()).scopes.length,0);assert.notEqual(saved.get('A'),a.readToken);
});
test('self-service forbids credentialed cross-origin claims and enables extension POST preflight only',async t=>{
 const {url,call,store}=await setup(t);await call('connect');const code=store.pair('A').code;
 for(const headers of [{Origin:'https://evil.example'},{Origin:extension,Cookie:'session=A'}]){
 const r=await fetch(url+'/ubc/api/claim',{method:'POST',headers,body:JSON.stringify({code})});assert.equal(r.status,403);}
 const r=await fetch(url+'/v1/snapshots',{method:'OPTIONS',headers:{Origin:extension,'Access-Control-Request-Method':'POST'}});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),extension);
 assert.notEqual((await fetch(url+'/v1/snapshots',{method:'OPTIONS',headers:{Origin:'https://evil.example'}})).status,204);
 const page=await fetch(url+'/ubc/');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotMatch(await page.text(),new RegExp(store.account('A').readToken));
});
test('self-service credentials survive restart encrypted; new pairing invalidates earlier codes and expiry is enforced',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ubc-restart-'));let store=new Store(dir);
 try{const a=store.account('A',true),p=store.pair('A');store.close();store=new Store(dir);assert.deepEqual(store.account('A'),a);
 const next=store.pair('A');assert.equal(store.claim(p.code),null);const original=Date.now;
 try{Date.now=()=>next.expires+1;assert.equal(store.claim(next.code),null);}finally{Date.now=original;}
 store.revoke(a.id);assert.equal(store.account('A'),null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('connection GUI connects, displays pairing, cancels deletion and shows server failures',async()=>{
 const {parseHTML}=await import('linkedom');const {runInNewContext}=await import('node:vm');const {page,script}=await import('../dist/connector/web.js');
 const {document}=parseHTML(page),calls=[];let connected=false,allowDelete=false,fail=false;
 const fetch=async(url,options)=>{calls.push({url,options});if(fail)return {ok:false,json:async()=>({message:'Sign in to Hub'})};const action=url.split('/').at(-1);if(action==='connect')connected=true;if(action==='disconnect')connected=false;return {ok:true,json:async()=>action==='status'?{connected,scopes:[]}:action==='pair'?{code:'one-use-code'}:{connected}};};
 runInNewContext(script,{document,fetch,AbortSignal,confirm:()=>allowDelete,alert:()=>{}});
 await new Promise(r=>setImmediate(r));
 await document.getElementById('connect').onclick();assert.equal(connected,true);
 assert.match(document.getElementById('status').textContent,/已连接/);
 await document.getElementById('pair').onclick();assert.equal(document.getElementById('code').value,'one-use-code');assert.equal(document.getElementById('pairing').hidden,false);
 await document.getElementById('disconnect').onclick();assert.equal(connected,true);
 allowDelete=true;await document.getElementById('disconnect').onclick();assert.equal(connected,false);assert.equal(document.getElementById('code').value,'');
 fail=true;await document.getElementById('refresh').onclick();assert.equal(document.getElementById('status').textContent,'Sign in to Hub');
 assert.ok(calls.every(c=>c.options.credentials==='same-origin'&&c.options.redirect==='error'));
});

test('connection page exposes slow-request progress, rejects duplicate clicks and recovers from timeout',async()=>{
 const {parseHTML}=await import('linkedom');const {runInNewContext}=await import('node:vm');const {page,script}=await import('../dist/connector/web.js');
 const {document}=parseHTML(page);let rejectConnect,requests=0;
 const fetch=async(url)=>{if(url.endsWith('/status'))return {ok:true,json:async()=>({connected:false,scopes:[]})};requests++;return new Promise((resolve,reject)=>rejectConnect=reject);};
 runInNewContext(script,{document,fetch,AbortSignal,confirm:()=>true,alert:()=>{}});await new Promise(r=>setImmediate(r));
 const b=document.getElementById('connect'),task=b.onclick();assert.match(b.textContent,/正在连接/);assert.equal(b.getAttribute('aria-busy'),'true');assert.equal(document.getElementById('status').dataset.state,'loading');assert.equal(document.getElementById('refresh').disabled,true);
 await b.onclick();assert.equal(requests,1);const error=new Error('timeout');error.name='TimeoutError';rejectConnect(error);await task;
 assert.equal(b.disabled,false);assert.equal(b.getAttribute('aria-busy'),null);assert.equal(document.getElementById('status').dataset.state,'error');assert.match(document.getElementById('status').textContent,/连接超时/);
});
