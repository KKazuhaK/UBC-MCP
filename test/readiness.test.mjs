import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createServer as netServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {readinessFromEnv,DEFAULT_READINESS} from '../dist/connector/readiness.js';
import {snapshot,section} from './fixtures.mjs';

const DAY=86_400_000;
const aged=(days,extra={})=>snapshot({capturedAt:new Date(Date.now()-days*DAY).toISOString(),sections:[section({observedAt:new Date(Date.now()-days*DAY-1000).toISOString()})],...extra});
async function boot(t,config){
  const dir=mkdtempSync(join(tmpdir(),'ubc-ready-')),store=new Store(dir),server=connectorServer(store,null,null,config);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}/v1/readiness`;
  const get=(token,init={})=>fetch(url,{headers:token?{Authorization:`Bearer ${token}`}:{},...init});
  return {store,get,url,dir,base:url.replace('/v1/readiness','')};
}

test('readiness: no snapshot ever uploaded is needs_setup with the companion install action',async t=>{
  const {store,get}=await boot(t),a=store.create('a');
  const res=await get(a.readToken);assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/^application\/json/);
  const body=await res.json();
  assert.equal(body.version,1);assert.equal(body.state,'needs_setup');
  assert.equal(body.action.label,'Install the UBC browser companion');
  assert.match(body.action.url,/^https:\/\//);
  assert.ok(body.summary.length<=200);assert.ok(!Number.isNaN(Date.parse(body.checked_at)));
  assert.equal('expires_at' in body,false);
});
test('readiness: recent snapshot is ready',async t=>{
  const {store,get}=await boot(t),a=store.create('a');store.put(a.id,aged(1));
  const body=await (await get(a.readToken)).json();
  assert.equal(body.version,1);assert.equal(body.state,'ready');
  assert.ok(Date.now()-Date.parse(body.checked_at)<5000);
  assert.equal('expires_at' in body,false);assert.equal('action' in body,false);
});
test('readiness: newest snapshot older than the threshold is degraded and says how old',async t=>{
  const {store,get}=await boot(t),a=store.create('a');store.put(a.id,aged(9));
  const body=await (await get(a.readToken)).json();
  assert.equal(body.state,'degraded');
  assert.equal(body.summary,'Course data last updated 9 days ago — open the companion to refresh.');
  assert.equal('expires_at' in body,false);
  assert.deepEqual(body.action,{label:'Open the UBC companion',url:DEFAULT_READINESS.installUrl});
});
test('readiness: the newest of several snapshots decides freshness',async t=>{
  const {store,get}=await boot(t),a=store.create('a');
  store.put(a.id,aged(20));store.put(a.id,aged(12,{academicPeriod:{id:'2026W-T2',label:'y',yearSession:'2026W',term:'2'}}));store.put(a.id,aged(1,{academicPeriod:{id:'2027S-T1',label:'x',yearSession:'2027S',term:'1'}}));
  assert.equal((await (await get(a.readToken)).json()).state,'ready');
});
test('readiness: threshold boundary and default',async t=>{
  assert.equal(DEFAULT_READINESS.staleDays,7);
  const {store,get}=await boot(t),a=store.create('a');store.put(a.id,aged(6.9));
  assert.equal((await (await get(a.readToken)).json()).state,'ready');
  const b=store.create('b');store.put(b.id,aged(7.1));
  assert.equal((await (await get(b.readToken)).json()).state,'degraded');
});
test('readiness: configured threshold is honoured',async t=>{
  const {store,get}=await boot(t,{...DEFAULT_READINESS,staleDays:2}),a=store.create('a');store.put(a.id,aged(3));
  assert.equal((await (await get(a.readToken)).json()).state,'degraded');
  const {store:s2,get:g2}=await boot(t,{...DEFAULT_READINESS,staleDays:12}),b=s2.create('b');s2.put(b.id,aged(9));
  assert.equal((await (await g2(b.readToken)).json()).state,'ready');
});
test('readiness: configured install URL is used for needs_setup',async t=>{
  const {store,get}=await boot(t,{...DEFAULT_READINESS,installUrl:'https://example.org/install'}),a=store.create('a');
  assert.equal((await (await get(a.readToken)).json()).action.url,'https://example.org/install');
});
test('readiness: missing, wrong, upload and revoked tokens are 401',async t=>{
  const {store,get}=await boot(t),a=store.create('a');store.put(a.id,aged(1));
  assert.equal((await get(null)).status,401);
  assert.equal((await get('x'.repeat(43))).status,401);
  assert.equal((await get('not-a-token')).status,401);
  assert.equal((await get(a.uploadToken)).status,401);
  assert.equal((await get(a.readToken)).status,200);
  store.revoke(a.id);
  const res=await get(a.readToken);assert.equal(res.status,401);
  assert.deepEqual(await res.json(),{error:'UNAUTHORIZED'});
  assert.equal((await get(a.uploadToken)).status,401);
});
test('readiness: GET only, no browser origins, no side effects',async t=>{
  const {store,get,dir}=await boot(t),a=store.create('a');store.put(a.id,aged(1));
  const before=JSON.stringify(store.get(a.id)),summary=JSON.stringify(store.summary(a.id));
  assert.equal((await get(a.readToken,{method:'POST',headers:{Authorization:`Bearer ${a.readToken}`,'Content-Type':'application/json'},body:'{}'})).status,404);
  assert.equal((await get(a.readToken,{headers:{Authorization:`Bearer ${a.readToken}`,Origin:'https://example.org'}})).status,403);
  for(let i=0;i<3;i++)assert.equal((await get(a.readToken)).status,200);
  assert.equal(JSON.stringify(store.get(a.id)),before);assert.equal(JSON.stringify(store.summary(a.id)),summary);
});
test('readiness: query string and trailing slash still reach the route; other paths do not',async t=>{
  const {store,get,url}=await boot(t),a=store.create('a');
  const h={headers:{Authorization:`Bearer ${a.readToken}`}};
  assert.equal((await fetch(url+'?x=1',h)).status,200);assert.equal((await fetch(url+'/',h)).status,200);assert.equal((await fetch(url+'/?x=1',h)).status,200);
  assert.equal((await fetch(url+'/extra',h)).status,404);assert.equal((await fetch(url+'x',h)).status,404);
  assert.equal((await fetch(url+'?x=1',{headers:{...h.headers,Origin:'https://example.org'}})).status,403);
  assert.equal((await fetch(url+'/',{method:'POST',...h})).status,404);
});
test('readiness never leaks tokens, snapshot content or course data',async t=>{
  const {store,get}=await boot(t),a=store.create('secret-label');
  for(const days of [null,1,9]){
    if(days!==null)store.put(a.id,aged(days,{academicPeriod:{id:`P${days}`,label:'Hidden period',yearSession:'2026W',term:'1'}}));
    const text=await (await get(a.readToken)).text();
    for(const needle of [a.readToken,a.uploadToken,a.id,'secret-label','CPSC','Computation','Hidden period','2026W','sections','UBCV'])
      assert.equal(text.includes(needle),false,`leaked ${needle}`);
    assert.deepEqual(Object.keys(JSON.parse(text)).filter(k=>!['version','state','summary','action','checked_at'].includes(k)),[]);
  }
});
test('readiness environment configuration',()=>{
  assert.deepEqual(readinessFromEnv({}),DEFAULT_READINESS);
  assert.equal(readinessFromEnv({UBC_READINESS_STALE_DAYS:'3'}).staleDays,3);
  assert.equal(readinessFromEnv({UBC_COMPANION_INSTALL_URL:'https://example.org/i'}).installUrl,'https://example.org/i');
  assert.throws(()=>readinessFromEnv({UBC_READINESS_STALE_DAYS:'0'}),/positive/);
  assert.throws(()=>readinessFromEnv({UBC_READINESS_STALE_DAYS:'abc'}),/positive/);
  for(const bad of ['1.5','-3','1e2','0x10',' 5x','07.0'])assert.throws(()=>readinessFromEnv({UBC_READINESS_STALE_DAYS:bad}),/positive/,bad);
  assert.throws(()=>readinessFromEnv({UBC_COMPANION_INSTALL_URL:'https://u:p@example.org/i'}),/https/);
  assert.throws(()=>readinessFromEnv({UBC_COMPANION_INSTALL_URL:'https://u@example.org/i'}),/https/);
  assert.throws(()=>readinessFromEnv({UBC_COMPANION_INSTALL_URL:'http://example.org'}),/https/);
  assert.throws(()=>readinessFromEnv({UBC_READINESS_STALE_DAYS:'20'},{staleDays:14,deleteDays:30}),/must not exceed/);
  assert.equal(readinessFromEnv({UBC_READINESS_STALE_DAYS:'14'},{staleDays:14,deleteDays:30}).staleDays,14);
});

const retained=(t,staleDays=14,deleteDays=30)=>{
  const dir=mkdtempSync(join(tmpdir(),'ubc-ready-')),store=new Store(dir,{staleDays,deleteDays});
  t.after(()=>{try{store.close();}catch{/* already closed by the test */}rmSync(dir,{recursive:true,force:true});});return {dir,store};
};
async function serveStore(t,store,config){
  const server=connectorServer(store,null,null,config);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {base,ready:token=>fetch(base+'/v1/readiness',{headers:{Authorization:`Bearer ${token}`}}),snaps:token=>fetch(base+'/v1/snapshots',{headers:{Authorization:`Bearer ${token}`}})};
}
const companion={label:'Open the UBC companion',url:DEFAULT_READINESS.installUrl};
test('readiness: data older than the serve window is expired, not degraded, and carries an action',async t=>{
  const {store}=retained(t),a=store.create('a');store.put(a.id,aged(20));
  assert.equal(store.get(a.id).length,0);
  const {ready}=await serveStore(t,store),body=await (await ready(a.readToken)).json();
  assert.equal(body.state,'expired');
  assert.equal(body.summary,'Course data is older than 14 days and no longer used — open the UBC companion to sync again');
  assert.deepEqual(body.action,companion);assert.equal('expires_at' in body,false);
});
test('readiness: after the purge a binding that once uploaded is expired, never needs_setup',async t=>{
  const {store}=retained(t),a=store.create('a'),never=store.create('never');store.put(a.id,aged(40));
  assert.deepEqual(store.purge(),{snapshots:1,bindings:0});assert.equal(store.summary(a.id).newestCapturedAt,null);
  const {ready}=await serveStore(t,store),body=await (await ready(a.readToken)).json();
  assert.equal(body.state,'expired');assert.deepEqual(body.action,companion);
  assert.equal((await (await ready(never.readToken)).json()).state,'needs_setup');
});
test('readiness: expired summary names the configured serve window',async t=>{
  const {store}=retained(t,3,10),a=store.create('a');store.put(a.id,aged(5));
  const {ready}=await serveStore(t,store,{...DEFAULT_READINESS,staleDays:2});
  assert.match((await (await ready(a.readToken)).json()).summary,/older than 3 days/);
});
test('readiness: a servable snapshot beside an expired one keeps the binding ready',async t=>{
  const {store}=retained(t),a=store.create('a');store.put(a.id,aged(20));store.put(a.id,aged(2,{academicPeriod:{id:'P2',label:'z',yearSession:'2026W',term:'2'}}));
  const {ready}=await serveStore(t,store);assert.equal((await (await ready(a.readToken)).json()).state,'ready');
});
test('last_uploaded_at is set on upload, survives the purge and is backfilled for existing rows',t=>{
  const {store,dir}=retained(t),a=store.create('a'),b=store.create('b');
  assert.equal(store.summary(a.id).lastUploadedAt,null);
  const before=Date.now();store.put(a.id,aged(40));
  assert.ok(store.summary(a.id).lastUploadedAt>=before);
  store.purge();assert.ok(store.summary(a.id).lastUploadedAt>=before);
  store.put(b.id,aged(3));const cap=Date.parse(store.summary(b.id).newestCapturedAt);
  store.close();
  const db=new DatabaseSync(join(dir,'connector.sqlite'));db.exec('ALTER TABLE bindings DROP COLUMN last_uploaded_at');db.close();
  const again=new Store(dir);t.after(()=>again.close());
  assert.equal(again.summary(b.id).lastUploadedAt,cap);assert.equal(again.summary(a.id).lastUploadedAt,null);
});
test('readiness: revoked between authentication and the status read is 401',async t=>{
  const {store}=retained(t),a=store.create('a');store.put(a.id,aged(1));
  const original=store.authenticate.bind(store);store.authenticate=(token,mode)=>{const id=original(token,mode);if(id)store.revoke(id);return id;};
  const {ready}=await serveStore(t,store),res=await ready(a.readToken);
  assert.equal(res.status,401);assert.deepEqual(await res.json(),{error:'UNAUTHORIZED'});
});
test('readiness: an unexpected store error is 500, not a snapshot error',async t=>{
  const {store}=retained(t),a=store.create('a');
  store.summary=()=>{throw new Error('database is locked');};
  const {ready}=await serveStore(t,store),res=await ready(a.readToken);
  assert.equal(res.status,500);const text=await res.text();assert.equal(text.includes('SNAPSHOT'),false);assert.equal(text.includes('locked'),false);
});
test('readiness rate limit is per binding after auth and does not touch snapshot reads (or the reverse)',async t=>{
  const {store}=retained(t),a=store.create('a'),b=store.create('b');store.put(a.id,aged(1));
  const {ready,snaps}=await serveStore(t,store);
  let limited=0;for(let i=0;i<300;i++)if((await ready(a.readToken)).status===429)limited++;
  assert.ok(limited>0,'readiness for one binding is limited');
  assert.equal((await ready(b.readToken)).status,200,'other bindings are not affected');
  assert.equal((await snaps(a.readToken)).status,200,'snapshot reads are not affected by readiness traffic');
  let snapLimited=0;for(let i=0;i<260;i++)if((await snaps(b.readToken)).status===429)snapLimited++;
  assert.ok(snapLimited>0);
  const c=store.create('c');assert.equal((await ready(c.readToken)).status,200,'readiness is not affected by snapshot traffic');
});
test('readiness: failed authentication is throttled per IP and spends neither bucket',async t=>{
  const {store}=retained(t),a=store.create('a');
  const {ready,snaps}=await serveStore(t,store);
  let throttled=0;for(let i=0;i<300;i++)if((await ready('x'.repeat(43))).status===429)throttled++;
  assert.ok(throttled>0,'token guessing is throttled');
  assert.equal((await snaps(a.readToken)).status,200,'snapshot reads keep their own bucket');
});
const freePort=()=>new Promise(r=>{const s=netServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
test('cli serve wires readinessFromEnv: bad values refuse to start, the threshold reaches the endpoint',async t=>{
  const run=(env)=>{const child=spawn(process.execPath,['dist/connector/cli.js','serve'],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let err='';child.stderr.on('data',d=>err+=d);t.after(()=>child.kill());return {child,err:()=>err,exit:new Promise(r=>child.on('exit',c=>r(c)))};};
  const dir=mkdtempSync(join(tmpdir(),'ubc-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const seed=new Store(dir),a=seed.create('a');seed.put(a.id,aged(3));seed.close();
  const bad=run({UBC_DATA_DIR:dir,UBC_CONNECTOR_PORT:String(await freePort()),UBC_READINESS_STALE_DAYS:'20'});
  assert.equal(await bad.exit,1);assert.match(bad.err(),/UBC_READINESS_STALE_DAYS must not exceed/);
  const badUrl=run({UBC_DATA_DIR:dir,UBC_CONNECTOR_PORT:String(await freePort()),UBC_COMPANION_INSTALL_URL:'https://u:p@example.org/'});
  assert.equal(await badUrl.exit,1);assert.match(badUrl.err(),/UBC_COMPANION_INSTALL_URL/);
  const port=await freePort(),good=run({UBC_DATA_DIR:dir,UBC_CONNECTOR_PORT:String(port),UBC_READINESS_STALE_DAYS:'2',UBC_COMPANION_INSTALL_URL:'https://example.org/companion'});
  let body;for(let i=0;i<100&&!body;i++){try{const r=await fetch(`http://127.0.0.1:${port}/v1/readiness`,{headers:{Authorization:`Bearer ${a.readToken}`}});body=await r.json();}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.equal(body?.state,'degraded');assert.equal(body.action.url,'https://example.org/companion');
});
test('readiness: an IP over its failure limit still gets 200 for a valid token, while more bad tokens get 429',async t=>{
  const {store}=retained(t),a=store.create('a');store.put(a.id,aged(1));
  const {ready}=await serveStore(t,store);
  let throttled=false;for(let i=0;i<100&&!throttled;i++)throttled=(await ready('x'.repeat(43))).status===429;
  assert.ok(throttled,'failure limit reached');
  assert.equal((await ready('y'.repeat(43))).status,429);
  assert.equal((await ready(a.readToken)).status,200);
  assert.equal((await ready('z'.repeat(43))).status,429);
  assert.equal((await ready(a.readToken)).status,200);
});
