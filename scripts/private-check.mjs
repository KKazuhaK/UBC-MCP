import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {parseSnapshot} from '../dist/model.js';
import {Store} from '../dist/connector/store.js';
import {connectorServer} from '../dist/connector/http.js';

const path=process.argv[2];if(!path)throw new Error('Provide a private snapshot file path');
const raw=JSON.parse(readFileSync(path,'utf8')),snapshots=(Array.isArray(raw)?raw:[raw]).map(s=>parseSnapshot(s));
const directory=mkdtempSync(join(tmpdir(),'ubc-private-check-')),store=new Store(directory),binding=store.create('local-acceptance'),other=store.create('other-local-user');
const http=connectorServer(store);await new Promise(r=>http.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${http.address().port}`;
const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js'],env:{...process.env,UBC_PROFILE:'personal',UBC_CONNECTOR_URL:base,UBC_CONNECTOR_TOKEN:binding.readToken},stderr:'pipe'});
const client=new Client({name:'ubc-private-acceptance',version:'1.0.0'});
const unpack=result=>JSON.parse(result.content[0].text.split('\n').slice(1,-1).join('\n'));
try{
  for(const snapshot of snapshots){
    const response=await fetch(base+'/v1/snapshots',{method:'POST',headers:{Authorization:`Bearer ${binding.uploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
    assert.equal(response.status,200);await response.body.cancel();
  }
  assert.deepEqual(store.get(other.id),[]);
  await client.connect(transport);assert.equal((await client.listTools()).tools.length,11);
  const status=unpack(await client.callTool({name:'get_data_status',arguments:{}}));assert.equal(status.personal.periods.length,snapshots.length);
  const results=[];
  for(const s of snapshots){
    if(s.kind!=='registrations')continue;
    const result=await client.callTool({name:'get_my_schedule',arguments:{campus:s.campus,academicPeriod:s.academicPeriod.id}});assert.ok(!result.isError);
    const data=unpack(result);assert.equal(data.registrations.length,s.enrollments.length);
    const schedule=await client.callTool({name:'check_schedule',arguments:{campus:s.campus,academicPeriod:s.academicPeriod.id,kind:'registrations',sectionIds:s.sections.map(c=>c.id)}});assert.ok(!schedule.isError);
    results.push({period:s.academicPeriod.id,registrations:data.registrations.length,conflicts:unpack(schedule).conflicts.length});
  }
  store.revoke(binding.id);
  const revoked=await client.callTool({name:'get_my_schedule',arguments:{campus:snapshots[0].campus,academicPeriod:snapshots[0].academicPeriod.id}});
  assert.ok(revoked.isError);assert.match(revoked.content[0].text,/CONNECTION_REVOKED/);
  console.log(JSON.stringify({status:'pass',transport:'local stdio -> loopback connector',results,isolation:'pass',revocation:'pass',uploadedToPublicInternet:false},null,2));
}finally{await client.close();await new Promise(r=>http.close(r));store.close();rmSync(directory,{recursive:true,force:true});}
