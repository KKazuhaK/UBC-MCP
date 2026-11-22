import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {mcpConfigFromEnv,mcpResource} from '../dist/connector/mcp-http.js';
import {snapshot,section} from './fixtures.mjs';

const DAY=86_400_000,now=()=>Math.floor(Date.now()/1000);
const aged=(days,extra={})=>snapshot({capturedAt:new Date(Date.now()-days*DAY).toISOString(),sections:[section({observedAt:new Date(Date.now()-days*DAY-1000).toISOString()})],...extra});
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fakeIssuer(t){
  const issuer={keys:[],down:false},{publicKey,privateKey}=await generateKeyPair('ES256');
  issuer.key={privateKey,kid:'es-1',alg:'ES256'};issuer.keys.push({...await exportJWK(publicKey),kid:'es-1',alg:'ES256',use:'sig'});
  issuer.rogue=await generateKeyPair('ES256');
  const server=createServer((req,res)=>{const base=`http://127.0.0.1:${server.address().port}`,json=(s,v)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    if(issuer.down)return json(503,{});
    if(req.url==='/.well-known/oauth-authorization-server')return json(200,{issuer:base,jwks_uri:base+'/jwks'});
    if(req.url==='/jwks')return json(200,{keys:issuer.keys});json(404,{});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  issuer.url=`http://127.0.0.1:${server.address().port}`;return issuer;
}
const fakeAdapter={name:'fake',preflightPaths:[],handles:u=>u.startsWith('/ubc'),handle:async(req,res)=>{res.writeHead(204);res.end();}};
async function setup(t,{hosted=true,adapter=true,publicOrigin='https://ubc.example.test',over=()=>({})}={}){
  const dir=mkdtempSync(join(tmpdir(),'ubc-ready-oauth-')),store=new Store(dir),issuer=await fakeIssuer(t),port=await freePort();
  const origin=`http://127.0.0.1:${port}`,resource=`${publicOrigin}/mcp`;
  const config={...mcpConfigFromEnv({UBC_MCP_HTTP:'on',UBC_PUBLIC_ORIGIN:publicOrigin,UBC_OAUTH_ISSUER:issuer.url}),...over(issuer)};
  const server=connectorServer(store,adapter?fakeAdapter:null,hosted?mcpResource(store,config,{log:()=>{}}):null);
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(()=>{store.close();rmSync(dir,{recursive:true,force:true});r();});}));
  const mint=async(sub,o={})=>{
    let jwt=new SignJWT({scope:''}).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:'es-1'}).setIssuedAt().setIssuer(o.iss??issuer.url).setAudience(o.aud??resource).setJti('j'+Math.random());
    if(sub!==null)jwt=jwt.setSubject(sub);
    jwt=jwt.setExpirationTime(o.exp??now()+300);
    return jwt.sign(o.key??issuer.key.privateKey);
  };
  const ready=token=>fetch(origin+'/v1/readiness',{headers:token?{Authorization:`Bearer ${token}`}:{}});
  const account=sub=>store.linkedAccount(issuer.url,sub,true);
  return {store,issuer,origin,mint,ready,account,pub:publicOrigin,resource};
}

test('hosted readiness: a valid token with no binding is needs_setup pointing at the connection page',async t=>{
  const {mint,ready,pub}=await setup(t);
  const res=await ready(await mint('alice'));assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.version,1);assert.equal(body.state,'needs_setup');
  assert.deepEqual(body.action,{label:'Connect your UBC data',url:`${pub}/ubc/`});
  assert.equal(body.summary,"Your UBC data isn't connected to this account yet. Connect it, then sync from Workday with the UBC companion.");
  assert.doesNotMatch(body.summary,/Install/);
  assert.ok(!Number.isNaN(Date.parse(body.checked_at)));
});
test('hosted readiness: a bound account reports each state',async t=>{
  const {mint,ready,account,store,pub}=await setup(t);
  const noData=account('nodata'),fresh=account('fresh'),old=account('old'),gone=account('gone');
  store.put(fresh.id,aged(1));store.put(old.id,aged(9));store.put(gone.id,aged(20));
  const state=async sub=>(await (await ready(await mint(sub))).json());
  const a=await state('nodata');assert.equal(a.state,'needs_setup');assert.equal(a.action.label,'Install the UBC browser companion');assert.notEqual(a.action.url,`${pub}/ubc/`);
  assert.equal((await state('fresh')).state,'ready');
  // Stale data is fixed from the connection page, where the extension syncs with one click.
  const d=await state('old');assert.equal(d.state,'degraded');assert.deepEqual(d.action,{label:'Sync now from the UBC page',url:`${pub}/ubc/`});
  assert.equal((await state('gone')).state,'expired');
});
test('hosted readiness: wrong issuer, wrong audience, expired, missing sub, unknown key and junk are 401',async t=>{
  const {mint,ready,issuer}=await setup(t);
  const bad=[await mint('alice',{iss:'https://evil.example.test'}),await mint('alice',{aud:'https://other.example.test/mcp'}),await mint('alice',{exp:now()-600}),
    await mint(null),await mint('alice',{key:issuer.rogue.privateKey}),'a.b.c','not-a-token'];
  for(const token of bad){const res=await ready(token);assert.equal(res.status,401);assert.deepEqual(await res.json(),{error:'UNAUTHORIZED'});}
  assert.equal((await ready(null)).status,401);
});
test('readiness without the hosted adapter rejects OAuth bearers',async t=>{
  const {mint,ready}=await setup(t,{hosted:false});
  assert.equal((await ready(await mint('alice'))).status,401);
});
test('hosted readiness: READ tokens keep working beside OAuth, and the upload token still does not',async t=>{
  const {ready,account}=await setup(t),a=account('alice');
  assert.equal((await (await ready(a.readToken)).json()).state,'needs_setup');
  assert.equal((await ready(a.uploadToken)).status,401);
});
test('hosted readiness: a token for account A never reveals binding B',async t=>{
  const {mint,ready,account,store}=await setup(t),a=account('alice'),b=account('bob');
  store.put(a.id,aged(1));store.put(b.id,aged(9));
  const ta=await (await ready(await mint('alice'))).text(),tb=await (await ready(await mint('bob'))).text();
  assert.equal(JSON.parse(ta).state,'ready');assert.equal(JSON.parse(tb).state,'degraded');
  for(const text of [ta,tb])for(const needle of [a.id,b.id,a.readToken,b.readToken,'alice','bob','CPSC'])assert.equal(text.includes(needle),false,needle);
  assert.equal(JSON.parse(await (await ready(await mint('carol'))).text()).state,'needs_setup');
});
test('hosted readiness: a revoked binding no longer resolves, so the user is asked to connect again',async t=>{
  const {mint,ready,account,store,pub}=await setup(t),a=account('alice');store.put(a.id,aged(1));
  assert.equal((await (await ready(await mint('alice'))).json()).state,'ready');
  store.revoke(a.id);
  const res=await ready(await mint('alice'));assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.state,'needs_setup');assert.equal(body.action.url,`${pub}/ubc/`);
  assert.equal((await ready(a.readToken)).status,401);
});
test('hosted readiness: bad OAuth tokens are throttled per IP but a valid token is never blocked',async t=>{
  const {mint,ready}=await setup(t);
  let throttled=false;for(let i=0;i<100&&!throttled;i++)throttled=(await ready(await mint('alice',{aud:'https://other.example.test/mcp'}))).status===429;
  assert.ok(throttled);
  assert.equal((await ready(await mint('alice'))).status,200);
});
test('hosted readiness: the same subject is limited per account, other accounts are not',async t=>{
  const {mint,ready,account}=await setup(t);account('alice');account('bob');
  const token=await mint('alice');let limited=0;for(let i=0;i<80;i++)if((await ready(token)).status===429)limited++;
  assert.ok(limited>0);
  assert.equal((await ready(await mint('bob'))).status,200);
});

test('hosted readiness: the connection-page action needs the adapter that serves /ubc/ and an https origin; the summary stays',async t=>{
  for(const opts of [{adapter:false},{publicOrigin:'http://localhost:8792'},{adapter:false,publicOrigin:'http://localhost:8792'}]){
    const {mint,ready}=await setup(t,opts),body=await (await ready(await mint('alice'))).json();
    assert.equal(body.state,'needs_setup');assert.equal('action' in body,false,JSON.stringify(opts));
    assert.match(body.summary,/isn't connected to this account yet/);
  }
  const {mint,ready,pub}=await setup(t),body=await (await ready(await mint('alice'))).json();
  assert.equal(body.action.url,`${pub}/ubc/`);
});
test('hosted readiness: an unreachable issuer is 503, not 401',async t=>{
  const {mint,ready,issuer}=await setup(t),token=await mint('alice');issuer.down=true;
  assert.equal((await ready(token)).status,503);
});
test('hosted readiness: a legacy username-keyed account is adopted by a readiness call exactly as by /mcp',async t=>{
  const legacy=(store)=>{const a=store.account('lee',true);store.put(a.id,aged(1));return a;};
  const viaReadiness=await setup(t,{over:i=>({platformUrl:i.url})}),l1=legacy(viaReadiness.store);
  assert.equal((await (await viaReadiness.ready(await viaReadiness.mint('lee'))).json()).state,'ready');
  const adopted1=viaReadiness.store.linkedAccount(viaReadiness.issuer.url,'lee',false);
  const viaMcp=await setup(t,{over:i=>({platformUrl:i.url})}),l2=legacy(viaMcp.store);
  const res=await fetch(viaMcp.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${await viaMcp.mint('lee')}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});
  assert.equal(res.status,200);
  const adopted2=viaMcp.store.linkedAccount(viaMcp.issuer.url,'lee',false);
  assert.equal(adopted1?.id,l1.id);assert.equal(adopted2?.id,l2.id);
  // Not the platform's authority: neither path adopts, and readiness says unbound.
  const stranger=await setup(t,{over:()=>({platformUrl:null})});legacy(stranger.store);
  assert.equal((await (await stranger.ready(await stranger.mint('lee'))).json()).summary.includes("isn't connected"),true);
  assert.equal(stranger.store.linkedAccount(stranger.issuer.url,'lee',false),null);
});
test('hosted readiness: a valid token still gets 200 after bad tokens for other subjects saturate the IP failure guard',async t=>{
  const {mint,ready}=await setup(t),good=await mint('alice');
  let throttled=false;for(let i=0;i<100&&!throttled;i++)throttled=(await ready(await mint('mallory'+i,{aud:'https://other.example.test/mcp'}))).status===429;
  assert.ok(throttled);
  assert.equal((await ready(await mint('mallory-late',{aud:'https://other.example.test/mcp'}))).status,429);
  assert.equal((await ready(good)).status,200);
});
test('readiness accepts the bearer forms /mcp accepts: any scheme case and extra whitespace',async t=>{
  const {mint,account,origin}=await setup(t),a=account('alice'),oauth=await mint('alice');
  for(const token of [a.readToken,oauth])for(const header of [`bearer ${token}`,`BEARER ${token}`,`Bearer   ${token}`,`Bearer\t${token}`]){
    const res=await fetch(origin+'/v1/readiness',{headers:{Authorization:header}});assert.equal(res.status,200,header);
  }
  assert.equal((await fetch(origin+'/v1/readiness',{headers:{Authorization:`Basic ${oauth}`}})).status,401);
  assert.equal((await fetch(origin+'/v1/readiness',{headers:{Authorization:`Bearer${oauth}`}})).status,401);
});
