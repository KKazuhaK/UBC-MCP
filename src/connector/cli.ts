#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {parseSnapshot} from '../model.js';
import {Store} from './store.js';
import {connectorServer} from './http.js';
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
    else if(command==='revoke'){if(!process.argv[3])throw new Error('Binding ID required');store.revoke(process.argv[3]);store.close();console.log('Binding revoked and snapshots removed');}
    else if(command==='serve'){
      const host=process.env.UBC_CONNECTOR_HOST??'127.0.0.1';
      if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('Invalid connector bind address');
      const port=Number(process.env.UBC_CONNECTOR_PORT??8792);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');
      const server=connectorServer(store,process.env.UBC_PUBLIC_ORIGIN?{origin:process.env.UBC_PUBLIC_ORIGIN,...(process.env.UBC_HUB_URL?{hubUrl:process.env.UBC_HUB_URL}:{})}:undefined);server.listen(port,host,()=>console.error(`UBC connector listening on ${host}:${port}`));
      for(const sig of ['SIGINT','SIGTERM']as const)process.on(sig,()=>server.close(()=>{store.close();process.exit(0);}));
    }else{store.close();throw new Error('Use serve, create-binding <label>, revoke <id>, or push <file>');}
  }
}catch(e){console.error(e instanceof Error?e.message:'Connector failed');process.exitCode=1;}
