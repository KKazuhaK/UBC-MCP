import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store} from './store.js';
function json(res:ServerResponse,status:number,value:unknown) {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));
}
export function connectorServer(store:Store) {
  // This service accepts bearer tokens only, never browser cookies or cross-origin requests.
  const recent=new Map<string,{count:number;until:number}>();
  const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
    if (req.url==='/healthz'&&req.method==='GET') return json(res,200,{ok:true});
    if (req.url!=='/v1/snapshots'||!['GET','POST'].includes(req.method??'')) return json(res,404,{error:'NOT_FOUND'});
    if (req.headers.origin) return json(res,403,{error:'BROWSER_REQUEST_REFUSED'});
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
