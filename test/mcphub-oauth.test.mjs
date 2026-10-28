import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,Server} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';
import {adapterFromEnv} from '../dist/connector/adapters/index.js';
import {mcphubOAuthAdapter,authorizeEndpointNeedsWarning} from '../dist/connector/adapters/mcphub-oauth.js';
import {snapshot,section} from './fixtures.mjs';

const SECRET='s'.repeat(40),CLIENT='ubc-connector',BODY_MARKER='LEAKY-UPSTREAM-BODY-9f3a',MCPHUB_COOKIE='session=mcphub-login-cookie';
const extension='chrome-extension://'+'a'.repeat(32);
const b64=b=>b.toString('base64url');
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

// A fake MCPHub: discovery, authorize, token, userinfo and credential endpoints.
async function fakeHub(t) {
  const hub={user:'alice',requests:[],codes:new Map(),tokens:new Map(),saved:new Map(),methods:['none'],clientSecret:null,clients:new Set([CLIENT]),failToken:false,failPut:false,failDelete:false,basic:false,authorizeParams:null,n:0};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://x');let raw='';for await(const c of req)raw+=c;
    hub.requests.push({method:req.method,path:url.pathname,headers:{...req.headers},body:raw});
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const base=`http://127.0.0.1:${server.address().port}`;
    if(url.pathname==='/.well-known/oauth-authorization-server')return json(200,{issuer:base,authorization_endpoint:(hub.authorizeBase??base)+'/oauth/authorize',token_endpoint:base+'/oauth/token',userinfo_endpoint:base+'/oauth/userinfo',token_endpoint_auth_methods_supported:hub.methods});
    if(url.pathname==='/oauth/authorize') {
      hub.authorizeParams=Object.fromEntries(url.searchParams);
      if(!hub.clients.has(url.searchParams.get('client_id')))return json(400,{error:'invalid_client'});const code='code-'+(++hub.n);
      hub.codes.set(code,{user:hub.user,challenge:url.searchParams.get('code_challenge'),redirect:url.searchParams.get('redirect_uri'),client:url.searchParams.get('client_id')});
      res.writeHead(302,{Location:`${url.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}`});return res.end();
    }
    if(url.pathname==='/oauth/token') {
      if(hub.failToken)return json(400,{error:'invalid_grant',error_description:BODY_MARKER});
      const f=new URLSearchParams(raw),entry=hub.codes.get(f.get('code'));hub.codes.delete(f.get('code'));
      let client=f.get('client_id'),secret=f.get('client_secret');
      const auth=/^Basic (.+)$/.exec(req.headers.authorization??'');if(auth){[client,secret]=Buffer.from(auth[1],'base64').toString().split(':').map(decodeURIComponent);}
      const ok=entry&&f.get('grant_type')==='authorization_code'&&f.get('redirect_uri')===entry.redirect&&client===entry.client&&b64(createHash('sha256').update(f.get('code_verifier')??'').digest())===entry.challenge;
      if(!ok)return json(400,{error:'invalid_grant',error_description:BODY_MARKER});
      if(hub.clientSecret!==null&&secret!==hub.clientSecret)return json(401,{error:'invalid_client',error_description:BODY_MARKER});
      hub.lastTokenAuth={client,secret,basic:!!auth};
      const token=`at-${entry.user}-${++hub.n}`;hub.tokens.set(token,entry.user);return json(200,{access_token:token,token_type:'Bearer',expires_in:60});
    }
    const user=hub.tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1]);
    if(!user)return json(401,{error:'invalid_token',detail:BODY_MARKER});
    if(url.pathname==='/oauth/userinfo')return json(200,{sub:user});
    if(url.pathname==='/api/credentials/ubc-personal') {
      if(req.method==='PUT'){if(hub.failPut)return json(403,{success:false,message:BODY_MARKER});hub.saved.set(user,JSON.parse(raw).values['env.UBC_CONNECTOR_TOKEN']);return json(200,{success:true});}
      if(req.method==='DELETE'){if(hub.failDelete)return json(500,{success:false});hub.saved.delete(user);return json(200,{success:true});}
    }
    json(404,{});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  hub.url=`http://127.0.0.1:${server.address().port}`;return hub;
}

async function setup(t,extra={}) {
  const dir=mkdtempSync(join(tmpdir(),'ubc-oauth-')),store=new Store(dir),hub=await fakeHub(t),port=await freePort(),logs=[];
  const origin=`http://127.0.0.1:${port}`;
  const adapter=mcphubOAuthAdapter(store,{origin,platformUrl:hub.url,clientId:CLIENT,sessionSecret:SECRET,log:m=>logs.push(m),...extra});
  const server=connectorServer(store,adapter);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  // A tiny browser: keeps only the connector's cookies, and always carries an unrelated MCPHub cookie.
  const jar=new Map();
  const cookieHeader=()=>[MCPHUB_COOKIE,...[...jar].map(([k,v])=>`${k}=${v}`)].join('; ');
  function absorb(r){for(const line of r.headers.getSetCookie()){const [pair,...attrs]=line.split('; '),i=pair.indexOf('='),name=pair.slice(0,i),value=pair.slice(i+1);
    if(attrs.includes('Max-Age=0')||value==='')jar.delete(name);else jar.set(name,value);}}
  const req=async(path,init={})=>{const r=await fetch(path.startsWith('http')?path:origin+path,{redirect:'manual',...init,headers:{Cookie:cookieHeader(),...(init.headers??{})}});absorb(r);return r;};
  const post=(path,body,csrf,headers={})=>req(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},body:JSON.stringify(body??{})});
  /** Runs start -> MCPHub authorize -> callback and returns the callback response. */
  async function flow(path='/ubc/oauth/start'){
    const s=await req(path);assert.equal(s.status,302);const authorize=s.headers.get('location');
    const a=await fetch(authorize,{redirect:'manual'});assert.equal(a.status,302);
    return req(a.headers.get('location'));
  }
  const status=async()=>(await req('/ubc/api/status')).json();
  return {dir,store,hub,port,origin,adapter,logs,jar,req,post,flow,status};
}
const noCookiesToHub=hub=>{for(const r of hub.requests){assert.equal(r.headers.cookie,undefined,r.path);assert.ok(!JSON.stringify(r.headers).includes('mcphub-login-cookie'));}};

test('connect flow: PKCE + state verified, code exchanged, READ token saved with Bearer, session cookie set, pairing works',async t=>{
  const {store,hub,origin,req,post,jar,logs,flow,status}=await setup(t);
  const start=await req('/ubc/oauth/start');assert.equal(start.status,302);
  const authorize=new URL(start.headers.get('location'));
  assert.equal(authorize.origin+authorize.pathname,hub.url+'/oauth/authorize');
  const p=Object.fromEntries(authorize.searchParams);
  assert.deepEqual({response_type:p.response_type,client_id:p.client_id,redirect_uri:p.redirect_uri,scope:p.scope,code_challenge_method:p.code_challenge_method},{response_type:'code',client_id:CLIENT,redirect_uri:origin+'/ubc/oauth/callback',scope:'credentials:write:ubc-personal',code_challenge_method:'S256'});
  assert.match(p.state,/^[\w-]{43}$/);assert.match(p.code_challenge,/^[\w-]{43}$/);
  const txCookie=start.headers.getSetCookie().find(c=>c.startsWith('ubc_oauth='));
  assert.match(txCookie,/HttpOnly/);assert.match(txCookie,/SameSite=Lax/);assert.doesNotMatch(txCookie,/Secure/);  // loopback http
  assert.match(txCookie,/^ubc_oauth=[\w-]+\.[\w-]+;/);  // payload.signature
  const a=await fetch(start.headers.get('location'),{redirect:'manual'});
  const done=await req(a.headers.get('location'));
  assert.equal(done.status,302);assert.equal(done.headers.get('location'),'/ubc/?connected=1');
  const cookies=done.headers.getSetCookie();
  const session=cookies.find(c=>c.startsWith('ubc_session='));assert.match(session,/HttpOnly/);assert.match(session,/SameSite=Lax/);assert.match(session,/Max-Age=900/);
  assert.ok(cookies.some(c=>c.startsWith('ubc_oauth=;')&&c.includes('Max-Age=0')));
  // Server side: code exchanged with the matching verifier, userinfo + PUT carried the token as Bearer.
  const token=hub.requests.find(r=>r.path==='/oauth/token'),put=hub.requests.find(r=>r.method==='PUT');
  assert.ok(token&&hub.lastTokenAuth.client===CLIENT&&!hub.lastTokenAuth.basic);
  const account=store.account('alice');assert.ok(account);
  assert.equal(hub.saved.get('alice'),account.readToken);
  assert.match(put.headers.authorization,/^Bearer at-alice-/);assert.deepEqual(Object.keys(JSON.parse(put.body)),['values']);
  assert.equal(hub.requests.find(r=>r.path==='/oauth/userinfo').headers.authorization,put.headers.authorization);
  // The access token is discarded: not in the cookies, not in the logs.
  const accessToken=put.headers.authorization.slice(7);
  assert.ok(![...jar.values()].some(v=>v.includes(accessToken))&&!logs.join().includes(accessToken));
  noCookiesToHub(hub);
  // Session, CSRF and pairing for the extension.
  const s=await status();assert.equal(s.authenticated,true);assert.equal(s.username,'alice');assert.match(s.csrf,/^[\w-]{43}$/);
  assert.equal((await post('/ubc/api/pair',{})).status,403);                       // no CSRF token
  assert.equal((await post('/ubc/api/pair',{},'x'.repeat(43))).status,403);        // wrong CSRF token
  assert.equal((await post('/ubc/api/pair',{},s.csrf,{Origin:'https://evil.example'})).status,403);
  const pair=await post('/ubc/api/pair',{},s.csrf);assert.equal(pair.status,200);const {code}=await pair.json();
  const claim=await fetch(origin+'/ubc/api/claim',{method:'POST',headers:{Origin:extension,'Content-Type':'application/json'},body:JSON.stringify({code})});
  assert.equal(claim.status,200);assert.deepEqual(await claim.json(),{uploadToken:account.uploadToken});
  const now=new Date().toISOString();
  const up=await fetch(origin+'/v1/snapshots',{method:'POST',headers:{Origin:extension,Authorization:`Bearer ${account.uploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(snapshot({capturedAt:now,sections:[section({observedAt:now})]}))});
  assert.equal(up.status,200);assert.equal((await status()).scopes.length,1);
  // Reconnecting keeps the same account and its snapshots (no rotation of the binding).
  hub.requests.length=0;assert.equal((await flow()).status,302);
  assert.deepEqual(store.account('alice'),account);assert.equal(hub.saved.get('alice'),account.readToken);assert.equal((await status()).scopes.length,1);
  noCookiesToHub(hub);
});

test('an existing cookie-adapter account keeps its snapshots when connecting through OAuth',async t=>{
  const {store,req,flow,status}=await setup(t);
  const before=store.account('alice',true),now=new Date().toISOString();
  store.put(before.id,snapshot({capturedAt:now,sections:[section({observedAt:now})]}));
  assert.equal((await flow()).status,302);assert.equal(store.account('alice').id,before.id);assert.equal((await status()).scopes.length,1);
});

test('extension state survives the redirect round trip in the signed cookie only',async t=>{
  const {req,flow}=await setup(t),nonce='b'.repeat(64);
  const done=await flow('/ubc/oauth/start?ext='+nonce);assert.equal(done.headers.get('location'),`/ubc/?connected=1#extension-auth=${nonce}`);
  assert.equal((await flow('/ubc/oauth/start?ext=not-hex')).headers.get('location'),'/ubc/?connected=1');
});

test('state mismatch, missing cookie, tampered cookie and replay are rejected without contacting MCPHub',async t=>{
  const {hub,req,jar,flow}=await setup(t);
  const start=await req('/ubc/oauth/start'),location=start.headers.get('location');
  const authorize=await fetch(location,{redirect:'manual'}),callback=new URL(authorize.headers.get('location'));
  const tokenCalls=()=>hub.requests.filter(r=>r.path==='/oauth/token').length;
  const wrong=new URL(callback);wrong.searchParams.set('state','x'.repeat(43));
  const saved=new Map(jar);
  assert.equal((await req(wrong.href)).status,400);assert.equal(tokenCalls(),0);
  const tampered=new Map(saved);tampered.set('ubc_oauth',saved.get('ubc_oauth').replace(/.$/,c=>c==='A'?'B':'A'));
  jar.clear();for(const [k,v] of tampered)jar.set(k,v);
  assert.equal((await req(callback.href)).status,400);assert.equal(tokenCalls(),0);
  jar.clear();assert.equal((await req(callback.href)).status,400);assert.equal(tokenCalls(),0);   // no cookie at all
  // Valid exchange once, then replay the very same cookie and URL.
  jar.clear();for(const [k,v] of saved)jar.set(k,v);
  const ok=await req(callback.href);assert.equal(ok.status,302);assert.equal(tokenCalls(),1);
  jar.clear();for(const [k,v] of saved)jar.set(k,v);
  const replay=await req(callback.href);assert.equal(replay.status,400);assert.equal(tokenCalls(),1);assert.ok(!replay.headers.getSetCookie().some(c=>c.startsWith('ubc_session=')&&!c.includes('Max-Age=0')));
  // A session cookie is not accepted as a transaction cookie (cookie name is bound into the signature).
  await flow();jar.set('ubc_oauth',jar.get('ubc_session'));
  assert.equal((await req(callback.href)).status,400);
  noCookiesToHub(hub);
});

test('provider denial and token endpoint errors show a short message and never echo the response body',async t=>{
  const {hub,req,logs}=await setup(t);
  const begin=async()=>{const s=await req('/ubc/oauth/start');const a=await fetch(s.headers.get('location'),{redirect:'manual'});return new URL(a.headers.get('location'));};
  hub.failToken=true;
  let cb=await begin();const res=await req(cb.href,{headers:{'Accept-Language':'zh-CN'}});
  const text=await res.text();
  assert.equal(res.status,502);assert.match(text,/无法与 MCPHub 完成授权/);assert.ok(!text.includes(BODY_MARKER));
  assert.ok(!res.headers.getSetCookie().some(c=>c.startsWith('ubc_session=')&&!c.includes('Max-Age=0')));
  assert.ok(!logs.join('\n').includes(BODY_MARKER));
  assert.ok(!logs.join('\n').includes(cb.searchParams.get('code'))&&!logs.join('\n').includes(cb.searchParams.get('state')));
  assert.equal((await (await req('/ubc/api/status')).json()).authenticated,false);
  // English by default.
  cb=await begin();assert.match(await (await req(cb.href)).text(),/Authorization with MCPHub could not be completed/);
  // The user declines on the MCPHub consent screen.
  hub.failToken=false;const s=await req('/ubc/oauth/start'),state=new URL(s.headers.get('location')).searchParams.get('state');
  const denied=await req(`${new URL(cb.href).origin}/ubc/oauth/callback?error=access_denied&error_description=${BODY_MARKER}&state=${state}`);
  const deniedText=await denied.text();assert.equal(denied.status,403);assert.match(deniedText,/did not grant access/);assert.ok(!deniedText.includes(BODY_MARKER));
  // Saving the credential fails after a successful exchange: no session, short message.
  hub.failPut=true;const sv=await req(await (async()=>{const s2=await req('/ubc/oauth/start');const a=await fetch(s2.headers.get('location'),{redirect:'manual'});return a.headers.get('location');})());
  const svText=await sv.text();assert.equal(sv.status,502);assert.ok(!svText.includes(BODY_MARKER));assert.equal((await (await req('/ubc/api/status')).json()).authenticated,false);
  assert.ok(!logs.join('\n').includes(BODY_MARKER));
});

test('disconnect needs a fresh authorization, then deletes on both sides',async t=>{
  const {store,hub,req,post,jar,flow,status}=await setup(t);
  await flow();const account=store.account('alice'),s=await status();
  assert.ok(hub.saved.has('alice'));
  // Without CSRF or a session nothing starts; GET cannot carry the disconnect intent.
  assert.equal((await post('/ubc/oauth/start',{intent:'disconnect'})).status,403);
  const anon=await fetch(`${(await setup(t)).origin}/ubc/oauth/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(anon.status,403);
  assert.equal((await post('/ubc/oauth/start',{intent:'connect'},s.csrf)).status,400);
  const begin=await post('/ubc/oauth/start',{intent:'disconnect'},s.csrf);assert.equal(begin.status,200);
  const {authorizeUrl}=await begin.json();
  assert.equal(hub.saved.has('alice'),true);assert.equal(store.authenticate(account.readToken,'read'),account.id);  // nothing changed yet
  // A different MCPHub user authorizing the request changes nothing.
  hub.user='mallory';
  const wrong=await fetch(authorizeUrl,{redirect:'manual'}),mismatch=await req(wrong.headers.get('location'));
  assert.equal(mismatch.status,403);assert.equal(store.authenticate(account.readToken,'read'),account.id);assert.equal(hub.saved.has('alice'),true);
  // The genuine user completes it (a fresh transaction, since the cookie was cleared).
  hub.user='alice';
  const again=await (await post('/ubc/oauth/start',{intent:'disconnect'},s.csrf)).json();
  const a=await fetch(again.authorizeUrl,{redirect:'manual'});
  const done=await req(a.headers.get('location'));
  assert.equal(done.status,302);assert.equal(done.headers.get('location'),'/ubc/?notice=disconnected');
  assert.equal(hub.saved.has('alice'),false);assert.ok(hub.requests.some(r=>r.method==='DELETE'&&/^Bearer at-alice-/.test(r.headers.authorization)));
  assert.equal(store.account('alice'),null);assert.equal(store.authenticate(account.readToken,'read'),null);assert.equal(store.authenticate(account.uploadToken,'upload'),null);
  assert.equal(jar.has('ubc_session'),false);assert.equal((await status()).authenticated,false);
  noCookiesToHub(hub);
});

test('connector revocation wins when the MCPHub credential cannot be deleted',async t=>{
  const {store,hub,req,post,flow,status}=await setup(t);
  await flow();const account=store.account('alice'),s=await status();hub.failDelete=true;
  const {authorizeUrl}=await (await post('/ubc/oauth/start',{intent:'disconnect'},s.csrf)).json();
  const a=await fetch(authorizeUrl,{redirect:'manual'}),done=await req(a.headers.get('location'));
  assert.equal(done.headers.get('location'),'/ubc/?notice=disconnected-warning');assert.equal(store.authenticate(account.readToken,'read'),null);assert.equal(store.account('alice'),null);
});

test('Forget this browser only clears the connector session',async t=>{
  const {store,hub,req,post,jar,flow,status}=await setup(t);
  await flow();const s=await status(),account=store.account('alice');hub.requests.length=0;
  assert.equal((await post('/ubc/api/forget',{})).status,403);                    // CSRF still required with a session
  assert.equal((await post('/ubc/api/forget',{},s.csrf)).status,200);
  assert.equal(jar.has('ubc_session'),false);assert.equal((await status()).authenticated,false);
  assert.equal(hub.requests.length,0);assert.equal(hub.saved.get('alice'),account.readToken);assert.equal(store.authenticate(account.readToken,'read'),account.id);
});

test('sessions are signed, bound to a live account, and expire',async t=>{
  const {store,jar,flow,status}=await setup(t);
  await flow();const value=jar.get('ubc_session');assert.equal((await status()).authenticated,true);
  jar.set('ubc_session',value.replace(/.$/,c=>c==='A'?'B':'A'));assert.equal((await status()).authenticated,false);
  jar.set('ubc_session',value);assert.equal((await status()).authenticated,true);
  const original=Date.now;try{Date.now=()=>original()+61*60_000;assert.equal((await status()).authenticated,false);}finally{Date.now=original;}
  store.revoke(store.account('alice').id);assert.equal((await status()).authenticated,false);   // revocation ends the session
});

test('public client (default, no secret): none-only discovery, PKCE only, no client_secret sent',async t=>{
  const {hub,flow}=await setup(t);
  assert.equal((await flow()).status,302);assert.deepEqual(hub.lastTokenAuth,{client:CLIENT,secret:null,basic:false});
});
test('an unregistered client id is refused at authorize and shows a short error',async t=>{
  const {hub,req}=await setup(t);hub.clients.clear();
  const s=await req('/ubc/oauth/start');assert.equal(s.status,302);
  assert.equal((await fetch(s.headers.get('location'),{redirect:'manual'})).status,400);
});
test('confidential client (only for MCPHub versions that support it): Basic auth when only client_secret_basic is advertised',async t=>{
  const {hub,flow}=await setup(t,{clientSecret:'top secret/+'});hub.methods=['client_secret_basic'];hub.clientSecret='top secret/+';
  assert.equal((await flow()).status,302);assert.deepEqual(hub.lastTokenAuth,{client:CLIENT,secret:'top secret/+',basic:true});
});
test('confidential client (only for MCPHub versions that support it): client_secret_post otherwise',async t=>{
  const {hub,flow}=await setup(t,{clientSecret:'shh'});hub.methods=['client_secret_basic','client_secret_post','none'];hub.clientSecret='shh';
  assert.equal((await flow()).status,302);assert.deepEqual(hub.lastTokenAuth,{client:CLIENT,secret:'shh',basic:false});
});

test('callback errors log only the standard error code and show a different message than a user denial',async t=>{
  const {req,logs}=await setup(t);
  const cb=async(q)=>{const s=await req('/ubc/oauth/start'),state=new URL(s.headers.get('location')).searchParams.get('state');return req(`/ubc/oauth/callback?${q}&state=${state}`,{headers:{'Accept-Language':'en'}});};
  let r=await cb(`error=invalid_scope&error_description=${BODY_MARKER}&error_uri=https://evil.example/${BODY_MARKER}`);
  assert.equal(r.status,403);const text=await r.text();assert.match(text,/refused the request/);assert.ok(!text.includes(BODY_MARKER));
  r=await cb('error=access_denied');assert.match(await r.text(),/did not grant access/);
  r=await cb('error=weird%20value%0A');await r.text();
  assert.deepEqual(logs,['mcphub-oauth: authorization refused (invalid_scope)','mcphub-oauth: authorization refused (access_denied)','mcphub-oauth: authorization refused (unrecognized)']);
});

test('a failed credential save leaves no orphan account; an existing account is kept',async t=>{
  const {store,hub,req,flow,status}=await setup(t);hub.failPut=true;
  assert.equal((await flow()).status,502);assert.equal(store.account('alice'),null);assert.equal((await status()).authenticated,false);
  const before=store.account('bob',true);hub.user='bob';assert.equal((await flow()).status,502);assert.deepEqual(store.account('bob'),before);
  hub.failPut=false;hub.user='alice';assert.equal((await flow()).status,302);assert.ok(store.account('alice'));void req;
});

test('a plain-http authorization endpoint outside loopback is flagged; a loopback hub logs nothing',async t=>{
  assert.equal(authorizeEndpointNeedsWarning(new URL('http://mcphub:3000/oauth/authorize')),true);   // internal address advertised
  assert.equal(authorizeEndpointNeedsWarning(new URL('https://hub.example.com/oauth/authorize')),false);
  assert.equal(authorizeEndpointNeedsWarning(new URL('http://localhost:3000/oauth/authorize')),false);
  const warnings=[],{flow}=await setup(t,{warn:m=>warnings.push(m)});
  assert.equal((await flow()).status,302);assert.deepEqual(warnings,[]);
});

test('public client (default, no secret): none-only discovery, PKCE only, no client_secret sent',async t=>{
  const {hub,flow}=await setup(t);
  assert.equal((await flow()).status,302);assert.deepEqual(hub.lastTokenAuth,{client:CLIENT,secret:null,basic:false});
});
test('an unregistered client id is refused at authorize and shows a short error',async t=>{
  const {hub,req}=await setup(t);hub.clients.clear();
  const s=await req('/ubc/oauth/start');assert.equal(s.status,302);
  assert.equal((await fetch(s.headers.get('location'),{redirect:'manual'})).status,400);
});
test('confidential client (only for MCPHub versions that support it): Basic auth when only client_secret_basic is advertised',async t=>{
  const {hub,flow}=await setup(t,{clientSecret:'top secret/+'});hub.methods=['client_secret_basic'];hub.clientSecret='top secret/+';
  assert.equal((await flow()).status,302);assert.deepEqual(hub.lastTokenAuth,{client:CLIENT,secret:'top secret/+',basic:true});
});
test('confidential client (only for MCPHub versions that support it): client_secret_post otherwise',async t=>{
  const {hub,flow}=await setup(t,{clientSecret:'shh'});hub.methods=['client_secret_basic','client_secret_post','none'];hub.clientSecret='shh';
  assert.equal((await flow()).status,302);assert.deepEqual(hub.lastTokenAuth,{client:CLIENT,secret:'shh',basic:false});
});

test('callback errors log only the standard error code and show a different message than a user denial',async t=>{
  const {req,logs}=await setup(t);
  const cb=async(q)=>{const s=await req('/ubc/oauth/start'),state=new URL(s.headers.get('location')).searchParams.get('state');return req(`/ubc/oauth/callback?${q}&state=${state}`,{headers:{'Accept-Language':'en'}});};
  let r=await cb(`error=invalid_scope&error_description=${BODY_MARKER}&error_uri=https://evil.example/${BODY_MARKER}`);
  assert.equal(r.status,403);const text=await r.text();assert.match(text,/refused the request/);assert.ok(!text.includes(BODY_MARKER));
  r=await cb('error=access_denied');assert.match(await r.text(),/did not grant access/);
  r=await cb('error=weird%20value%0A');await r.text();
  assert.deepEqual(logs,['mcphub-oauth: authorization refused (invalid_scope)','mcphub-oauth: authorization refused (access_denied)','mcphub-oauth: authorization refused (unrecognized)']);
});

test('a failed credential save leaves no orphan account; an existing account is kept',async t=>{
  const {store,hub,req,flow,status}=await setup(t);hub.failPut=true;
  assert.equal((await flow()).status,502);assert.equal(store.account('alice'),null);assert.equal((await status()).authenticated,false);
  const before=store.account('bob',true);hub.user='bob';assert.equal((await flow()).status,502);assert.deepEqual(store.account('bob'),before);
  hub.failPut=false;hub.user='alice';assert.equal((await flow()).status,302);assert.ok(store.account('alice'));void req;
});

test('the page and routes: CSP, no adapter-wide leakage, extension preflight, unknown routes',async t=>{
  const {origin,req}=await setup(t);
  const page=await req('/ubc/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const html=await page.text();assert.match(html,/Connect with MCPHub/);assert.match(html,/忘记此浏览器/);assert.ok(!html.includes('{{'));
  assert.equal((await req('/ubc/app.js')).status,200);
  assert.deepEqual(await (await req('/ubc/capabilities')).json(),{extensionAuthorization:1});
  assert.equal((await req('/ubc/api/connect',{method:'POST',headers:{Origin:origin}})).status,404);   // cookie-adapter routes do not exist
  assert.equal((await fetch(origin+'/ubc/api/claim',{method:'OPTIONS',headers:{Origin:extension}})).status,204);
});

test('page script: connect navigates to the OAuth start, mutating calls send the CSRF token',async()=>{
  const {parseHTML}=await import('linkedom'),{runInNewContext}=await import('node:vm'),{page,script}=await import('../dist/connector/adapters/mcphub-oauth-web.js');
  const {document}=parseHTML(page),calls=[],assigned=[];let authenticated=true;
  const fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/status')?{authenticated,username:'alice',csrf:'c'.repeat(43),scopes:[]}:url.endsWith('/pair')?{code:'x'.repeat(43),expires:Date.now()+1000}:{authorizeUrl:'https://hub.example.test/oauth/authorize?x=1'}};};
  runInNewContext(script,{document,fetch,AbortSignal,URLSearchParams,location:{hash:'',search:'',assign:u=>assigned.push(u)},confirm:()=>true,alert:()=>{}});
  await new Promise(r=>setImmediate(r));
  assert.match(document.getElementById('status').textContent,/已连接/);
  await document.getElementById('pair').onclick();
  const pairCall=calls.find(c=>c.url==='/ubc/api/pair');assert.equal(pairCall.options.headers['X-CSRF-Token'],'c'.repeat(43));
  await document.getElementById('disconnect').onclick();
  assert.deepEqual(assigned,['https://hub.example.test/oauth/authorize?x=1']);assert.equal(JSON.parse(calls.find(c=>c.url==='/ubc/oauth/start').options.body).intent,'disconnect');
  document.getElementById('connect').onclick();assert.equal(assigned.at(-1),'/ubc/oauth/start');
  assert.ok(calls.every(c=>c.options.credentials==='same-origin'&&c.options.redirect==='error'));
});

test('configuration is validated at startup with clear messages',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ubc-oauth-cfg-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const ok={UBC_PLATFORM_ADAPTER:'mcphub-oauth',UBC_PUBLIC_ORIGIN:'https://ubc.example.test',UBC_PLATFORM_URL:'https://hub.example.test',UBC_OAUTH_CLIENT_ID:'ubc',UBC_SESSION_SECRET:'k'.repeat(32)};
  const warnings=[],a=adapterFromEnv(store,ok,m=>warnings.push(m));
  assert.equal(a.name,'mcphub-oauth');assert.deepEqual(warnings,[]);assert.deepEqual(a.preflightPaths,['/ubc/api/claim']);
  for(const key of ['UBC_PUBLIC_ORIGIN','UBC_PLATFORM_URL','UBC_OAUTH_CLIENT_ID','UBC_SESSION_SECRET']){
    const env={...ok};delete env[key];assert.throws(()=>adapterFromEnv(store,env),new RegExp(`mcphub-oauth requires ${key}`),key);
  }
  const bad=(patch,re)=>assert.throws(()=>adapterFromEnv(store,{...ok,...patch}),re,JSON.stringify(patch));
  bad({UBC_SESSION_SECRET:'short'},/at least 32 bytes/);
  bad({UBC_PUBLIC_ORIGIN:'http://ubc.example.test'},/UBC_PUBLIC_ORIGIN must use https/);
  bad({UBC_PUBLIC_ORIGIN:'https://ubc.example.test/path'},/without a path/);
  bad({UBC_PUBLIC_ORIGIN:'https://u:p@ubc.example.test'},/credentials/);
  bad({UBC_PUBLIC_ORIGIN:'nonsense'},/not a valid URL/);
  bad({UBC_PLATFORM_URL:'ftp://hub.example.test'},/UBC_PLATFORM_URL must use https/);
  bad({UBC_PLATFORM_URL:'https://hub.example.test/?x=1'},/query/);
  bad({UBC_PLATFORM_SERVER_NAME:'a/b'},/server name/);
  bad({UBC_OAUTH_CLIENT_ID:'has space'},/UBC_OAUTH_CLIENT_ID/);
  assert.throws(()=>adapterFromEnv(store,{...ok,UBC_PLATFORM_ADAPTER:'oauth'}),/Unknown UBC_PLATFORM_ADAPTER.*mcphub-oauth/);
  assert.equal(adapterFromEnv(store,{...ok,UBC_PUBLIC_ORIGIN:'http://localhost:8792',UBC_OAUTH_CLIENT_SECRET:'x'}).name,'mcphub-oauth');   // loopback http is allowed
  const w=[];adapterFromEnv(store,{...ok,UBC_PLATFORM_URL:'http://mcphub:3000'},m=>w.push(m));assert.match(w[0],/plain http/);
});

test('the cookie adapter still works and is marked deprecated in its startup log',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ubc-oauth-dep-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const w=[],a=adapterFromEnv(store,{UBC_PLATFORM_ADAPTER:'mcphub',UBC_PUBLIC_ORIGIN:'https://hub.example.test'},m=>w.push(m));
  assert.equal(a.name,'mcphub');assert.equal(w.length,1);assert.match(w[0],/DEPRECATED.*session cookie.*mcphub-oauth/);
  const auto=[];adapterFromEnv(store,{UBC_PUBLIC_ORIGIN:'https://hub.example.test'},m=>auto.push(m));assert.equal(auto.length,1);assert.match(auto[0],/mcphub-oauth/);
});
