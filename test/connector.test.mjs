import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,retentionFromEnv} from '../dist/connector/store.js';
import {DatabaseSync} from 'node:sqlite';
import {connectorServer} from '../dist/connector/http.js';
import {Personal} from '../dist/providers/personal.js';
import {Tools} from '../dist/tools.js';
import {createServer} from '../dist/server.js';
import {snapshot,section} from './fixtures.mjs';

function setup(t){const dir=mkdtempSync(join(tmpdir(),'ubc-test-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};}
function fresh(s={}){return snapshot({capturedAt:new Date().toISOString(),sections:[section({observedAt:new Date(Date.now()-1000).toISOString()})],...s});}

test('bindings isolate reads and upload/read credentials have distinct scopes',t=>{
  const {store}=setup(t),a=store.create('a'),b=store.create('b');
  assert.equal(store.authenticate(a.uploadToken,'read'),null);assert.equal(store.authenticate(a.readToken,'upload'),null);
  store.put(a.id,fresh());assert.equal(store.get(a.id).length,1);assert.equal(store.get(b.id).length,0);
  assert.equal(store.authenticate(a.readToken,'read'),a.id);
});
test('snapshot bodies and bearer tokens are not plaintext in database',t=>{
  const {store,dir}=setup(t),a=store.create('a');store.put(a.id,fresh());
  for(const suffix of ['', '-wal']){let bytes;try{bytes=readFileSync(join(dir,'connector.sqlite'+suffix));}catch{continue;}
    assert.equal(bytes.includes(Buffer.from('Computation, Programs, and Programming')),false);
    assert.equal(bytes.includes(Buffer.from(a.readToken)),false);}
});
test('revocation invalidates both credential scopes and deletes snapshots immediately',t=>{
  const {store}=setup(t),a=store.create('a');store.put(a.id,fresh());store.revoke(a.id);
  assert.equal(store.authenticate(a.readToken,'read'),null);assert.equal(store.authenticate(a.uploadToken,'upload'),null);
  assert.throws(()=>store.get(a.id));assert.throws(()=>store.put(a.id,fresh()));
});
test('older snapshots cannot overwrite a newer observation',t=>{
  const {store}=setup(t),a=store.create('a'),s=fresh();store.put(a.id,s);
  assert.throws(()=>store.put(a.id,s),/older than or equal/);
});
test('registration sync cannot replace section availability for the same period',t=>{
  const {store}=setup(t),a=store.create('a'),s=fresh();store.put(a.id,s);
  store.put(a.id,{...s,kind:'registrations',enrollments:[{sectionId:s.sections[0].id,state:'enrolled'}]});
  assert.equal(store.get(a.id).length,2);assert.deepEqual(store.get(a.id).map(s=>s.kind).sort(),['registrations','sections']);
});
test('existing encrypted database refuses to recreate lost encryption key',t=>{
  const {store,dir}=setup(t);unlinkSync(join(dir,'encryption.key'));
  assert.throws(()=>new Store(dir),/missing its encryption key/);
});
test('HTTP connector refuses unauthenticated access, cookie browser origins and cross-scope tokens',async t=>{
  const {store}=setup(t),a=store.create('a'),server=connectorServer(store);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/v1/snapshots`;
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${a.uploadToken}`}})).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${a.readToken}`,Origin:'https://example.org'}})).status,403);
  const pushed=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${a.uploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(fresh())});assert.equal(pushed.status,200);
  const personal=new Personal({url:`http://127.0.0.1:${server.address().port}`,token:a.readToken});
  assert.equal((await personal.snapshots()).length,1);
  store.revoke(a.id);await assert.rejects(()=>personal.snapshots(),/revoked/);
});
test('public profile never exposes personal tools even if personal env is present',()=>{
  const {tools}=createServer({UBC_PROFILE:'public',UBC_SNAPSHOT_FILE:'not-a-file'});
  assert.equal(tools.definitions().some(t=>t.name==='get_my_schedule'),false);
  assert.throws(()=>createServer({UBC_PROFILE:'personal'}),/requires its own/);
});
test('open-only does not treat stale observations as available',async()=>{
  const p=new Personal({});p.configured=()=>true;p.snapshots=async()=>[fresh({sections:[section({observedAt:new Date(Date.now()-360000).toISOString()})]})];
  const tool=new Tools(p).definitions().find(t=>t.name==='search_sections');
  const result=await tool.run({campus:'UBCV',academicPeriod:'2026W-T1',openOnly:true,limit:30});
  assert.equal(result.sections.length,0);
});

// Retention: snapshots older than 14 days are not served, older than 30 days are deleted.
const DAYS=86_400_000;
const ago=days=>new Date(Date.now()-days*DAYS).toISOString();
const aged=days=>fresh({capturedAt:ago(days),sections:[section({observedAt:ago(days+0.001)})]});
function clocked(t,retention){const dir=mkdtempSync(join(tmpdir(),'ubc-test-')),clock={now:Date.now()};
  const store=new Store(dir,retention,()=>clock.now);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir,clock};}
test('snapshots older than the stale window are not served, and the tools say to sync again',async t=>{
  const {store}=clocked(t),a=store.create('a');
  store.put(a.id,aged(13));assert.equal(store.get(a.id).length,1);
  const b=store.create('b');store.put(b.id,aged(15));assert.equal(store.get(b.id).length,0);
  const tools=new Tools({configured:()=>true,snapshots:async()=>store.get(b.id)});
  assert.deepEqual((await tools.definitions().find(d=>d.name==='get_data_status').run()).personal.periods,[]);
  await assert.rejects(()=>tools.period('UBCV','x'),/older than the retention window.*sync again/s);
  store.put(b.id,fresh());assert.equal(store.get(b.id).length,1);
});
test('purge deletes snapshots older than the delete window and keeps newer ones',t=>{
  const {store}=clocked(t),a=store.create('a');
  store.put(a.id,aged(31));store.put(a.id,{...aged(20),kind:'registrations',enrollments:[]});
  assert.deepEqual(store.purge(),{snapshots:1,bindings:0});
  assert.deepEqual(store.purge(),{snapshots:0,bindings:0});
  assert.equal(store.authenticate(a.readToken,'read'),a.id);
});
test('a revoked binding is rejected, then its row is purged after the delete window',t=>{
  const {store,dir,clock}=clocked(t),a=store.create('secret label'),b=store.create('b');
  store.put(a.id,fresh());store.revoke(a.id);
  const row=()=>{const db=new DatabaseSync(join(dir,'connector.sqlite'));try{return db.prepare('SELECT label FROM bindings WHERE id=?').get(a.id);}finally{db.close();}};
  assert.equal(row().label,'');
  clock.now+=29*DAYS;store.purge();assert.ok(row());assert.equal(store.authenticate(a.readToken,'read'),null);
  clock.now+=2*DAYS;assert.deepEqual(store.purge(),{snapshots:0,bindings:1});
  assert.equal(row(),undefined);assert.equal(store.authenticate(a.readToken,'read'),null);assert.equal(store.authenticate(a.uploadToken,'upload'),null);
  assert.throws(()=>store.get(a.id),/revoked/);
  assert.equal(store.authenticate(b.readToken,'read'),b.id);
});
test('revoked bindings from before revoked_at get a retention clock on upgrade',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ubc-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=new Store(dir),a=first.create('a');first.revoke(a.id);first.close();
  const db=new DatabaseSync(join(dir,'connector.sqlite'));db.exec('ALTER TABLE bindings DROP COLUMN revoked_at');db.close();
  const clock={now:Date.now()},again=new Store(dir,undefined,()=>clock.now);t.after(()=>again.close());
  assert.deepEqual(again.purge(),{snapshots:0,bindings:0});
  clock.now+=31*DAYS;assert.deepEqual(again.purge(),{snapshots:0,bindings:1});
});
test('retention defaults and environment overrides',t=>{
  assert.deepEqual(retentionFromEnv({}),{staleDays:14,deleteDays:30});
  assert.deepEqual(retentionFromEnv({UBC_SNAPSHOT_STALE_DAYS:'3',UBC_SNAPSHOT_DELETE_DAYS:'7'}),{staleDays:3,deleteDays:7});
  assert.throws(()=>retentionFromEnv({UBC_SNAPSHOT_STALE_DAYS:'0'}),/positive/);
  assert.throws(()=>retentionFromEnv({UBC_SNAPSHOT_DELETE_DAYS:'abc'}),/positive/);
  assert.throws(()=>retentionFromEnv({UBC_SNAPSHOT_STALE_DAYS:'20',UBC_SNAPSHOT_DELETE_DAYS:'10'}),/must not exceed/);
  const {store}=clocked(t,{staleDays:1,deleteDays:3}),a=store.create('a');
  store.put(a.id,aged(2));assert.equal(store.get(a.id).length,0);assert.deepEqual(store.purge(),{snapshots:0,bindings:0});
  const b=store.create('b');store.put(b.id,aged(4));assert.deepEqual(store.purge(),{snapshots:1,bindings:0});
});
