import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../store.js';
import type {PlatformAdapter} from './index.js';
import {page,script} from './mcphub-web.js';
import {handleClaim,SERVER_NAME} from './shared.js';
export type McphubConfig={origin:string;platformUrl?:string;serverName?:string};
// MCPHub integration: reuses the caller's Hub session to read identity and to
// save a per-user credential. Everything Hub-specific lives in this module.
export function mcphubAdapter(store:Store,config:McphubConfig):PlatformAdapter {
  const origin=new URL(config.origin).origin,hub=new URL(config.platformUrl??origin),serverName=config.serverName??'ubc-personal';
  if(!SERVER_NAME.test(serverName))throw new Error('Invalid platform server name');
  if(new URL(origin).protocol!=='https:'||!['https:','http:'].includes(hub.protocol)||hub.username||hub.password||hub.search||hub.hash)throw new Error('Invalid self-service origin');
  async function api(path:string,cookie:string,method='GET',body?:unknown) {
    const r=await fetch(new URL(path,hub),{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!r.ok) {await r.body?.cancel();throw new Error('Hub denied request');}
    const data=await r.json() as any;if(data?.success===false)throw new Error('Hub denied request');return data;
  }
  const handle=async(req:IncomingMessage,res:ServerResponse,send:(status:number,value:unknown)=>void)=>{
    if(req.url==='/ubc/capabilities'&&req.method==='GET'){send(200,{extensionAuthorization:1});return;}
    if(req.url==='/ubc/'||req.url==='/ubc/app.js') {
      if(req.method!=='GET'){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
      res.writeHead(200,{'Content-Type':req.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
      res.end(req.url.endsWith('.js')?script:page.replaceAll('{{PLATFORM_ORIGIN}}',origin).replaceAll('{{SERVER_NAME}}',serverName));return;
    }
    if(!['/ubc/api/status','/ubc/api/connect','/ubc/api/pair','/ubc/api/disconnect','/ubc/api/claim'].includes(req.url??'')){send(404,{error:'NOT_FOUND'});return;}
    const claim=req.url==='/ubc/api/claim';
    const expected=req.url==='/ubc/api/status'?'GET':'POST';
    if(req.method!==expected){send(405,{error:'METHOD_NOT_ALLOWED'});return;}
    if(claim) {
      await handleClaim(store,req,res,send);return;
    }
    if(req.headers.authorization||req.headers['x-auth-token']||!req.headers.cookie||(req.method==='POST'&&req.headers.origin!==origin)||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')){send(403,{error:'LOGIN_OR_SAME_ORIGIN_REQUIRED'});return;}
    try {
      const cookie=req.headers.cookie;
      const user=await api('/api/better-auth/user',cookie),list=await api('/api/credentials',cookie);
      if(user.success!==true||typeof user.user?.username!=='string'||!user.user.username||list.success!==true||!Array.isArray(list.data)||!list.data.some((s:any)=>s.serverName===serverName&&s.credentialTemplate?.some((t:any)=>t.target==='env'&&t.name==='UBC_CONNECTOR_TOKEN')))throw new Error('Not authorized');
      const username=user.user.username;
      if(req.url==='/ubc/api/connect') {
        const a=store.account(username,true)!;
        await api(`/api/credentials/${encodeURIComponent(serverName)}`,cookie,'PUT',{values:{'env.UBC_CONNECTOR_TOKEN':a.readToken}});
        send(200,{connected:true});
      }else if(req.url==='/ubc/api/pair')send(200,store.pair(username));
      else if(req.url==='/ubc/api/disconnect') {
        const a=store.account(username);if(a)store.revoke(a.id);
        // Connector revocation always wins, even if Hub credential cleanup fails.
        try{await api(`/api/credentials/${encodeURIComponent(serverName)}`,cookie,'DELETE');send(200,{connected:false});}catch{send(200,{connected:false,warning:'Connection revoked; remove the saved Hub credential in Credentials.'});}
      }else {
        const a=store.account(username);send(200,{username,connected:!!a,scopes:a?store.get(a.id).map(s=>({campus:s.campus,period:s.academicPeriod.id,kind:s.kind,capturedAt:s.capturedAt,sections:s.sections.length})):[]});
      }
    }catch{send(403,{error:'LOGIN_OR_UBC_ACCESS_REQUIRED',message:'Sign in to Hub and ensure the UBC personal service is available to your account. Retry Connect if credential saving failed.'});}
  };
  return {name:'mcphub',preflightPaths:['/ubc/api/claim'],handles:url=>url.startsWith('/ubc/'),handle};
}
