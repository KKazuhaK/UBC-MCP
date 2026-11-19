import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {mcpConfigFromEnv,mcpResource} from '../dist/connector/mcp-http.js';
import {adapterFromEnv} from '../dist/connector/adapters/index.js';
import {mcphubOAuthAdapter} from '../dist/connector/adapters/mcphub-oauth.js';
import {snapshot,section} from './fixtures.mjs';

const PERIOD='2026W-T1',CLAIM='mcphub_uid',SECRET='s'.repeat(40);
const extension='chrome-extension://'+'a'.repeat(32);
const b64=b=>b.toString('base64url');
const now=()=>Math.floor(Date.now()/1000);
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const tmp=t=>{const dir=mkdtempSync(join(tmpdir(),'ubc-hub-personal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

// ---- the MCP endpoint -------------------------------------------------------
async function fakeIssuer(t) {
  const {publicKey,privateKey}=await generateKeyPair('ES256'),jwk={...await exportJWK(publicKey),kid:'k1',alg:'ES256',use:'sig'};
  const server=createServer((req,res)=>{
    const base=`http://127.0.0.1:${server.address().port}`,json=v=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    if(req.url==='/.well-known/oauth-authorization-server')return json({issuer:base,jwks_uri:base+'/jwks'});
    if(req.url==='/jwks')return json({keys:[jwk]});
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return {url:`http://127.0.0.1:${server.address().port}`,privateKey};
}
async function mcpSetup(t,{env={},platform,path}={}) {
  const dir=tmp(t),store=new Store(dir),issuer=await fakeIssuer(t),port=await freePort(),origin=`http://127.0.0.1:${port}`;
  const config=mcpConfigFromEnv({UBC_MCP_HTTP:'on',UBC_PUBLIC_ORIGIN:origin,UBC_OAUTH_ISSUER:issuer.url,...(path?{UBC_MCP_RESOURCE:origin+path}:{}),...env});
  const resource=mcpResource(store,config,{log:()=>{},...(platform?{request:platform}:{})});
  const server=connectorServer(store,null,resource);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(()=>{store.close();r();});}));
  const mint=(claims={},{sub='alice',aud=config.resource}={})=>new SignJWT(claims).setProtectedHeader({alg:'ES256',typ:'at+jwt',kid:'k1'}).setSubject(sub).setIssuedAt()
    .setIssuer(issuer.url).setAudience(aud).setExpirationTime(now()+300).setJti('j'+Math.random()).sign(issuer.privateKey);
  const call=async(token,url=config.resource)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:`Bearer ${token}`}:{})},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_data_status',arguments:{}}})});
  const status=async token=>{const r=await call(token),body=await r.text();const line=body.split('\n').find(l=>l.startsWith('data:'))??body;return {http:r.status,body:line};};
  return {store,issuer,origin,config,mint,call,status};
}
const seed=(store,account,title)=>{const at=new Date().toISOString();store.put(account.id,snapshot({capturedAt:at,sections:[section({id:'S1',title,observedAt:at})]}));};
const connectedOf=r=>{const t=r.body.replace(/^data: /,"");try{const j=JSON.parse(JSON.parse(t).result.content[0].text.split("\n").filter(l=>l.startsWith("{")||l.startsWith("[")||l.startsWith(" ")||l.startsWith("}")).join("\n"));return j.personal.connected;}catch(e){return "ERR "+r.body.slice(0,300);}};


test('the endpoint is served at the resource path, its metadata at the RFC 9728 path form',async t=>{
  const s=await mcpSetup(t,{path:'/ubc/mcp',env:{UBC_OAUTH_SUBJECT_CLAIM:CLAIM}});
  assert.equal(s.config.resource,s.origin+'/ubc/mcp');
  const no=await s.call(null);assert.equal(no.status,401);
  assert.equal(no.headers.get('www-authenticate'),`Bearer resource_metadata="${s.origin}/.well-known/oauth-protected-resource/ubc/mcp"`);
  const meta=await fetch(s.origin+'/.well-known/oauth-protected-resource/ubc/mcp');
  assert.equal(meta.status,200);
  const doc=await meta.json();assert.equal(doc.resource,s.origin+'/ubc/mcp');assert.deepEqual(doc.authorization_servers,[s.issuer.url]);
  // The root document and the old fixed path belong to whatever else shares the origin.
  assert.equal((await fetch(s.origin+'/.well-known/oauth-protected-resource')).status,404);
  assert.equal((await fetch(s.origin+'/.well-known/oauth-protected-resource/mcp')).status,404);
  assert.equal((await s.call(null,s.origin+'/mcp')).status,404);
  // An invalid token gets the same challenge, with the error code.
  const bad=await s.call('junk');assert.equal(bad.status,401);
  assert.equal(bad.headers.get('www-authenticate'),`Bearer error="invalid_token", resource_metadata="${s.origin}/.well-known/oauth-protected-resource/ubc/mcp"`);
  assert.equal((await s.status(await s.mint({[CLAIM]:'u-1'}))).http,200);
});

test('standalone defaults are unchanged: /mcp, root metadata, sub',async t=>{
  const s=await mcpSetup(t);
  assert.equal(s.config.resource,s.origin+'/mcp');assert.equal(s.config.subjectClaim,'sub');
  const no=await s.call(null);assert.equal(no.status,401);
  assert.equal(no.headers.get('www-authenticate'),`Bearer resource_metadata="${s.origin}/.well-known/oauth-protected-resource/mcp"`);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'])assert.equal((await (await fetch(s.origin+path)).json()).resource,s.origin+'/mcp');
  seed(s.store,s.store.linkedAccount(s.issuer.url,'alice',true),'ALICE');
  assert.equal(connectedOf(await s.status(await s.mint())),true);
});

test('configuration: resource needs a path, subject claim is a plain claim name',()=>{
  const ok={UBC_MCP_HTTP:'on',UBC_PUBLIC_ORIGIN:'https://ubc.example.test',UBC_OAUTH_ISSUER:'https://hub.example.test'};
  assert.equal(mcpConfigFromEnv({...ok,UBC_OAUTH_SUBJECT_CLAIM:CLAIM,UBC_MCP_RESOURCE:'https://ubc.example.test/ubc/mcp'}).subjectClaim,CLAIM);
  for(const bad of [{UBC_OAUTH_SUBJECT_CLAIM:'iss'},{UBC_OAUTH_SUBJECT_CLAIM:'a b'},{UBC_MCP_RESOURCE:'https://ubc.example.test'}])assert.throws(()=>mcpConfigFromEnv({...ok,...bad}),Error,JSON.stringify(bad));
});

test('subject claim: present is used, missing or not a string is 401, never another claim',async t=>{
  const s=await mcpSetup(t,{path:'/ubc/mcp',env:{UBC_OAUTH_SUBJECT_CLAIM:CLAIM}});
  const uid=s.store.linkedAccount(s.issuer.url,'uid-1',true,CLAIM);seed(s.store,uid,'UID-ONE');
  // An account that exists under the plain sub key must not be reachable when the claim is something else.
  seed(s.store,s.store.linkedAccount(s.issuer.url,'alice',true),'BY-SUB');
  assert.equal(connectedOf(await s.status(await s.mint({[CLAIM]:'uid-1'}))),true);
  assert.equal((await s.call(await s.mint({}))).status,401);                    // claim missing
  assert.equal((await s.call(await s.mint({[CLAIM]:42}))).status,401);          // wrong type
  assert.equal((await s.call(await s.mint({[CLAIM]:''}))).status,401);
  assert.equal((await s.call(await s.mint({[CLAIM]:['uid-1']}))).status,401);
  assert.equal(connectedOf(await s.status(await s.mint({[CLAIM]:'uid-2'}))),false);  // sub=alice does not fall back
  // The account key is issuer + '#' + claim.
  assert.equal(s.store.accountForIssuer(s.issuer.url,'uid-1',CLAIM).account.id,uid.id);
  assert.equal(s.store.accountForIssuer(s.issuer.url,'uid-1'),null);
});

test('/mcp adopts a username-keyed account on first sight, only when the issuer matches',async t=>{
  const s=await mcpSetup(t,{path:'/ubc/mcp',env:{UBC_OAUTH_SUBJECT_CLAIM:CLAIM}});
  const alice=s.store.account('alice',true);seed(s.store,alice,'ALICE-DATA');s.store.recordIssuer('alice',s.issuer.url);
  const carol=s.store.account('carol',true);seed(s.store,carol,'CAROL-DATA');s.store.recordIssuer('carol','https://other.example.test');
  assert.equal(connectedOf(await s.status(await s.mint({[CLAIM]:'u-alice'}))),true);
  assert.equal(s.store.account('alice'),null);                                  // moved, not copied
  assert.equal(s.store.linkedAccount(s.issuer.url,'u-alice',false,CLAIM).id,alice.id);
  assert.match((await s.status(await s.mint({[CLAIM]:'u-alice'}))).body,/ALICE-DATA|connected/);
  // Recorded for another issuer: untouched, and the token's owner gets nothing.
  assert.equal(connectedOf(await s.status(await s.mint({[CLAIM]:'u-carol'},{sub:'carol'}))),false);
  assert.equal(s.store.account('carol').id,carol.id);
});

test('legacy accounts (no recorded issuer) are adopted only when the platform vouches for the issuer',async t=>{
  let s;
  const vouching=(url,init)=>String(url).startsWith('http://platform.invalid')?Promise.resolve(new Response(JSON.stringify({issuer:s.issuer.url}),{status:200,headers:{'Content-Type':'application/json'}})):fetch(url,init);
  s=await mcpSetup(t,{path:'/ubc/mcp',env:{UBC_OAUTH_SUBJECT_CLAIM:CLAIM,UBC_PLATFORM_ADAPTER:'mcphub-oauth',UBC_PLATFORM_URL:'http://platform.invalid'},platform:vouching});
  const old=s.store.account('alice',true);seed(s.store,old,'OLD');
  assert.equal(connectedOf(await s.status(await s.mint({[CLAIM]:'u-1'}))),true);
  assert.equal(s.store.linkedAccount(s.issuer.url,'u-1',false,CLAIM).id,old.id);
  const none=await mcpSetup(t,{path:'/ubc/mcp',env:{UBC_OAUTH_SUBJECT_CLAIM:CLAIM,UBC_PLATFORM_ADAPTER:'none'}});
  const keep=none.store.account('alice',true);seed(none.store,keep,'OLD');
  assert.equal(connectedOf(await none.status(await none.mint({[CLAIM]:'u-1'}))),false);
  assert.equal(none.store.account('alice').id,keep.id);
});

test('store: adopt never merges into an existing uid account, and a reused username cannot reach old data',async t=>{
  const store=new Store(tmp(t));t.after(()=>store.close());
  const iss='https://hub.example.test',yes=async()=>true,no=async()=>false;
  // Both exist: nothing moves.
  const oldAlice=store.account('alice',true);store.recordIssuer('alice',iss);
  const uidAccount=store.linkedAccount(iss,'u-1',true,CLAIM);
  assert.equal(await store.adopt(iss+'/',CLAIM,'u-1','alice',yes),false);
  assert.equal(store.account('alice').id,oldAlice.id);assert.equal(store.linkedAccount(iss,'u-1',false,CLAIM).id,uidAccount.id);
  // Not adopted for a different issuer, or for a legacy row the platform does not vouch for.
  store.recordIssuer('alice','https://other.example.test');
  assert.equal(await store.adopt(iss,CLAIM,'u-2','alice',yes),false);
  const legacy=store.account('bob',true);
  assert.equal(await store.adopt(iss,CLAIM,'u-3','bob',no),false);
  assert.equal(await store.adopt(iss,CLAIM,'u-3','bob',yes),true);
  assert.equal(store.linkedAccount(iss,'u-3',false,CLAIM).id,legacy.id);assert.equal(store.account('bob'),null);
  // Credentials stay readable after the move (resealed for the new key).
  assert.equal(store.linkedAccount(iss,'u-3',false,CLAIM).readToken,legacy.readToken);
  // Reuse: bob's name now belongs to someone else with another uid. Their uid has no account, and the old data went with the old uid.
  assert.equal(await store.adopt(iss,CLAIM,'u-4','bob',yes),false);
  assert.equal(store.accountForIssuer(iss,'u-4',CLAIM),null);
  assert.equal(store.accountForIssuer(iss,'bob',CLAIM),null);
  // The claim `sub` is never adopted, and a revoked account is never moved.
  assert.equal(await store.adopt(iss,'sub','x','y',yes),false);
  const gone=store.account('dora',true);store.recordIssuer('dora',iss);store.revoke(gone.id);
  assert.equal(await store.adopt(iss,CLAIM,'u-5','dora',yes),false);
  // A username that equals somebody else's uid does not find that account through the old namespace.
  store.account('u-3',true);
  assert.equal(store.accountForIssuer(iss,'u-3',CLAIM).account.id,legacy.id);
});

test('store: pair and claim work for linked accounts',async t=>{
  const store=new Store(tmp(t));t.after(()=>store.close());
  const iss='https://hub.example.test',linked=store.linkedAccount(iss,'u-1',true,CLAIM);
  assert.throws(()=>store.pair('u-1'),/Not connected/);
  const {code}=store.pair('u-1',{issuer:iss+'/',claim:CLAIM});
  assert.deepEqual(store.claim(code),{uploadToken:linked.uploadToken});
  assert.equal(store.claim(code),null);                                        // one use
  const plain=store.account('alice',true),second=store.pair('alice');
  assert.deepEqual(store.claim(second.code),{uploadToken:plain.uploadToken});
  const plainSub=store.linkedAccount(iss,'sub-user',true);
  assert.deepEqual(store.claim(store.pair('sub-user',{issuer:iss}).code),{uploadToken:plainSub.uploadToken});
  store.revoke(linked.id);
  assert.throws(()=>store.pair('u-1',{issuer:iss,claim:CLAIM}),/Not connected/);
});

// ---- the sign-in-only adapter -----------------------------------------------
async function fakeHub(t,users) {
  const hub={requests:[],codes:new Map(),tokens:new Map(),user:'alice',n:0};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://x');let raw='';for await(const c of req)raw+=c;
    hub.requests.push({method:req.method,path:url.pathname,search:url.search,headers:{...req.headers}});
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const base=`http://127.0.0.1:${server.address().port}`;
    if(url.pathname==='/.well-known/oauth-authorization-server')return json(200,{issuer:hub.issuer??base,authorization_endpoint:base+'/oauth/authorize',token_endpoint:base+'/oauth/token',userinfo_endpoint:base+'/oauth/userinfo',token_endpoint_auth_methods_supported:['none']});
    if(url.pathname==='/oauth/authorize'){
      const code='code-'+(++hub.n);hub.codes.set(code,{user:hub.user,challenge:url.searchParams.get('code_challenge')});
      res.writeHead(302,{Location:`${url.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}`});return res.end();
    }
    if(url.pathname==='/oauth/token'){
      const f=new URLSearchParams(raw),entry=hub.codes.get(f.get('code'));hub.codes.delete(f.get('code'));
      if(!entry||b64(createHash('sha256').update(f.get('code_verifier')??'').digest())!==entry.challenge)return json(400,{error:'invalid_grant'});
      const token=`at-${entry.user}-${++hub.n}`;hub.tokens.set(token,entry.user);return json(200,{access_token:token,token_type:'Bearer'});
    }
    const user=hub.tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1]);
    if(!user)return json(401,{});
    if(url.pathname==='/oauth/userinfo'){const u=users[user];return json(200,{sub:user,username:user,...(u?{[CLAIM]:u}:{})});}
    json(404,{});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  hub.url=`http://127.0.0.1:${server.address().port}`;return hub;
}
async function adapterSetup(t,{users={alice:'u-alice',bob:'u-bob'},viaEnv=false,config={}}={}) {
  const store=new Store(tmp(t)),hub=await fakeHub(t,users),port=await freePort(),origin=`http://127.0.0.1:${port}`;
  const adapter=viaEnv
    ?adapterFromEnv(store,{UBC_MCP_HTTP:'on',UBC_PUBLIC_ORIGIN:origin,UBC_OAUTH_ISSUER:hub.url,UBC_MCP_RESOURCE:origin+'/ubc/mcp',UBC_OAUTH_SUBJECT_CLAIM:CLAIM,UBC_PLATFORM_ADAPTER:'mcphub-oauth',UBC_PLATFORM_URL:hub.url,UBC_OAUTH_CLIENT_ID:'ubc',UBC_SESSION_SECRET:SECRET},()=>{})
    :mcphubOAuthAdapter(store,{origin,platformUrl:hub.url,clientId:'ubc',sessionSecret:SECRET,signInOnly:true,issuer:hub.url,subjectClaim:CLAIM,log:()=>{},...config});
  const server=connectorServer(store,adapter);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>{server.closeAllConnections();server.close(r);});store.close();});
  const jar=new Map();
  const req=async(path,init={})=>{
    const r=await fetch(path.startsWith('http')?path:origin+path,{redirect:'manual',...init,headers:{Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(init.headers??{})}});
    for(const line of r.headers.getSetCookie()){const [pair,...attrs]=line.split('; '),i=pair.indexOf('='),name=pair.slice(0,i),value=pair.slice(i+1);if(attrs.includes('Max-Age=0')||value==='')jar.delete(name);else jar.set(name,value);}
    return r;
  };
  const flow=async()=>{const st=await req('/ubc/oauth/start');assert.equal(st.status,302);const a=await fetch(st.headers.get('location'),{redirect:'manual'});return req(a.headers.get('location'));};
  const status=async()=>(await req('/ubc/api/status')).json();
  return {store,hub,origin,issuer:hub.url,req,flow,status};
}

test('sign-in-only adapter: no credential scope or call, account keyed by the stable uid',async t=>{
  const {store,hub,origin,issuer,req,flow,status}=await adapterSetup(t);
  const done=await flow();assert.equal(done.status,302);assert.equal(done.headers.get('location'),'/ubc/?connected=1');
  const authorize=hub.requests.find(r=>r.path==='/oauth/authorize');
  assert.ok(!new URLSearchParams(authorize.search).has('scope'));assert.ok(!authorize.search.includes('credentials'));
  assert.ok(!hub.requests.some(r=>r.path.startsWith('/api/credentials')||['PUT','DELETE'].includes(r.method)));
  const account=store.linkedAccount(issuer,'u-alice',false,CLAIM);assert.ok(account);
  assert.equal(store.account('alice'),null);                                    // not keyed by username
  const s=await status();assert.equal(s.authenticated,true);assert.equal(s.username,'alice');
  // The page and /mcp resolve to the same account: same key, same data.
  const at=new Date().toISOString();store.put(account.id,snapshot({capturedAt:at,sections:[section({observedAt:at})]}));
  assert.equal((await status()).scopes.length,1);
  assert.equal(store.accountForIssuer(issuer,'u-alice',CLAIM).account.id,account.id);
  // Pairing the extension works for the linked account.
  assert.equal((await req('/ubc/api/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:'{}'})).status,200);
  const pair=await (await req('/ubc/api/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:'{}'})).json();
  const claim=await fetch(origin+'/ubc/api/claim',{method:'POST',headers:{Origin:extension,'Content-Type':'application/json'},body:JSON.stringify({code:pair.code})});
  assert.equal(claim.status,200);assert.deepEqual(await claim.json(),{uploadToken:account.uploadToken});
  // Signing in again keeps the account; another user gets their own.
  assert.equal((await flow()).status,302);assert.equal(store.linkedAccount(issuer,'u-alice',false,CLAIM).id,account.id);
  hub.user='bob';await req('/ubc/api/forget',{method:'POST',headers:{Origin:origin}});assert.equal((await flow()).status,302);
  assert.notEqual(store.linkedAccount(issuer,'u-bob',false,CLAIM).id,account.id);assert.equal((await status()).scopes.length,0);
  assert.ok(!hub.requests.some(r=>r.path.startsWith('/api/credentials')));
  assert.ok(!(await (await req('/ubc/')).text()).includes('仅允许写入你自己的'));
});

test('sign-in-only adapter adopts the old username account at sign-in, never merging',async t=>{
  const {store,issuer,flow,status}=await adapterSetup(t);
  const old=store.account('alice',true),at=new Date().toISOString();
  store.put(old.id,snapshot({capturedAt:at,sections:[section({observedAt:at})]}));
  assert.equal((await flow()).status,302);
  assert.equal(store.linkedAccount(issuer,'u-alice',false,CLAIM).id,old.id);assert.equal(store.account('alice'),null);
  assert.equal((await status()).scopes.length,1);
});

test('sign-in-only adapter: userinfo without the claim, or from another issuer, signs nobody in',async t=>{
  const missing=await adapterSetup(t,{users:{}});
  assert.equal((await missing.flow()).status,502);assert.equal((await missing.status()).authenticated,false);
  assert.equal(missing.store.linkedAccount(missing.issuer,'alice',false,CLAIM),null);assert.equal(missing.store.account('alice'),null);
  const other=await adapterSetup(t);other.hub.issuer='https://elsewhere.example.test';
  assert.equal((await other.flow()).status,502);assert.equal((await other.status()).authenticated,false);
});

test('sign-in-only adapter: disconnect revokes locally without any credential call',async t=>{
  const {store,hub,issuer,req,origin,flow,status}=await adapterSetup(t);
  await flow();const s=await status();
  const start=await req('/ubc/oauth/start',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({intent:'disconnect'})});
  const {authorizeUrl}=await start.json();
  const a=await fetch(authorizeUrl,{redirect:'manual'});const done=await req(a.headers.get('location'));
  assert.equal(done.headers.get('location'),'/ubc/?notice=disconnected');
  assert.equal(store.linkedAccount(issuer,'u-alice',false,CLAIM),null);
  assert.ok(!hub.requests.some(r=>r.path.startsWith('/api/credentials')||r.method==='DELETE'));
});

test('UBC_MCP_HTTP=on makes the env-built adapter sign-in only; without it the adapter still writes credentials',async t=>{
  const on=await adapterSetup(t,{viaEnv:true});
  assert.equal((await on.flow()).status,302);
  assert.ok(!on.hub.requests.some(r=>r.path.startsWith('/api/credentials')));
  assert.ok(on.store.linkedAccount(on.issuer,'u-alice',false,CLAIM));
  const store=new Store(tmp(t));t.after(()=>store.close());
  const off=adapterFromEnv(store,{UBC_PUBLIC_ORIGIN:'http://127.0.0.1:1',UBC_PLATFORM_ADAPTER:'mcphub-oauth',UBC_PLATFORM_URL:'http://127.0.0.1:2',UBC_OAUTH_CLIENT_ID:'ubc',UBC_SESSION_SECRET:SECRET},()=>{});
  assert.equal(off.name,'mcphub-oauth');
});
