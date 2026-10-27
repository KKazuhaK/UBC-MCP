import {createHash,createHmac,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../store.js';
import type {PlatformAdapter} from './index.js';
import {page,script} from './mcphub-oauth-web.js';
import {handleClaim,PAGE_HEADERS,SERVER_NAME} from './shared.js';

export type McphubOAuthConfig={origin:string;platformUrl:string;clientId:string;clientSecret?:string;sessionSecret:string;serverName?:string;warn?:(message:string)=>void;log?:(message:string)=>void};
type Send=(status:number,value:unknown)=>void;
type Intent='connect'|'disconnect';
type Discovery={authorize:URL;token:URL;userinfo:URL;basicAuth:boolean};
type Tx={s:string;v:string;i:Intent;e:number;x?:string;u?:string};
type Session={u:string;b:string;e:number;c:string};

const TX_COOKIE='ubc_oauth',SESSION_COOKIE='ubc_session',TX_TTL=10*60_000,SESSION_TTL=15*60_000,DISCOVERY_TTL=5*60_000;
const LOOPBACK=['localhost','127.0.0.1','[::1]'];
// Standard authorization-response errors (RFC 6749 4.1.2.1) plus invalid_client; anything else is logged as unrecognized.
const OAUTH_ERRORS=new Set(['invalid_request','unauthorized_client','access_denied','unsupported_response_type','invalid_scope','server_error','temporarily_unavailable','invalid_client']);
// A plain-http authorization endpoint outside loopback usually means MCPHub has no public base URL and advertised an internal address.
export const authorizeEndpointNeedsWarning=(url:URL)=>url.protocol!=='https:'&&!LOOPBACK.includes(url.hostname);
const b64=(b:Buffer)=>b.toString('base64url');
const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const MESSAGES:Record<string,{zh:string;en:string}>={
  STATE:{zh:'登录请求已过期或无效，请返回后重新开始。',en:'The sign-in request expired or is invalid. Please start again.'},
  DENIED:{zh:'MCPHub 未授予访问权限。',en:'MCPHub did not grant access.'},
  REFUSED:{zh:'MCPHub 拒绝了此请求，请联系管理员。',en:'MCPHub refused the request. Ask your administrator.'},
  UPSTREAM:{zh:'无法与 MCPHub 完成授权，请稍后重试或联系管理员。',en:'Authorization with MCPHub could not be completed. Try again later or contact your administrator.'},
  SAVE:{zh:'无法把凭证保存到 MCPHub，请稍后重试或联系管理员。',en:'The credential could not be saved to MCPHub. Try again later or contact your administrator.'},
  MISMATCH:{zh:'授权的 MCPHub 账号与当前连接不一致，未做任何更改。',en:'The authorized MCPHub account does not match this connection. Nothing was changed.'},
  SESSION:{zh:'连接已过期，请重新连接 MCPHub。',en:'Your connection expired. Please connect with MCPHub again.'}
};
class FlowError extends Error {constructor(readonly code:keyof typeof MESSAGES,readonly status=502){super(code);}}

function validateUrl(value:string,what:string,http:'loopback'|'any') {
  let u:URL;try{u=new URL(value);}catch{throw new Error(`${what} is not a valid URL`);}
  if(u.username||u.password||u.search||u.hash)throw new Error(`${what} must not contain credentials, a query or a fragment`);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&(http==='any'||LOOPBACK.includes(u.hostname))))throw new Error(`${what} must use https`);
  return u;
}

// MCPHub integration over OAuth 2.1 (authorization code + PKCE). The access
// token only lives for the duration of the callback request; nothing but the
// connector's own signed cookies ever reaches the browser. MCPHub cookies are
// never read, forwarded or relied upon.
export function mcphubOAuthAdapter(store:Store,config:McphubOAuthConfig):PlatformAdapter {
  const originUrl=validateUrl(config.origin,'UBC_PUBLIC_ORIGIN','loopback');
  if(originUrl.pathname!=='/')throw new Error('UBC_PUBLIC_ORIGIN must be an origin without a path');
  const origin=originUrl.origin,secureCookies=originUrl.protocol==='https:',redirectUri=`${origin}/ubc/oauth/callback`;
  const hub=validateUrl(config.platformUrl,'UBC_PLATFORM_URL','any'),hubBase=hub.href.replace(/\/+$/,'');
  if(hub.protocol==='http:'&&!LOOPBACK.includes(hub.hostname))(config.warn??(()=>{}))('UBC_PLATFORM_URL uses plain http; OAuth tokens and credentials would cross the network unencrypted. Use it only on a trusted private network.');
  const serverName=config.serverName??'ubc-personal',scope=`credentials:write:${serverName}`;
  if(!SERVER_NAME.test(serverName))throw new Error('Invalid platform server name');
  const clientId=config.clientId;
  if(!clientId||clientId.length>256||/[\s\x00-\x1f]/.test(clientId))throw new Error('Invalid UBC_OAUTH_CLIENT_ID');
  if(config.clientSecret!==undefined&&(!config.clientSecret||/[\x00-\x1f]/.test(config.clientSecret)))throw new Error('Invalid UBC_OAUTH_CLIENT_SECRET');
  if(Buffer.byteLength(config.sessionSecret,'utf8')<32)throw new Error('UBC_SESSION_SECRET must be at least 32 bytes');
  const key=Buffer.from(hkdfSync('sha256',config.sessionSecret,'ubc-mcp','cookie-signing-v1',32));
  const log=config.log??(m=>console.error(m));
  const fail=(stage:string,detail?:number)=>log(`mcphub-oauth: ${stage} failed${detail?` (HTTP ${detail})`:''}`);

  // ---- signed cookies -------------------------------------------------------
  const sign=(name:string,payload:object)=>{const p=b64(Buffer.from(JSON.stringify(payload)));return `${p}.${b64(createHmac('sha256',key).update(`${name}.${p}`).digest())}`;};
  function open<T extends {e:number}>(name:string,value:string|undefined):T|null {
    if(!value||value.length>2048)return null;
    const [p,mac,...rest]=value.split('.');if(!p||!mac||rest.length)return null;
    if(!same(mac,b64(createHmac('sha256',key).update(`${name}.${p}`).digest())))return null;
    try{const v=JSON.parse(Buffer.from(p,'base64url').toString()) as T;return typeof v.e==='number'&&v.e>Date.now()?v:null;}catch{return null;}
  }
  function cookie(req:IncomingMessage,name:string) {
    for(const part of (req.headers.cookie??'').split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return part.slice(i+1).trim();}
    return undefined;
  }
  const setCookie=(name:string,value:string,maxAgeSeconds:number)=>`${name}=${value}; Path=/ubc/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secureCookies?'; Secure':''}`;
  const clear=(name:string)=>setCookie(name,'',0);
  function session(req:IncomingMessage) {
    const s=open<Session>(SESSION_COOKIE,cookie(req,SESSION_COOKIE));
    if(!s||typeof s.u!=='string'||typeof s.b!=='string'||typeof s.c!=='string')return null;
    const a=store.account(s.u);return a&&a.id===s.b?{...s,account:a}:null;
  }

  // ---- OAuth client -----------------------------------------------------------
  const consumed=new Map<string,number>();
  let discovered:{at:number;doc:Discovery}|null=null,warnedEndpoint=false;
  async function readJson(r:Response):Promise<any> {
    const reader=r.body?.getReader();if(!reader)return null;
    const chunks:Uint8Array[]=[];let n=0;
    for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>65_536){await reader.cancel();return null;}chunks.push(value);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return null;}
  }
  const call=(url:URL|string,init:RequestInit)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(10_000)});
  // Server-to-server calls always go to the configured platform host, even if
  // discovery advertises a different public host (for example behind a proxy).
  const rebase=(u:URL)=>new URL(u.pathname+u.search,hub.origin);
  async function discover():Promise<Discovery> {
    if(discovered&&Date.now()-discovered.at<DISCOVERY_TTL)return discovered.doc;
    try {
      const r=await call(`${hubBase}/.well-known/oauth-authorization-server`,{headers:{Accept:'application/json'}});
      const d=r.ok?await readJson(r):(await r.body?.cancel(),null);
      const url=(v:unknown)=>{if(typeof v!=='string')throw new Error('bad');return new URL(v);};
      const authorize=url(d?.authorization_endpoint);
      if(!warnedEndpoint&&authorizeEndpointNeedsWarning(authorize)){warnedEndpoint=true;(config.warn??(()=>{}))('MCPHub advertises an authorization endpoint that is not https, which browsers outside a private network usually cannot reach. Configure MCPHub\'s public base URL (install.baseUrl or INSTALL_BASE_URL).');}
      const secure=authorize.protocol==='https:'||(authorize.protocol==='http:'&&(LOOPBACK.includes(authorize.hostname)||authorize.origin===hub.origin));
      if(authorize.username||authorize.password||authorize.hash||!secure)throw new Error('bad');
      const methods:unknown=d?.token_endpoint_auth_methods_supported;
      const doc={authorize,token:rebase(url(d?.token_endpoint)),userinfo:rebase(url(d?.userinfo_endpoint)),basicAuth:Array.isArray(methods)&&methods.includes('client_secret_basic')&&!methods.includes('client_secret_post')};
      discovered={at:Date.now(),doc};return doc;
    }catch{fail('discovery');throw new FlowError('UPSTREAM');}
  }
  async function exchange(d:Discovery,code:string,verifier:string):Promise<string> {
    const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:verifier});
    const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(config.clientSecret&&d.basicAuth)headers.Authorization='Basic '+Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
    else {body.set('client_id',clientId);if(config.clientSecret)body.set('client_secret',config.clientSecret);}
    try {
      const r=await call(d.token,{method:'POST',headers,body});
      if(!r.ok){await r.body?.cancel();fail('token exchange',r.status);throw new FlowError('UPSTREAM');}
      const t=await readJson(r);
      if(typeof t?.access_token!=='string'||!t.access_token||(typeof t.token_type==='string'&&t.token_type.toLowerCase()!=='bearer')){fail('token exchange');throw new FlowError('UPSTREAM');}
      return t.access_token;
    }catch(e){if(e instanceof FlowError)throw e;fail('token exchange');throw new FlowError('UPSTREAM');}
  }
  async function identity(d:Discovery,token:string):Promise<string> {
    try {
      const r=await call(d.userinfo,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
      if(!r.ok){await r.body?.cancel();fail('userinfo',r.status);throw new FlowError('UPSTREAM');}
      const u=await readJson(r);
      if(typeof u?.sub!=='string'||!u.sub||u.sub.length>256||/[\x00-\x1f\x7f]/.test(u.sub)){fail('userinfo');throw new FlowError('UPSTREAM');}
      return u.sub;
    }catch(e){if(e instanceof FlowError)throw e;fail('userinfo');throw new FlowError('UPSTREAM');}
  }
  async function credential(token:string,method:'PUT'|'DELETE',values?:Record<string,string>):Promise<void> {
    const url=`${hubBase}/api/credentials/${encodeURIComponent(serverName)}`;
    const r=await call(url,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(values?{'Content-Type':'application/json'}:{})},...(values?{body:JSON.stringify({values})}:{})});
    if(method==='DELETE'&&r.status===404){await r.body?.cancel();return;}
    if(!r.ok){await r.body?.cancel();throw new Error(`HTTP ${r.status}`);}
    const d=await readJson(r);if(method==='PUT'?d?.success!==true:d?.success===false)throw new Error('refused');
  }

  // ---- HTTP -----------------------------------------------------------------
  const page$=()=>page.replaceAll('{{PLATFORM_ORIGIN}}',origin).replaceAll('{{SERVER_NAME}}',serverName);
  function html(res:ServerResponse,status:number,body:string,cookies:string[]=[]) {
    res.writeHead(status,{'Content-Type':'text/html; charset=utf-8',...PAGE_HEADERS,...(cookies.length?{'Set-Cookie':cookies}:{})});res.end(body);
  }
  function errorPage(req:IncomingMessage,res:ServerResponse,e:FlowError,cookies:string[]) {
    const zh=/^zh/i.test(req.headers['accept-language']??''),m=MESSAGES[e.code]!;
    html(res,e.status,`<!doctype html><html lang="${zh?'zh-CN':'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>UBC MCP</title><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#132c40}a{color:#073b5c}</style><h1>${zh?'连接未完成':'Connection not completed'}</h1><p>${zh?m.zh:m.en}</p><p><a href="/ubc/">${zh?'返回连接页面':'Back to the connection page'}</a></p></html>`,cookies);
  }
  function redirect(res:ServerResponse,location:string,cookies:string[]) {
    res.writeHead(302,{Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',...(cookies.length?{'Set-Cookie':cookies}:{})});res.end();
  }
  async function begin(intent:Intent,d:Discovery,extra:{x?:string;u?:string}) {
    const state=b64(randomBytes(32)),verifier=b64(randomBytes(32));
    const tx:Tx={s:state,v:verifier,i:intent,e:Date.now()+TX_TTL,...extra};
    const url=new URL(d.authorize);
    for(const [k,v] of Object.entries({response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope,state,code_challenge:b64(createHash('sha256').update(verifier).digest()),code_challenge_method:'S256'}))url.searchParams.set(k,v);
    return {url:url.href,cookie:setCookie(TX_COOKIE,sign(TX_COOKIE,tx),TX_TTL/1000)};
  }
  // State-changing requests: same-origin, JSON, a live connector session and its CSRF token.
  function guard(req:IncomingMessage,send:Send) {
    if(req.method!=='POST'){send(405,{error:'METHOD_NOT_ALLOWED'});return null;}
    const site=req.headers['sec-fetch-site'];
    if(req.headers.origin!==origin||(site&&site!=='same-origin')||req.headers.authorization||!(req.headers['content-type']??'').startsWith('application/json')){send(403,{error:'SAME_ORIGIN_REQUIRED'});return null;}
    const s=session(req);
    if(!s){send(401,{error:'NOT_CONNECTED',message:'连接已过期，请重新连接 MCPHub。'});return null;}
    const sent=req.headers['x-csrf-token'];
    if(typeof sent!=='string'||!same(sent,s.c)){send(403,{error:'CSRF'});return null;}
    return s;
  }
  async function body(req:IncomingMessage):Promise<any> {
    const chunks:Buffer[]=[];let n=0;
    for await(const c of req){n+=c.length;if(n>4096)return null;chunks.push(c);}
    try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{return null;}
  }

  async function callback(req:IncomingMessage,res:ServerResponse,url:URL) {
    const cookies=[clear(TX_COOKIE)];
    try {
      const tx=open<Tx>(TX_COOKIE,cookie(req,TX_COOKIE)),state=url.searchParams.get('state')??'';
      if(!tx||typeof tx.s!=='string'||!same(tx.s,state))throw new FlowError('STATE',400);
      const id=createHash('sha256').update(tx.s).digest('hex');
      for(const [k,exp] of consumed)if(exp<Date.now())consumed.delete(k);
      if(consumed.has(id))throw new FlowError('STATE',400);
      consumed.set(id,tx.e);  // single use, whatever happens next
      if(url.searchParams.has('error')) {
        // Only the standard error code is ever logged, never descriptions or URIs.
        const code=url.searchParams.get('error')??'',known=OAUTH_ERRORS.has(code)?code:'unrecognized';
        log(`mcphub-oauth: authorization refused (${known})`);
        throw new FlowError(known==='access_denied'?'DENIED':'REFUSED',403);
      }
      const code=url.searchParams.get('code');
      if(!code||code.length>2048)throw new FlowError('STATE',400);
      const disconnect=tx.i==='disconnect',current=disconnect?session(req):null;
      if(disconnect&&(!current||current.u!==tx.u))throw new FlowError('SESSION',401);
      const d=await discover(),token=await exchange(d,code,tx.v),username=await identity(d,token);
      if(disconnect) {
        if(username!==current!.u)throw new FlowError('MISMATCH',403);
        // Connector revocation always wins, even if the platform cleanup fails.
        store.revoke(current!.account.id);
        let warning=false;
        try{await credential(token,'DELETE');}catch{fail('credential delete');warning=true;}
        redirect(res,`/ubc/?notice=${warning?'disconnected-warning':'disconnected'}`,[...cookies,clear(SESSION_COOKIE)]);return;
      }
      // Do not leave an orphan account behind if MCPHub refuses the credential.
      const existing=store.account(username),account=existing??store.account(username,true)!;
      try{await credential(token,'PUT',{'env.UBC_CONNECTOR_TOKEN':account.readToken});}
      catch{fail('credential save');if(!existing)store.revoke(account.id);throw new FlowError('SAVE');}
      const s:Session={u:username,b:account.id,e:Date.now()+SESSION_TTL,c:b64(randomBytes(32))};
      const ext=typeof tx.x==='string'&&/^[a-f0-9]{64}$/.test(tx.x)?`#extension-auth=${tx.x}`:'';
      redirect(res,`/ubc/?connected=1${ext}`,[...cookies,setCookie(SESSION_COOKIE,sign(SESSION_COOKIE,s),SESSION_TTL/1000)]);
    }catch(e){errorPage(req,res,e instanceof FlowError?e:new FlowError('UPSTREAM'),cookies);}
  }

  const handle=async(req:IncomingMessage,res:ServerResponse,send:Send)=>{
    const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method;
    if(path==='/ubc/capabilities'&&method==='GET'){send(200,{extensionAuthorization:1});return;}
    if(path==='/ubc/'||path==='/ubc/app.js') {
      if(method!=='GET'){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
      const js=path.endsWith('.js');
      res.writeHead(200,{'Content-Type':js?'text/javascript; charset=utf-8':'text/html; charset=utf-8',...PAGE_HEADERS});res.end(js?script:page$());return;
    }
    if(path==='/ubc/api/claim') {
      if(method!=='POST'){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
      await handleClaim(store,req,res,send);return;
    }
    if(path==='/ubc/oauth/start') {
      if(method==='GET') {
        // Plain navigation: only ever starts a connect; disconnect needs the CSRF-protected POST.
        const ext=url.searchParams.get('ext');
        try {
          const d=await discover(),flow=await begin('connect',d,ext&&/^[a-f0-9]{64}$/.test(ext)?{x:ext}:{});
          redirect(res,flow.url,[flow.cookie]);
        }catch(e){errorPage(req,res,e instanceof FlowError?e:new FlowError('UPSTREAM'),[]);}
        return;
      }
      const s=guard(req,send);if(!s)return;
      const input=await body(req);
      if(input?.intent!=='disconnect'){send(400,{error:'INVALID_REQUEST'});return;}
      try {
        const flow=await begin('disconnect',await discover(),{u:s.u});
        res.setHeader('Set-Cookie',flow.cookie);send(200,{authorizeUrl:flow.url});
      }catch{send(502,{error:'PLATFORM_UNAVAILABLE',message:MESSAGES.UPSTREAM!.zh});}
      return;
    }
    if(path==='/ubc/oauth/callback') {
      if(method!=='GET'){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
      await callback(req,res,url);return;
    }
    if(path==='/ubc/api/status') {
      if(method!=='GET'){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
      const s=session(req);
      if(!s){send(200,{authenticated:false,scopes:[]});return;}
      send(200,{authenticated:true,username:s.u,csrf:s.c,scopes:store.get(s.account.id).map(x=>({campus:x.campus,period:x.academicPeriod.id,kind:x.kind,capturedAt:x.capturedAt,sections:x.sections.length}))});return;
    }
    if(path==='/ubc/api/pair') {const s=guard(req,send);if(s)send(200,store.pair(s.u));return;}
    if(path==='/ubc/api/forget') {
      // Local only: clears this browser's connector session, nothing on either server.
      if(method!=='POST'){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
      if(session(req)){if(!guard(req,send))return;}
      else if(req.headers.origin!==origin){send(403,{error:'SAME_ORIGIN_REQUIRED'});return;}
      res.setHeader('Set-Cookie',[clear(SESSION_COOKIE),clear(TX_COOKIE)]);send(200,{forgotten:true});return;
    }
    send(404,{error:'NOT_FOUND'});
  };
  return {name:'mcphub-oauth',preflightPaths:['/ubc/api/claim'],handles:u=>u.startsWith('/ubc/'),handle};
}
