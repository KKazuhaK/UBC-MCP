import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {mcpConfigFromEnv,mcpResource} from '../dist/connector/mcp-http.js';
import {snapshot,section} from './fixtures.mjs';

const PERIOD='2026W-T1';
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const now=()=>Math.floor(Date.now()/1000);

// A fake authorization server: metadata (RFC 8414, optionally only OpenID) plus a JWKS.
async function fakeIssuer(t,{openidOnly=false}={}) {
  const issuer={keys:[],hits:0,down:false,jwksBody:null};
  const add=async(alg,kid)=>{const {publicKey,privateKey}=await generateKeyPair(alg);const jwk={...await exportJWK(publicKey),kid,alg,use:'sig'};issuer.keys.push(jwk);return {privateKey,kid,alg};};
  issuer.es=await add('ES256','es-1');issuer.rs=await add('RS256','rs-1');
  issuer.rogue=await generateKeyPair('ES256');  // never published
  const server=createServer((req,res)=>{
    issuer.hits++;
    const base=`http://127.0.0.1:${server.address().port}`,json=(s,v)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    if(issuer.down)return json(503,{});
    if(req.url==='/.well-known/oauth-authorization-server')return openidOnly?json(404,{}):json(200,{issuer:base,jwks_uri:base+'/jwks'});
    if(req.url==='/.well-known/openid-configuration')return json(200,{issuer:base,jwks_uri:base+'/jwks'});
    if(req.url==='/jwks')return issuer.jwksBody!==null?(res.writeHead(200,{'Content-Type':'application/json'}),res.end(issuer.jwksBody)):json(200,{keys:issuer.keys});
    json(404,{});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  issuer.url=`http://127.0.0.1:${server.address().port}`;return issuer;
}

async function setup(t,{openidOnly=false,configure=true,over=()=>({}),platform=null}={}) {
  const dir=mkdtempSync(join(tmpdir(),'ubc-mcp-res-')),store=new Store(dir),issuer=await fakeIssuer(t,{openidOnly}),port=await freePort(),logs=[];
  const origin=`http://127.0.0.1:${port}`,resource=`${origin}/mcp`;
  const config={...mcpConfigFromEnv({UBC_MCP_HTTP:'on',UBC_PUBLIC_ORIGIN:origin,UBC_OAUTH_ISSUER:issuer.url}),...over(issuer,platform)};
  const server=connectorServer(store,null,configure?mcpResource(store,config,{log:m=>logs.push(m)}):null);
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(()=>{store.close();rmSync(dir,{recursive:true,force:true});r();});}));
  // Mint access tokens the way the contract says.
  const mint=async(sub,over={},key=issuer.es,header={})=>{
    const claims={scope:'',...over.claims};
    let jwt=new SignJWT(claims).setProtectedHeader({alg:key.alg,typ:'at+jwt',kid:key.kid,...header}).setSubject(sub).setIssuedAt()
      .setIssuer(over.iss??issuer.url).setAudience(over.aud??resource).setJti('j'+Math.random());
    if(over.exp!==null)jwt=jwt.setExpirationTime(over.exp??now()+300);
    return jwt.sign(key.privateKey);
  };
  store.issuerForTests=issuer.url;
  return {store,issuer,origin,resource,config,logs,mint,url:resource};
}
function seed(store,user,title,id) {
  const account=store.linkedAccount(store.issuerForTests,user,true),at=new Date().toISOString();
  store.put(account.id,snapshot({capturedAt:at,sections:[section({id,code:'CPSC_V 110 101',title,observedAt:at})]}));return account;
}
const text=r=>r.content[0].text;
const data=r=>JSON.parse(text(r).split('\n').slice(1,-1).join('\n'));
async function client(url,token) {
  const c=new Client({name:'ubc-mcp-resource-test',version:'1.0.0'});
  await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return c;
}
const rpc=(url,token,body=JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}),extra={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:`Bearer ${token}`}:{}),...extra},body});

test('the endpoint is off by default: /mcp and the metadata do not exist',async t=>{
  assert.equal(mcpConfigFromEnv({}),null);assert.equal(mcpConfigFromEnv({UBC_MCP_HTTP:'off',UBC_OAUTH_ISSUER:'x'}),null);
  const s=await setup(t,{configure:false});
  assert.equal((await rpc(s.url,'x')).status,404);
  assert.equal((await fetch(s.origin+'/.well-known/oauth-protected-resource')).status,404);
  assert.equal((await fetch(s.origin+'/healthz')).status,200);
});
test('configuration is validated at startup',()=>{
  const ok={UBC_MCP_HTTP:'on',UBC_PUBLIC_ORIGIN:'https://ubc.example.test',UBC_OAUTH_ISSUER:'https://auth.example.test'};
  assert.deepEqual(mcpConfigFromEnv(ok),{origin:'https://ubc.example.test',issuer:'https://auth.example.test',resource:'https://ubc.example.test/mcp',audience:'https://ubc.example.test/mcp',
    requireAtJwt:true,trustProxy:0,platformUrl:'https://ubc.example.test'});  // legacy auto-enable of the mcphub adapter points at the origin
  assert.equal(mcpConfigFromEnv({...ok,UBC_PLATFORM_ADAPTER:'none'}).platformUrl,null);
  assert.equal(mcpConfigFromEnv({...ok,UBC_PLATFORM_ADAPTER:'mcphub-oauth',UBC_PLATFORM_URL:'http://hub:3000/'}).platformUrl,'http://hub:3000');
  assert.equal(mcpConfigFromEnv({...ok,UBC_TRUST_PROXY:'2',UBC_OAUTH_REQUIRE_AT_JWT:'false'}).trustProxy,2);
  assert.equal(mcpConfigFromEnv({...ok,UBC_OAUTH_REQUIRE_AT_JWT:'false'}).requireAtJwt,false);
  for(const bad of [{UBC_TRUST_PROXY:'-1'},{UBC_TRUST_PROXY:'many'},{UBC_OAUTH_REQUIRE_AT_JWT:'maybe'}])assert.throws(()=>mcpConfigFromEnv({...ok,...bad}));
  assert.equal(mcpConfigFromEnv({...ok,UBC_MCP_RESOURCE:'https://r.example.test/x',UBC_OAUTH_AUDIENCE:'aud-1'}).audience,'aud-1');
  assert.equal(mcpConfigFromEnv({...ok,UBC_MCP_RESOURCE:'https://r.example.test/x'}).audience,'https://r.example.test/x');
  assert.equal(mcpConfigFromEnv({...ok,UBC_PUBLIC_ORIGIN:'http://localhost:8792',UBC_OAUTH_ISSUER:'http://127.0.0.1:9'}).resource,'http://localhost:8792/mcp');
  for(const bad of [{UBC_MCP_HTTP:'yes'},{UBC_PUBLIC_ORIGIN:''},{UBC_OAUTH_ISSUER:''},{UBC_OAUTH_ISSUER:'http://auth.example.test'},{UBC_PUBLIC_ORIGIN:'http://ubc.example.test'},
    {UBC_PUBLIC_ORIGIN:'https://ubc.example.test/app'},{UBC_OAUTH_ISSUER:'https://u:p@auth.example.test'},{UBC_OAUTH_ISSUER:'https://auth.example.test?x=1'},{UBC_MCP_RESOURCE:'https://r.example.test/x#f'},{UBC_OAUTH_ISSUER:'not a url'}])
    assert.throws(()=>mcpConfigFromEnv({...ok,...bad}),Error,JSON.stringify(bad));
});
test('protected resource metadata (RFC 9728) has the contracted shape',async t=>{
  const s=await setup(t);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) {
    const r=await fetch(s.origin+path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/application\/json/);
    assert.deepEqual(await r.json(),{resource:s.resource,authorization_servers:[s.issuer.url],bearer_methods_supported:['header'],scopes_supported:[]});
    assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  assert.equal((await fetch(s.origin+'/.well-known/oauth-protected-resource',{method:'POST'})).status,405);
});
test('no token: 401 with the resource_metadata challenge and no error code',async t=>{
  const s=await setup(t);
  const r=await rpc(s.url,null);assert.equal(r.status,401);
  assert.equal(r.headers.get('www-authenticate'),`Bearer resource_metadata="${s.origin}/.well-known/oauth-protected-resource"`);
  assert.equal((await fetch(s.url,{headers:{Authorization:'Basic dXNlcjpwdw=='}})).status,401);
  assert.equal(s.issuer.hits,0);
});
test('a valid token lists tools and serves the right user their own snapshot, nobody else\'s',async t=>{
  const s=await setup(t);
  seed(s.store,'alice','ALICE-ONLY-TITLE','CPSC_V-110-A');seed(s.store,'bob','BOB-ONLY-TITLE','CPSC_V-110-B');
  const alice=await client(s.url,await s.mint('alice')),bob=await client(s.url,await s.mint('bob')),carol=await client(s.url,await s.mint('carol'));
  t.after(()=>Promise.all([alice.close(),bob.close(),carol.close()]));
  const names=(await alice.listTools()).tools.map(x=>x.name);
  for(const n of ['get_course','search_courses','get_data_status','search_sections','get_section_availability','get_my_schedule','check_schedule'])assert.ok(names.includes(n),n);
  const args={campus:'UBCV',academicPeriod:PERIOD};
  const [a,b]=await Promise.all([alice.callTool({name:'search_sections',arguments:args}),bob.callTool({name:'search_sections',arguments:args})]);
  assert.ok(!a.isError);assert.deepEqual(data(a).sections.map(x=>x.title),['ALICE-ONLY-TITLE']);assert.deepEqual(data(b).sections.map(x=>x.title),['BOB-ONLY-TITLE']);
  assert.doesNotMatch(text(a),/BOB-ONLY/);assert.doesNotMatch(text(b),/ALICE-ONLY/);
  const status=data(await alice.callTool({name:'get_data_status',arguments:{}}));assert.equal(status.personal.connected,true);assert.equal(status.personal.periods.length,1);
  // Alice cannot reach Bob's section by id.
  const cross=await alice.callTool({name:'get_section_availability',arguments:{...args,sectionId:'CPSC_V-110-B'}});assert.ok(cross.isError);assert.doesNotMatch(text(cross),/BOB-ONLY/);
  // No account: personal tools return the structured not-connected error, public tools still work.
  const none=await carol.callTool({name:'search_sections',arguments:args});assert.ok(none.isError);assert.equal(JSON.parse(text(none)).error,'CONNECTION_REVOKED');
  const nstatus=data(await carol.callTool({name:'get_data_status',arguments:{}}));assert.equal(nstatus.personal.connected,false);assert.equal(nstatus.personal.error,'CONNECTION_REVOKED');
  assert.ok(!(await carol.callTool({name:'get_course',arguments:{campus:'UBCV',subject:'../x',course:'110'}})).content.some(c=>/ALICE|BOB/.test(c.text))); // validated input error, public tool reachable
  // Account without snapshots: connected, but nothing captured (not an empty schedule).
  s.store.linkedAccount(s.issuer.url,'dave',true);const dave=await client(s.url,await s.mint('dave'));t.after(()=>dave.close());
  assert.equal(JSON.parse(text(await dave.callTool({name:'search_sections',arguments:args}))).error,'PERIOD_NOT_CAPTURED');
});
test('RS256 tokens, an audience array and small clock skew are accepted',async t=>{
  const s=await setup(t);seed(s.store,'alice','ALICE-ONLY-TITLE','CPSC_V-110-A');
  for(const token of [await s.mint('alice',{},s.issuer.rs),await s.mint('alice',{aud:[s.resource,'https://other.example']}) ,await s.mint('alice',{exp:now()-30}),await s.mint('alice',{claims:{scope:'a b'}})]) {
    const r=await rpc(s.url,token);assert.equal(r.status,200,await r.clone().text());
  }
});
test('invalid tokens are refused with 401 invalid_token',async t=>{
  const s=await setup(t);seed(s.store,'alice','ALICE-ONLY-TITLE','CPSC_V-110-A');
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const hs=await new SignJWT({}).setProtectedHeader({alg:'HS256',typ:'at+jwt',kid:'es-1'}).setSubject('alice').setIssuer(s.issuer.url).setAudience(s.resource).setExpirationTime(now()+300).sign(new TextEncoder().encode('x'.repeat(32)));
  const good=await s.mint('alice'),[h,p,sig]=good.split('.');
  const cases={
    'wrong audience':await s.mint('alice',{aud:'https://other.example/mcp'}),
    'audience prefix':await s.mint('alice',{aud:s.resource+'/'}),
    'wrong issuer':await s.mint('alice',{iss:'https://evil.example'}),
    'expired':await s.mint('alice',{exp:now()-120}),
    'no exp':await s.mint('alice',{exp:null}),
    'wrong typ':await s.mint('alice',{},s.issuer.es,{typ:'JWT'}),
    'no typ':await s.mint('alice',{},s.issuer.es,{typ:undefined}),
    'unknown kid':await s.mint('alice',{},{...s.issuer.rogue,alg:'ES256',kid:'rogue'}),
    'known kid, rogue signature':await s.mint('alice',{},{...s.issuer.rogue,alg:'ES256',kid:'es-1'}),
    'alg none':`${b64({alg:'none',typ:'at+jwt'})}.${p}.`,
    'alg none with signature':`${b64({alg:'none',typ:'at+jwt'})}.${p}.${sig}`,
    'HS256':hs,
    'tampered payload':`${h}.${b64({...JSON.parse(Buffer.from(p,'base64url')),sub:'bob'})}.${sig}`,
    'garbage':'not-a-jwt',
    'empty subject':await s.mint('',{}),
  };
  for(const [name,token] of Object.entries(cases)) {
    const r=await rpc(s.url,token);assert.equal(r.status,401,name);
    assert.equal(r.headers.get('www-authenticate'),`Bearer error="invalid_token", resource_metadata="${s.origin}/.well-known/oauth-protected-resource"`,name);
    assert.doesNotMatch(await r.text(),/ALICE/,name);
  }
  const miss=await s.mint('alice',{});const noSub=await new SignJWT({}).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:'es-1'}).setIssuer(s.issuer.url).setAudience(s.resource).setExpirationTime(now()+300).sign(s.issuer.es.privateKey);
  assert.equal((await rpc(s.url,noSub)).status,401);assert.equal((await rpc(s.url,miss)).status,200);
});
test('discovery falls back to openid-configuration; an unreachable issuer is 503 not a silent allow',async t=>{
  const s=await setup(t,{openidOnly:true});
  assert.equal((await rpc(s.url,await s.mint('alice'))).status,200);
  const down=await setup(t);down.issuer.down=true;
  const r=await rpc(down.url,await down.mint('alice'));assert.equal(r.status,503);assert.equal(r.headers.get('www-authenticate'),null);
});
test('browser access is closed: no CORS, Origin refused, only POST/GET/DELETE',async t=>{
  const s=await setup(t),token=await s.mint('alice');
  const o=await rpc(s.url,token,undefined,{Origin:'https://evil.example'});assert.equal(o.status,403);assert.equal(o.headers.get('access-control-allow-origin'),null);
  const pre=await fetch(s.url,{method:'OPTIONS',headers:{Origin:'https://evil.example','Access-Control-Request-Method':'POST'}});
  assert.ok([403,405].includes(pre.status));assert.equal(pre.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(s.url,{method:'PUT',headers:{Authorization:`Bearer ${token}`}})).status,405);
  const ok=await rpc(s.url,token);assert.equal(ok.headers.get('access-control-allow-origin'),null);
});
test('request bodies are size limited',async t=>{
  const s=await setup(t),token=await s.mint('alice');
  const r=await rpc(s.url,token,JSON.stringify({jsonrpc:'2.0',id:1,method:'ping',params:{pad:'x'.repeat(1_100_000)}}));assert.equal(r.status,413);
});
test('tokens never reach logs or responses',async t=>{
  const s=await setup(t),captured=[];
  const orig={log:console.log,error:console.error,warn:console.warn};
  for(const k of Object.keys(orig))console[k]=(...a)=>captured.push(a.join(' '));
  const good=await s.mint('alice'),bad=await s.mint('alice',{aud:'https://other.example'});
  try {
    const c=await client(s.url,good);await c.callTool({name:'get_data_status',arguments:{}});await c.close();
    const r=await rpc(s.url,bad);await r.text();
    s.issuer.down=true;const badTwo=await s.mint('alice',{aud:'https://x.example'});await (await rpc(s.url,badTwo)).text();
    s.issuer.down=false;
  }finally{Object.assign(console,orig);}
  for(const secret of [good,bad,good.split('.')[2],bad.split('.')[2]])for(const line of [...captured,...s.logs])assert.ok(!line.includes(secret));
});
test('the READ-token snapshot API and per-user isolation are unchanged by the endpoint',async t=>{
  const s=await setup(t);const alice=seed(s.store,'alice','ALICE-ONLY-TITLE','CPSC_V-110-A'),bob=seed(s.store,'bob','BOB-ONLY-TITLE','CPSC_V-110-B');
  const get=async tok=>fetch(s.origin+'/v1/snapshots',{headers:{Authorization:`Bearer ${tok}`}});
  const a=await get(alice.readToken);assert.equal(a.status,200);assert.deepEqual((await a.json()).flatMap(x=>x.sections.map(y=>y.title)),['ALICE-ONLY-TITLE']);
  assert.equal((await get(await s.mint('alice'))).status,401);  // an OAuth token is not a READ token
  assert.equal((await get(bob.uploadToken)).status,401);
});

test('an account is bound to its issuer: a colliding sub from another issuer reads nothing',async t=>{
  const s=await setup(t);
  seed(s.store,'alice','ALICE-ONLY-TITLE','CPSC_V-110-A');
  // Same username, linked to a different authority, with its own data.
  const other=s.store.linkedAccount('https://other-issuer.example','zed',true),at=new Date().toISOString();
  s.store.put(other.id,snapshot({capturedAt:at,sections:[section({id:'Z',title:'ZED-ONLY-TITLE',observedAt:at})]}));
  const args={campus:'UBCV',academicPeriod:PERIOD};
  const zed=await client(s.url,await s.mint('zed'));t.after(()=>zed.close());
  const r=await zed.callTool({name:'search_sections',arguments:args});assert.ok(r.isError);assert.equal(JSON.parse(text(r)).error,'CONNECTION_REVOKED');assert.doesNotMatch(text(r),/ZED-ONLY/);
  // The same issuer (trailing slash is not significant) reads it; the other issuer's account is separate from a same-named one here.
  s.store.linkedAccount(s.issuer.url+'/','zed',true);
  const zed2=await client(s.url,await s.mint('zed'));t.after(()=>zed2.close());
  assert.equal(JSON.parse(text(await zed2.callTool({name:'search_sections',arguments:args}))).error,'PERIOD_NOT_CAPTURED');
});
test('legacy (issuer-less) platform accounts match only when the issuer is the platform\'s authority',async t=>{
  const args={campus:'UBCV',academicPeriod:PERIOD};
  const legacy=(store,name)=>{const a=store.account(name,true),at=new Date().toISOString();store.put(a.id,snapshot({capturedAt:at,sections:[section({id:'L',title:'LEGACY-TITLE',observedAt:at})]}));return a;};
  // Platform metadata names the same issuer: matched.
  const same=await setup(t,{over:i=>({platformUrl:i.url})});legacy(same.store,'lee');
  const c1=await client(same.url,await same.mint('lee'));t.after(()=>c1.close());
  assert.equal(data(await c1.callTool({name:'search_sections',arguments:args})).sections[0].title,'LEGACY-TITLE');
  // A different platform authority: never matched, one warning only.
  const platform=await fakeIssuer(t);
  const diff=await setup(t,{over:()=>({platformUrl:platform.url})});legacy(diff.store,'lee');
  const c2=await client(diff.url,await diff.mint('lee'));t.after(()=>c2.close());
  for(let i=0;i<2;i++)assert.equal(JSON.parse(text(await c2.callTool({name:'search_sections',arguments:args}))).error,'CONNECTION_REVOKED');
  assert.equal(diff.logs.filter(l=>/accounts created before issuer binding/.test(l)).length,1);
  // No platform at all: never matched.
  const none=await setup(t,{over:()=>({platformUrl:null})});legacy(none.store,'lee');
  const c3=await client(none.url,await none.mint('lee'));t.after(()=>c3.close());
  assert.equal(JSON.parse(text(await c3.callTool({name:'search_sections',arguments:args}))).error,'CONNECTION_REVOKED');
  // A recorded issuer decides on its own: matching one works even without platform agreement, another does not.
  const rec=await setup(t,{over:()=>({platformUrl:null})});legacy(rec.store,'lee');rec.store.recordIssuer('lee',rec.issuer.url+'/');
  const c4=await client(rec.url,await rec.mint('lee'));t.after(()=>c4.close());
  assert.equal(data(await c4.callTool({name:'search_sections',arguments:args})).sections[0].title,'LEGACY-TITLE');
  rec.store.recordIssuer('lee','https://elsewhere.example');
  assert.equal(JSON.parse(text(await c4.callTool({name:'search_sections',arguments:args}))).error,'CONNECTION_REVOKED');
});
test('link-account creates an issuer-bound account and prints an upload token',async t=>{
  const s=await setup(t),dir=mkdtempSync(join(tmpdir(),'ubc-link-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  s.store.close;  // the CLI uses its own data directory, then the same database is opened below
  const run=(...a)=>execFileSync(process.execPath,['dist/connector/cli.js',...a],{env:{PATH:process.env.PATH,UBC_DATA_DIR:dir,UBC_OAUTH_ISSUER:s.issuer.url},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const out=JSON.parse(run('link-account','--sub','pat'));assert.equal(out.sub,'pat');assert.equal(out.issuer,s.issuer.url);assert.match(out.uploadToken,/^[\w-]{43}$/);
  assert.equal(JSON.parse(run('link-account','--sub','pat','--issuer',s.issuer.url+'/')).uploadToken,out.uploadToken);  // idempotent
  assert.throws(()=>run('link-account'),/--sub/);assert.throws(()=>run('link-account','--sub','x','--issuer','http://insecure.example'),/https/);
  // Use it: upload with the printed token into a connector that shares that database, then read through the remote endpoint.
  const linked=new Store(dir);t.after(()=>linked.close());
  const config={...s.config},port=await freePort(),srv=connectorServer(linked,null,mcpResource(linked,{...config,origin:`http://127.0.0.1:${port}`,resource:`http://127.0.0.1:${port}/mcp`,audience:`http://127.0.0.1:${port}/mcp`}));
  await new Promise(r=>srv.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{srv.closeAllConnections();srv.close(r);}));
  const at=new Date().toISOString();
  const up=await fetch(`http://127.0.0.1:${port}/v1/snapshots`,{method:'POST',headers:{Authorization:`Bearer ${out.uploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(snapshot({capturedAt:at,sections:[section({id:'P',title:'PAT-TITLE',observedAt:at})]}))});
  assert.equal(up.status,200);
  const mint=await new SignJWT({}).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:'es-1'}).setSubject('pat').setIssuer(s.issuer.url).setAudience(`http://127.0.0.1:${port}/mcp`).setExpirationTime(now()+300).sign(s.issuer.es.privateKey);
  const c=await client(`http://127.0.0.1:${port}/mcp`,mint);t.after(()=>c.close());
  assert.equal(data(await c.callTool({name:'search_sections',arguments:{campus:'UBCV',academicPeriod:PERIOD}})).sections[0].title,'PAT-TITLE');
});
test('rate limits: pre-auth per client address (proxy aware) and per subject after auth',async t=>{
  const s=await setup(t,{over:()=>({trustProxy:1})});
  const fail=xff=>fetch(s.url,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':xff}});
  const garbage={Authorization:'Bearer not-a-jwt'};
  const bad=xff=>fetch(s.url,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':xff,...garbage}});
  for(let i=0;i<120;i++)assert.equal((await bad('203.0.113.9, 198.51.100.7')).status,401);  // client = rightmost entry (one trusted hop)
  assert.equal((await bad('1.1.1.1, 198.51.100.7')).status,429);   // spoofed left entries do not help; failures alone are throttled
  assert.equal((await bad('203.0.113.9, 198.51.100.8')).status,401);  // another client is unaffected
  // A valid token from the same address is never blocked by that address's failures.
  const ok=await rpc(s.url,await s.mint('alice'),undefined,{'X-Forwarded-For':'198.51.100.7'});assert.equal(ok.status,200);
  // Discovery probes and expired tokens are routine, so they have a much larger allowance.
  for(let i=0;i<150;i++)assert.equal((await fail('198.51.100.7')).status,401);
  assert.equal((await rpc(s.url,await s.mint('alice',{exp:now()-500}),undefined,{'X-Forwarded-For':'198.51.100.7'})).status,401);
  const good=await s.mint('alice'),fresh=i=>({'X-Forwarded-For':`192.0.2.${i%250}`});
  let limited=0;
  for(let i=0;i<620;i++){const r=await rpc(s.url,good,undefined,fresh(i));await r.arrayBuffer();if(r.status===429)limited++;else assert.equal(r.status,200);}
  assert.equal(limited,21);  // 600 per iss+sub (one was already spent above)
  const bob=await rpc(s.url,await s.mint('bob'),undefined,fresh(1));assert.equal(bob.status,200);
  // Without UBC_TRUST_PROXY the header is ignored: all share the socket address.
  const plain=await setup(t);
  const junk=xff=>fetch(plain.url,{method:'POST',headers:{Authorization:'Bearer junk','X-Forwarded-For':xff}});
  for(let i=0;i<120;i++)await (await junk(`9.9.9.${i%250}`)).arrayBuffer();
  assert.equal((await junk('8.8.8.8')).status,429);
  assert.equal((await rpc(plain.url,await plain.mint('alice'))).status,200);
});
test('a broken key set is an issuer problem (503) with a logged reason; token rejections log a category only',async t=>{
  const s=await setup(t),token=await s.mint('alice');
  for(const [body,reason] of [['<html>nope</html>',/not JSON/],['{"keys":"x"}',/not a key set/]]) {
    const x=await setup(t);x.issuer.jwksBody=body;
    const r=await rpc(x.url,await x.mint('alice'));assert.equal(r.status,503);assert.ok(x.logs.some(l=>reason.test(l)),x.logs.join('|'));
    assert.ok(x.logs.every(l=>!l.includes('eyJ')));
  }
  for(const [over,category] of [[{aud:'https://o.example'},'aud'],[{iss:'https://o.example'},'iss'],[{exp:now()-500},'exp']])
    assert.equal((await rpc(s.url,await s.mint('alice',over))).status,401);
  const l=s.logs.join('\n');for(const c of ['aud','iss','exp'])assert.match(l,new RegExp(`MCP token rejected: ${c}`));
  assert.ok(!l.includes(token));
});
test('UBC_OAUTH_REQUIRE_AT_JWT=false accepts typ JWT but stays strict on everything else',async t=>{
  const strict=await setup(t),lax=await setup(t,{over:()=>({requireAtJwt:false})});
  for(const x of [strict,lax]) {
    seed(x.store,'alice','ALICE-ONLY-TITLE','CPSC_V-110-A');
    const typJwt=await x.mint('alice',{},x.issuer.es,{typ:'JWT'}),noTyp=await x.mint('alice',{},x.issuer.es,{typ:undefined});
    const expected=x===lax?200:401;
    assert.equal((await rpc(x.url,typJwt)).status,expected);assert.equal((await rpc(x.url,noTyp)).status,expected);
    for(const bad of [await x.mint('alice',{aud:'https://o.example'}),await x.mint('alice',{iss:'https://o.example'}),await x.mint('alice',{exp:now()-500}),await x.mint('alice',{exp:null})])assert.equal((await rpc(x.url,bad)).status,401);
    assert.equal((await rpc(x.url,`${Buffer.from('{"alg":"none"}').toString('base64url')}.e30.`)).status,401);
  }
});
test('a single trailing slash on the issuer is not significant, on either side',async t=>{
  const withSlash=await setup(t,{over:i=>({issuer:i.url+'/'})});
  assert.equal((await rpc(withSlash.url,await withSlash.mint('alice',{iss:withSlash.issuer.url}))).status,200);
  assert.equal((await rpc(withSlash.url,await withSlash.mint('alice',{iss:withSlash.issuer.url+'/'}))).status,200);
  const plain=await setup(t);
  assert.equal((await rpc(plain.url,await plain.mint('alice',{iss:plain.issuer.url+'/'}))).status,200);
  assert.equal((await rpc(plain.url,await plain.mint('alice',{iss:plain.issuer.url+'//'}))).status,401);
});
test('a database from before issuer binding is migrated and keeps its accounts',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const dir=mkdtempSync(join(tmpdir(),'ubc-migrate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new Store(dir);const a=store.account('old',true);store.close();
  const db=new DatabaseSync(join(dir,'connector.sqlite'));
  db.exec(`CREATE TABLE accounts_old(username TEXT PRIMARY KEY,binding_id TEXT NOT NULL,credentials TEXT NOT NULL);
    INSERT INTO accounts_old SELECT username,binding_id,credentials FROM accounts;DROP TABLE accounts;ALTER TABLE accounts_old RENAME TO accounts;`);db.close();
  store=new Store(dir);t.after(()=>store.close());
  assert.deepEqual(store.account('old'),a);assert.equal(store.accountForIssuer('https://x.example','old').via,'legacy');
  assert.ok(store.linkedAccount('https://x.example','old',true));assert.deepEqual(store.account('old'),a);
});
