import {createMcpHandler} from '@modelcontextprotocol/server';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {createRemoteJWKSet,customFetch,decodeProtectedHeader,errors,jwtVerify} from 'jose';
import type {JWTPayload} from 'jose';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {once} from 'node:events';
import {Store,normalizeIssuer} from './store.js';
import {createServerFor} from '../server.js';
import {PublicHttp,SourceError,readBounded} from '../http.js';
import {Catalog} from '../providers/catalog.js';
import {Grades} from '../providers/grades.js';
import type {PersonalSource} from '../tools.js';

/*
 * Remote MCP endpoint: the connector as a standard OAuth-protected MCP
 * resource (MCP authorization spec, RFC 9728 / RFC 9068 / RFC 8707). It
 * validates JWT access tokens from one configured issuer and maps `sub` to the
 * connector account. No platform-specific code lives here.
 */
const LOOPBACK=['localhost','127.0.0.1','[::1]'];
const MCP_PATH='/mcp';
const METADATA_PATH='/.well-known/oauth-protected-resource';
const MAX_BODY=1_000_000;
const MAX_TOKEN=8192;
const CLOCK_SKEW_SECONDS=60;
const ALGORITHMS=['ES256','RS256'];

export type McpResourceConfig={
  /** Origin the connector is reached on (used for the metadata URL). */
  origin:string;
  /** Issuer exactly as it appears in the tokens' `iss` claim. */
  issuer:string;
  /** Resource identifier of this endpoint. */
  resource:string;
  /** Required `aud` value; defaults to the resource. */
  audience:string;
  /** Require `typ: at+jwt` (RFC 9068). Default true. */
  requireAtJwt:boolean;
  /** Number of trusted reverse proxies in front of the connector; 0 (default) ignores X-Forwarded-For. */
  trustProxy:number;
  /** Base URL of the platform whose adapter created legacy (issuer-less) accounts, if any. */
  platformUrl:string|null;
};
export type McpEnv=Record<string,string|undefined>;

export function checkedUrl(value:string,what:string,opts:{path:boolean}) {
  let u:URL;try{u=new URL(value);}catch{throw new Error(`${what} is not a valid URL`);}
  if(u.username||u.password||u.search||u.hash)throw new Error(`${what} must not contain credentials, a query or a fragment`);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&LOOPBACK.includes(u.hostname)))throw new Error(`${what} must use https (http is accepted only on loopback)`);
  if(!opts.path&&u.pathname!=='/')throw new Error(`${what} must be an origin without a path`);
  return u;
}

/**
 * UBC_MCP_HTTP=on enables the endpoint (unset, empty or "off": disabled).
 * Requires UBC_PUBLIC_ORIGIN and UBC_OAUTH_ISSUER; UBC_MCP_RESOURCE overrides
 * the resource identifier (default `${UBC_PUBLIC_ORIGIN}/mcp`) and
 * UBC_OAUTH_AUDIENCE the accepted `aud` (default: the resource).
 */
export function mcpConfigFromEnv(env:McpEnv=process.env):McpResourceConfig|null {
  const flag=(env.UBC_MCP_HTTP??'').trim().toLowerCase();
  if(flag===''||flag==='off')return null;
  if(flag!=='on')throw new Error('UBC_MCP_HTTP must be "on" or "off"');
  const need=(key:string)=>{const v=(env[key]??'').trim();if(!v)throw new Error(`UBC_MCP_HTTP=on requires ${key}`);return v;};
  const origin=checkedUrl(need('UBC_PUBLIC_ORIGIN'),'UBC_PUBLIC_ORIGIN',{path:false}).origin;
  const issuer=need('UBC_OAUTH_ISSUER');checkedUrl(issuer,'UBC_OAUTH_ISSUER',{path:true});
  const rawResource=(env.UBC_MCP_RESOURCE??'').trim();
  const resource=rawResource||`${origin}${MCP_PATH}`;checkedUrl(resource,'UBC_MCP_RESOURCE',{path:true});
  const audience=(env.UBC_OAUTH_AUDIENCE??'').trim()||resource;
  const flagOf=(key:string,fallback:boolean)=>{
    const v=(env[key]??'').trim().toLowerCase();if(!v)return fallback;
    if(['true','1','on','yes'].includes(v))return true;if(['false','0','off','no'].includes(v))return false;
    throw new Error(`${key} must be true or false`);
  };
  const proxy=(env.UBC_TRUST_PROXY??'').trim().toLowerCase();
  const trustProxy=['','off','false'].includes(proxy)?0:proxy==='on'||proxy==='true'?1:Number(proxy);
  if(!Number.isInteger(trustProxy)||trustProxy<0||trustProxy>10)throw new Error('UBC_TRUST_PROXY must be a hop count between 1 and 10 (or off)');
  const adapter=(env.UBC_PLATFORM_ADAPTER??'').trim().toLowerCase()||(env.UBC_PUBLIC_ORIGIN?'mcphub':'');
  const platformRaw=['mcphub','mcphub-oauth'].includes(adapter)?(env.UBC_PLATFORM_URL||env.UBC_HUB_URL||env.UBC_PUBLIC_ORIGIN||''):'';
  let platformUrl:string|null=null;
  if(platformRaw){try{platformUrl=new URL(platformRaw).href.replace(/\/+$/,'');}catch{platformUrl=null;}}
  return {origin,issuer,resource,audience,requireAtJwt:flagOf('UBC_OAUTH_REQUIRE_AT_JWT',true),trustProxy,platformUrl};
}

export type VerifiedToken={iss:string;sub:string;scopes:string[];clientId:string;expiresAt:number};
/** `reason` is a category only (never token contents): size, malformed, alg, typ, iss, aud, exp, sub, kid, signature, claims. */
export class TokenInvalid extends Error {constructor(readonly reason:string){super(reason);}}
export class IssuerUnavailable extends Error {constructor(readonly reason:string){super(reason);}}
export type TokenVerifier=(token:string)=>Promise<VerifiedToken>;

class UpstreamError extends Error {}
const isKeySet=(v:unknown)=>typeof v==='object'&&v!==null&&Array.isArray((v as {keys?:unknown}).keys);
const bareIssuer=(s:string)=>s.replace(/\/+$/,'');

/** Verifies RFC 9068 JWT access tokens against the issuer's JWKS (discovered, cached, refetched on an unknown kid). */
export function createTokenVerifier(config:Pick<McpResourceConfig,'issuer'|'audience'|'requireAtJwt'>,request:typeof fetch=fetch):TokenVerifier {
  let lastReason='issuer discovery failed';
  let current:{jwks:ReturnType<typeof createRemoteJWKSet>;until:number}|null=null;
  let pending:Promise<ReturnType<typeof createRemoteJWKSet>>|null=null,failedUntil=0;
  const bounded:typeof fetch=async(input,init)=>{
    let r:Response;
    try{r=await request(input,init);}catch{throw new UpstreamError('JWKS fetch failed');}
    if(r.status!==200){await r.body?.cancel();throw new UpstreamError(`JWKS endpoint answered HTTP ${r.status}`);}
    let text:string;
    try{text=await readBounded(r,1_000_000);}catch{throw new UpstreamError('JWKS response unreadable or too large');}
    let doc:unknown;try{doc=JSON.parse(text);}catch{throw new UpstreamError('JWKS response is not JSON');}
    if(!isKeySet(doc))throw new UpstreamError('JWKS response is not a key set');
    return new Response(text,{status:200,headers:{'Content-Type':'application/json'}});
  };
  async function getJson(url:string) {
    const r=await request(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(r.status!==200){await r.body?.cancel();throw new UpstreamError(`issuer metadata answered HTTP ${r.status}`);}
    return JSON.parse(await readBounded(r,1_000_000)) as Record<string,unknown>;
  }
  async function discover() {
    const base=bareIssuer(config.issuer);let last:unknown;
    for(const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration']) {
      try {
        const meta=await getJson(base+path);
        if(typeof meta.issuer!=='string'||bareIssuer(meta.issuer)!==base)throw new UpstreamError('issuer metadata names a different issuer');
        if(typeof meta.jwks_uri!=='string')throw new UpstreamError('issuer metadata has no jwks_uri');
        const uri=checkedUrl(meta.jwks_uri,'jwks_uri',{path:true});
        // The key set is the only thing that can fail open, so it must be an https (or loopback) document.
        return createRemoteJWKSet(uri,{timeoutDuration:5000,cooldownDuration:30_000,cacheMaxAge:600_000,[customFetch]:bounded});
      }catch(e){last=e;}
    }
    throw last??new UpstreamError('issuer discovery failed');
  }
  async function jwks() {
    if(current&&current.until>Date.now())return current.jwks;
    if(failedUntil>Date.now())throw new IssuerUnavailable(lastReason);
    pending??=discover().finally(()=>{pending=null;});
    try{const set=await pending;current={jwks:set,until:Date.now()+3_600_000};return set;}
    catch(e){failedUntil=Date.now()+5000;lastReason=e instanceof UpstreamError?e.message:'issuer metadata unreachable or invalid';throw new IssuerUnavailable(lastReason);}
  }
  return async token=>{
    if(token.length>MAX_TOKEN)throw new TokenInvalid('size');
    let header:ReturnType<typeof decodeProtectedHeader>;
    try{header=decodeProtectedHeader(token);}catch{throw new TokenInvalid('malformed');}
    // Reject early what can never validate (none, HS*, anything else) before any key is fetched.
    if(typeof header.alg!=='string'||!ALGORITHMS.includes(header.alg))throw new TokenInvalid('alg');
    const keys=await jwks();
    let payload:JWTPayload;
    try {
      ({payload}=await jwtVerify(token,keys,{audience:config.audience,algorithms:ALGORITHMS,...(config.requireAtJwt?{typ:'at+jwt'}:{}),
        clockTolerance:CLOCK_SKEW_SECONDS,requiredClaims:['exp','iss','aud','sub']}));
    }catch(e) {
      if(e instanceof UpstreamError)throw new IssuerUnavailable(e.message);
      if(e instanceof errors.JWKSTimeout)throw new IssuerUnavailable('JWKS request timed out');
      if(e instanceof errors.JWKSInvalid)throw new IssuerUnavailable('JWKS is not a valid key set');
      if(e instanceof errors.JWTExpired)throw new TokenInvalid('exp');
      if(e instanceof errors.JWTClaimValidationFailed)throw new TokenInvalid(['aud','typ','exp','iss','sub'].includes(e.claim)?e.claim:'claims');
      if(e instanceof errors.JWKSNoMatchingKey)throw new TokenInvalid('kid');
      if(e instanceof errors.JWSSignatureVerificationFailed)throw new TokenInvalid('signature');
      if(e instanceof errors.JOSEAlgNotAllowed)throw new TokenInvalid('alg');
      if(e instanceof errors.JOSEError&&e.code==='ERR_JOSE_GENERIC')throw new IssuerUnavailable('JWKS request failed');
      throw new TokenInvalid('malformed');
    }
    // A single trailing slash is not significant on either side.
    if(typeof payload.iss!=='string'||normalizeIssuer(payload.iss)!==normalizeIssuer(config.issuer))throw new TokenInvalid('iss');
    const sub=payload.sub;
    // eslint-disable-next-line no-control-regex
    if(typeof sub!=='string'||!sub||sub.length>256||/[\u0000-\u001f\u007f]/.test(sub))throw new TokenInvalid('sub');
    const scope=typeof payload.scope==='string'?payload.scope.split(/\s+/).filter(Boolean):[];
    const clientId=typeof payload.client_id==='string'?payload.client_id:typeof payload.azp==='string'?payload.azp:'';
    return {iss:normalizeIssuer(config.issuer),sub,scopes:scope,clientId,expiresAt:payload.exp!};
  };
}

/** A personal data source for exactly one issuer+sub pair, read straight from the store. */
function accountSource(store:Store,iss:string,sub:string,legacyAllowed:()=>Promise<boolean>):PersonalSource {
  const revoked=()=>new SourceError('CONNECTION_REVOKED','Personal connection is missing or revoked. Connect your own UBC data first.');
  return {configured:()=>true,snapshots:async()=>{
    const found=store.accountForIssuer(iss,sub);
    if(!found||(found.via==='legacy'&&!(await legacyAllowed())))throw revoked();
    try{return store.get(found.account.id);}catch{throw revoked();}
  }};
}

/**
 * Legacy platform accounts carry no issuer. They are reachable through the
 * remote endpoint only when the configured issuer is the platform's own
 * authority, which is read from the platform's metadata.
 */
function platformAuthority(config:McpResourceConfig,request:typeof fetch,log:(m:string)=>void) {
  let cached:{ok:boolean;until:number}|null=null,warned=false;
  const warnOnce=(why:string)=>{if(warned)return;warned=true;log(`MCP: accounts created before issuer binding will not be matched, because ${why}. Reconnect them through the platform adapter or use link-account.`);};
  return async():Promise<boolean> => {
    if(cached&&cached.until>Date.now())return cached.ok;
    let ok=false;
    if(!config.platformUrl)warnOnce('no platform adapter is configured');
    else {
      try {
        for(const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration']) {
          const r=await request(config.platformUrl+path,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10_000)});
          if(r.status!==200){await r.body?.cancel();continue;}
          const meta=JSON.parse(await readBounded(r,1_000_000)) as {issuer?:unknown};
          if(typeof meta.issuer==='string'){ok=normalizeIssuer(meta.issuer)===normalizeIssuer(config.issuer);break;}
        }
        if(!ok)warnOnce('UBC_OAUTH_ISSUER is not the platform\'s issuer (or the platform metadata could not be read)');
      }catch{warnOnce('the platform metadata could not be read');}
    }
    cached={ok,until:Date.now()+(ok?600_000:60_000)};return ok;
  };
}

export type McpResource={
  config:McpResourceConfig;
  handles(url:string):boolean;
  handle(req:IncomingMessage,res:ServerResponse):Promise<void>;
  close():Promise<void>;
};

function sendJson(res:ServerResponse,status:number,value:unknown,headers:Record<string,string>={}) {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));
}

export function mcpResource(store:Store,config:McpResourceConfig,options:{verifier?:TokenVerifier;log?:(message:string)=>void;request?:typeof fetch}={}):McpResource {
  const request=options.request??fetch,verify=options.verifier??createTokenVerifier(config,request),log=options.log??(m=>console.error(m));
  const legacyAllowed=platformAuthority(config,request,log);
  const lastLogged=new Map<string,number>();
  const logLimited=(key:string,message:string)=>{const now=Date.now();if((lastLogged.get(key)??0)+60_000>now)return;lastLogged.set(key,now);log(message);};
  const resourceOrigin=new URL(config.resource).origin,metadataUrl=`${new URL(config.origin).origin}${METADATA_PATH}`;
  const resourcePath=new URL(config.resource).pathname;
  const metadataPaths=[...new Set([METADATA_PATH,resourcePath==='/'?METADATA_PATH:METADATA_PATH+resourcePath.replace(/\/+$/,''),`${METADATA_PATH}${MCP_PATH}`])];
  const metadata={resource:config.resource,authorization_servers:[config.issuer],bearer_methods_supported:['header'],scopes_supported:[] as string[]};
  // Public catalogue/grade caches hold no user data and are shared; everything personal is built per request.
  const http=new PublicHttp(),shared={http,catalog:new Catalog(http),grades:new Grades(http)};
  const handler=createMcpHandler(ctx=>{
    const sub=ctx.authInfo?.extra?.sub;
    if(typeof sub!=='string'||!sub)throw new Error('Unauthenticated MCP request');
    const iss=ctx.authInfo?.extra?.iss;
    if(typeof iss!=='string')throw new Error('Unauthenticated MCP request');
    return createServerFor(accountSource(store,iss,sub,legacyAllowed),shared).server;
  },{legacy:'stateless',maxRequestBodySize:MAX_BODY,onerror:e=>log(`MCP request error: ${e.name}`)});
  // Requests with a valid token are never limited by address, only per issuer+subject. The per-address limiters throttle requests that
  // fail authentication: invalid tokens (120/min) and, more generously, missing or expired ones (600/min).
  const failures=new Map<string,{count:number;until:number}>(),routine=new Map<string,{count:number;until:number}>(),subjects=new Map<string,{count:number;until:number}>();
  const hit=(map:Map<string,{count:number;until:number}>,key:string,limit:number)=>{
    const now=Date.now(),prev=map.get(key);
    if(map.size>10000)for(const [k,v]of map)if(v.until<now)map.delete(k);
    const state=prev&&prev.until>now?prev:{count:0,until:now+60_000};state.count++;map.set(key,state);return state.count<=limit;
  };
  const clientAddress=(req:IncomingMessage)=>{
    if(config.trustProxy>0) {
      const hops=(Array.isArray(req.headers['x-forwarded-for'])?req.headers['x-forwarded-for'].join(','):req.headers['x-forwarded-for']??'').split(',').map(x=>x.trim()).filter(Boolean);
      // The rightmost entries were appended by our own proxies; the first untrusted one is the client.
      if(hops.length>=config.trustProxy)return hops[hops.length-config.trustProxy]!;
    }
    return req.socket.remoteAddress??'unknown';
  };
  const challenge=(presented:boolean)=>`Bearer ${presented?'error="invalid_token", ':''}resource_metadata="${metadataUrl}"`;

  async function serve(req:IncomingMessage,res:ServerResponse,search:string) {
    if(req.headers.origin)return sendJson(res,403,{error:'BROWSER_REQUEST_REFUSED'});
    if(!['POST','GET','DELETE'].includes(req.method??''))return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'},{Allow:'POST, GET, DELETE'});
    const ip=clientAddress(req);
    const header=req.headers.authorization??'',presented=/^Bearer\s/i.test(header);
    // Discovery probes (no token) and expired tokens are normal client behaviour: they only count against a generous allowance.
    if(!presented){if(!hit(routine,ip,600))return sendJson(res,429,{error:'RATE_LIMITED'});return sendJson(res,401,{error:'unauthorized'},{'WWW-Authenticate':challenge(false)});}
    let auth:VerifiedToken;
    try{auth=await verify(header.replace(/^Bearer\s+/i,'').trim());}
    catch(e) {
      if(e instanceof IssuerUnavailable){logLimited('unavailable:'+e.reason,`MCP token verification unavailable: ${e.reason}`);return sendJson(res,503,{error:'temporarily_unavailable'},{'Retry-After':'10'});}
      const expired=e instanceof TokenInvalid&&e.reason==='exp';
      if(!hit(expired?routine:failures,ip,expired?600:120))return sendJson(res,429,{error:'RATE_LIMITED'});
      logLimited('invalid:'+(e instanceof TokenInvalid?e.reason:'other'),`MCP token rejected: ${e instanceof TokenInvalid?e.reason:'other'}`);
      return sendJson(res,401,{error:'invalid_token'},{'WWW-Authenticate':challenge(true)});
    }
    if(!hit(subjects,`${auth.iss}\n${auth.sub}`,600))return sendJson(res,429,{error:'RATE_LIMITED'},{'Retry-After':'60'});
    let body:Buffer|undefined;
    if(req.method==='POST') {
      if(Number(req.headers['content-length']??0)>MAX_BODY){req.resume();return sendJson(res,413,{error:'PAYLOAD_TOO_LARGE'});}
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY){req.destroy();return sendJson(res,413,{error:'PAYLOAD_TOO_LARGE'});}chunks.push(chunk);}
      body=Buffer.concat(chunks);
    }
    const headers=new Headers();
    for(const [k,v]of Object.entries(req.headers)){
      if(v===undefined||k==='authorization'||k==='cookie')continue;
      if(Array.isArray(v))for(const x of v)headers.append(k,x);else headers.set(k,v);
    }
    const authInfo:AuthInfo={token:'',clientId:auth.clientId,scopes:auth.scopes,expiresAt:auth.expiresAt,resource:new URL(config.resource),extra:{sub:auth.sub,iss:auth.iss}};
    const request=new Request(`${resourceOrigin}${MCP_PATH}${search}`,{method:req.method!,headers,...(body?{body:new Uint8Array(body)}:{})});
    const response=await handler.fetch(request,{authInfo});
    res.statusCode=response.status;
    response.headers.forEach((v,k)=>res.setHeader(k,v));
    if(!res.hasHeader('Cache-Control'))res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(!response.body){res.end();return;}
    const reader=response.body.getReader();
    res.on('close',()=>{reader.cancel().catch(()=>{});});
    try {
      for(;;) {
        const part=await reader.read();if(part.done||res.destroyed)break;
        if(!res.write(part.value))await once(res,'drain');
      }
    }finally{if(!res.writableEnded)res.end();}
  }

  return {
    config,
    handles:url=>{const p=new URL(url,'http://connector.invalid').pathname;return p===MCP_PATH||metadataPaths.includes(p);},
    async handle(req,res) {
      const parsed=new URL(req.url??'/','http://connector.invalid');
      if(metadataPaths.includes(parsed.pathname)) {
        if(req.method!=='GET')return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'},{Allow:'GET'});
        return sendJson(res,200,metadata);
      }
      try{await serve(req,res,parsed.search);}
      catch{if(!res.headersSent)sendJson(res,500,{error:'SERVICE_UNAVAILABLE'});else res.end();}
    },
    close:()=>handler.close(),
  };
}
