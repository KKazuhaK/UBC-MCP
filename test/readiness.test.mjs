import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
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
  return {store,get,url};
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
});
test('readiness: the newest of several snapshots decides freshness',async t=>{
  const {store,get}=await boot(t),a=store.create('a');
  store.put(a.id,aged(12));store.put(a.id,aged(1,{academicPeriod:{id:'2027S-T1',label:'x',yearSession:'2027S',term:'1'}}));
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
  const {store,get}=await boot(t),a=store.create('a');
  assert.equal((await get(a.readToken,{method:'POST',headers:{Authorization:`Bearer ${a.readToken}`,'Content-Type':'application/json'},body:'{}'})).status,404);
  assert.equal((await get(a.readToken,{headers:{Authorization:`Bearer ${a.readToken}`,Origin:'https://example.org'}})).status,403);
  await get(a.readToken);assert.equal(store.get(a.id).length,0);
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
  assert.throws(()=>readinessFromEnv({UBC_COMPANION_INSTALL_URL:'http://example.org'}),/https/);
  assert.throws(()=>readinessFromEnv({UBC_READINESS_STALE_DAYS:'20'},{staleDays:14,deleteDays:30}),/must not exceed/);
  assert.equal(readinessFromEnv({UBC_READINESS_STALE_DAYS:'14'},{staleDays:14,deleteDays:30}).staleDays,14);
});
