#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {parseSnapshot} from '../model.js';
import {Store} from './store.js';
import {connectorServer} from './http.js';
import {adapterFromEnv} from './adapters/index.js';
import {mcpConfigFromEnv,mcpResource,checkedUrl} from './mcp-http.js';
const command=process.argv[2],directory=process.env.UBC_DATA_DIR??'.data/connector';
try {
  if(command==='push') {
    const file=process.argv[3];if(!file)throw new Error('Provide a snapshot JSON file');
    const input=JSON.parse(await readFile(file,'utf8'));
    const items=Array.isArray(input)?input:[input];
    if(!items.length||items.length>20)throw new Error('Expected 1-20 snapshots');
    const snapshots=items.map(s=>parseSnapshot(s));
    const raw=process.env.UBC_CONNECTOR_URL,token=process.env.UBC_UPLOAD_TOKEN;
    if(!raw||!token)throw new Error('Set UBC_CONNECTOR_URL and UBC_UPLOAD_TOKEN');
    const url=new URL(raw);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('HTTPS required');
    if(url.username||url.password||url.search||url.hash)throw new Error('Invalid connector URL');
    let completed=0;
    for(const snapshot of snapshots){
      const response=await fetch(new URL('/v1/snapshots',url),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify(snapshot),redirect:'error',signal:AbortSignal.timeout(20_000)});
      if(!response.ok)throw new Error(`Sync stopped after ${completed}/${snapshots.length} snapshots (HTTP ${response.status})`);
      await response.body?.cancel();completed++;
    }
    console.log(`${completed} snapshot(s) synchronized. Capture times were preserved.`);
  }else {
    const store=new Store(directory);
    if(command==='create-binding'){console.log(JSON.stringify(store.create(process.argv[3]??''),null,2));store.close();}
    else if(command==='link-account'){
      const arg=(name:string)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
      const sub=arg('--sub'),issuer=arg('--issuer')??process.env.UBC_OAUTH_ISSUER;
      if(!sub||sub.length>256||/[\u0000-\u001f\u007f]/.test(sub))throw new Error('link-account requires --sub <sub> (1-256 characters)');
      if(!issuer)throw new Error('Provide --issuer <url> or set UBC_OAUTH_ISSUER');
      checkedUrl(issuer,'issuer',{path:true});
      const account=store.linkedAccount(issuer,sub,true)!;
      console.log(JSON.stringify({sub,issuer,id:account.id,uploadToken:account.uploadToken},null,2));store.close();
    }
    else if(command==='revoke'){if(!process.argv[3])throw new Error('Binding ID required');store.revoke(process.argv[3]);store.close();console.log('Binding revoked and snapshots removed');}
    else if(command==='serve'){
      const host=process.env.UBC_CONNECTOR_HOST??'127.0.0.1';
      if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('Invalid connector bind address');
      const port=Number(process.env.UBC_CONNECTOR_PORT??8792);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');
      const mcpConfig=mcpConfigFromEnv(),mcp=mcpConfig?mcpResource(store,mcpConfig):null;
      const server=connectorServer(store,adapterFromEnv(store),mcp);server.listen(port,host,()=>console.error(`UBC connector listening on ${host}:${port}${mcp?` (remote MCP resource ${mcp.config.resource})`:''}`));
      for(const sig of ['SIGINT','SIGTERM']as const)process.on(sig,()=>server.close(()=>{void (mcp?.close()??Promise.resolve()).finally(()=>{store.close();process.exit(0);});}));
    }else{store.close();throw new Error('Use serve, create-binding <label>, link-account --sub <sub> [--issuer <url>], revoke <id>, or push <file>');}
  }
}catch(e){console.error(e instanceof Error?e.message:'Connector failed');process.exitCode=1;}
