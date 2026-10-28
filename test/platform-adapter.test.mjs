import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {adapterFromEnv} from '../dist/connector/adapters/index.js';
import {VERSION} from '../dist/version.js';
import {createServer} from '../dist/server.js';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
function setup(t){const dir=mkdtempSync(join(tmpdir(),'ubc-adapter-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}

test('version has a single source: package.json',()=>{
  assert.equal(VERSION,pkg.version);
});
test('no adapter by default: platform routes do not exist and healthz reports the version',async t=>{
  const store=setup(t),warnings=[];
  const adapter=adapterFromEnv(store,{},m=>warnings.push(m));assert.equal(adapter,null);assert.deepEqual(warnings,[]);
  const server=connectorServer(store,adapter);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(base+'/healthz')).json(),{ok:true,version:pkg.version});
  for(const path of ['/ubc/','/ubc/app.js','/ubc/capabilities','/ubc/api/status'])assert.equal((await fetch(base+path)).status,404,path);
  const ext='chrome-extension://'+'a'.repeat(32);
  assert.equal((await fetch(base+'/ubc/api/claim',{method:'OPTIONS',headers:{Origin:ext}})).status,404);
  assert.equal((await fetch(base+'/v1/snapshots',{method:'OPTIONS',headers:{Origin:ext}})).status,204);
});
test('legacy variables without UBC_PLATFORM_ADAPTER auto-enable mcphub with a deprecation warning',t=>{
  const store=setup(t);
  for(const env of [{UBC_PUBLIC_ORIGIN:'https://hub.example.test'},{UBC_PUBLIC_ORIGIN:'https://hub.example.test',UBC_HUB_URL:'http://127.0.0.1:1'}]){
    const warnings=[],a=adapterFromEnv(store,env,m=>warnings.push(m));
    assert.equal(a.name,'mcphub');assert.equal(warnings.length,1);assert.match(warnings[0],/DEPRECATED.*UBC_PLATFORM_ADAPTER=mcphub/);
  }
});
test('a stray UBC_HUB_URL alone keeps the adapter off with a warning and does not throw',t=>{
  const store=setup(t),warnings=[];
  assert.equal(adapterFromEnv(store,{UBC_HUB_URL:'https://hub.example.test'},m=>warnings.push(m)),null);
  assert.equal(warnings.length,1);assert.match(warnings[0],/UBC_HUB_URL.*ignored/);
});
test('UBC_PLATFORM_ADAPTER=none wins over legacy variables; nothing set means off',t=>{
  const store=setup(t),warnings=[];
  assert.equal(adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'none',UBC_PUBLIC_ORIGIN:'https://hub.example.test',UBC_HUB_URL:'https://hub.example.test'},m=>warnings.push(m)),null);
  assert.equal(adapterFromEnv(store,{},m=>warnings.push(m)),null);assert.deepEqual(warnings,[]);
});
test('mcphub adapter is selected explicitly and validated',t=>{
  const store=setup(t);
  assert.throws(()=>adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'other'}),/Unknown UBC_PLATFORM_ADAPTER/);
  assert.throws(()=>adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'mcphub'}),/UBC_PUBLIC_ORIGIN/);
  assert.throws(()=>adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'mcphub',UBC_PUBLIC_ORIGIN:'http://hub.example.test'}),/Invalid self-service origin/);
  assert.throws(()=>adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'mcphub',UBC_PUBLIC_ORIGIN:'https://hub.example.test',UBC_PLATFORM_SERVER_NAME:'a/b'}),/server name/);
  for(const bad of ['..','.','...','-a','a/b','a b','x'.repeat(65)])assert.throws(()=>adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'mcphub',UBC_PUBLIC_ORIGIN:'https://hub.example.test',UBC_PLATFORM_SERVER_NAME:bad}),/server name/,bad);
  const a=adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'MCPHub',UBC_PUBLIC_ORIGIN:'https://hub.example.test',UBC_PLATFORM_URL:'http://127.0.0.1:1'});
  assert.equal(a.name,'mcphub');assert.deepEqual(a.preflightPaths,['/ubc/api/claim']);assert.equal(a.handles('/ubc/'),true);assert.equal(a.handles('/v1/snapshots'),false);
});
test('no platform URL is hardcoded in source',async()=>{
  const {readdirSync,readFileSync:read,statSync}=await import('node:fs');
  const hits=[];const walk=d=>{for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p);else if(/kazuhahub/i.test(read(p,'utf8')))hits.push(p);}};
  walk(new URL('../src',import.meta.url).pathname);assert.deepEqual(hits,[]);
});
