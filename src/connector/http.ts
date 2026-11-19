import {isExtensionOrigin} from './extension-origin.js';
import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store} from './store.js';
import type {PlatformAdapter} from './adapters/index.js';
import type {McpResource} from './mcp-http.js';
import {VERSION} from '../version.js';
import {Limiter,clientKey} from './limiter.js';
import {DEFAULT_READINESS,readiness} from './readiness.js';
import type {ReadinessConfig} from './readiness.js';
function json(res:ServerResponse,status:number,value:unknown) {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));
}
export function connectorServer(store:Store,adapter?:PlatformAdapter|null,mcp?:McpResource|null,readinessConfig:ReadinessConfig=DEFAULT_READINESS) {
  // Snapshot reads require bearer tokens; an optional platform adapter owns its own routes and session validation.
  const recent=new Map<string,{count:number;until:number}>(),readinessRecent=new Limiter(),failedReadiness=new Limiter();
  const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
    if(req.method==='OPTIONS'&&['/v1/snapshots',...(adapter?.preflightPaths??[])].includes(req.url??'')&&isExtensionOrigin(req.headers.origin??'')&&!req.headers.cookie){
      res.writeHead(204,{'Access-Control-Allow-Origin':req.headers.origin!,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Vary':'Origin'});res.end();return;
    }
    let pathname='';try{pathname=new URL(req.url??'/','http://connector.invalid').pathname;}catch{/* unparseable: no route matches */}
    if(pathname==='/v1/readiness'||pathname==='/v1/readiness/') {
      // Own limits: failed authentications per IP (token guessing), and requests per binding after authentication.
      // Neither shares the snapshot API's per-IP bucket, so the two kinds of traffic cannot starve each other.
      if(req.method!=='GET')return json(res,404,{error:'NOT_FOUND'});
      if(req.headers.origin)return json(res,403,{error:'BROWSER_REQUEST_REFUSED'});
      const now=Date.now(),ip=clientKey(req.socket.remoteAddress??'unknown');
      const token=/^Bearer ([\w-]+)$/.exec(req.headers.authorization??'')?.[1]??'';
      const id=store.authenticate(token,'read');
      if(!id) {
        // Behind a proxy every client shares one IP, so failures may throttle other failures but never a valid token.
        const failures=failedReadiness.get(ip,now);
        if(failures.count>=60)return json(res,429,{error:'RATE_LIMITED'});
        failures.count++;return json(res,401,{error:'UNAUTHORIZED'});
      }
      const b=readinessRecent.get(id,now);b.count++;
      if(b.count>60)return json(res,429,{error:'RATE_LIMITED'});
      try {
        const summary=store.summary(id);
        if(!summary)return json(res,401,{error:'UNAUTHORIZED'});
        return json(res,200,readiness(summary,now,readinessConfig));
      }catch{return json(res,500,{error:'INTERNAL_ERROR'});}
    }
    if (req.url==='/healthz'&&req.method==='GET') return json(res,200,{ok:true,version:VERSION});
    // The OAuth-protected MCP endpoint owns /mcp and the protected-resource metadata; it never sets CORS headers.
    if(mcp&&mcp.handles(req.url??''))return mcp.handle(req,res);
    if(adapter&&adapter.handles(req.url??'')) {
      const ip=req.socket.remoteAddress??'unknown',now=Date.now(),key=`ui:${ip}`,prev=recent.get(key);
      const state=prev&&prev.until>now?prev:{count:0,until:now+60_000};state.count++;recent.set(key,state);
      if(state.count>120)return json(res,429,{error:'RATE_LIMITED'});
      try{await adapter.handle(req,res,(status,value)=>json(res,status,value));}catch{if(!res.headersSent)json(res,503,{error:'SERVICE_UNAVAILABLE'});else res.end();}return;
    }
    if (req.url!=='/v1/snapshots'||!['GET','POST'].includes(req.method??'')) return json(res,404,{error:'NOT_FOUND'});
    if(req.headers.origin) {
      if(req.method!=='POST'||req.headers.cookie||!isExtensionOrigin(req.headers.origin))return json(res,403,{error:'BROWSER_REQUEST_REFUSED'});
      res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');
    }
    const ip=req.socket.remoteAddress??'unknown',now=Date.now(),prev=recent.get(ip);
    if (recent.size>10000) for (const [key,v]of recent)if(v.until<now)recent.delete(key);
    const state=prev&&prev.until>now?prev:{count:0,until:now+60_000};state.count++;recent.set(ip,state);
    if(state.count>240)return json(res,429,{error:'RATE_LIMITED'});
    const mode=req.method==='GET'?'read':'upload';
    const token=/^Bearer ([\w-]+)$/.exec(req.headers.authorization??'')?.[1]??'';
    const id=store.authenticate(token,mode);if(!id)return json(res,401,{error:'UNAUTHORIZED'});
    try {
      if(mode==='read')return json(res,200,store.get(id));
      if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'JSON_REQUIRED'});
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>4_000_000){json(res,413,{error:'PAYLOAD_TOO_LARGE'});req.destroy();return;}chunks.push(chunk);}
      const result=store.put(id,JSON.parse(Buffer.concat(chunks).toString('utf8')));
      json(res,200,{ok:true,...result});
    }catch{json(res,400,{error:'INVALID_OR_OUTDATED_SNAPSHOT'});}
  });
  server.requestTimeout=30_000;server.headersTimeout=15_000;
  return server;
}
