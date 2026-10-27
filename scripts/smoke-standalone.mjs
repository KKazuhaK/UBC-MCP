// Standalone smoke test: no platform, no connector link, no network access needed.
// Starts the MCP server over stdio (public profile) and the connector HTTP
// service with no adapter, from a scrubbed environment.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const clean={PATH:process.env.PATH??''};  // nothing from UBC_* leaks in
const PUBLIC_TOOLS=['compare_courses','get_course','get_course_grades','get_data_status','list_grade_sessions','list_subjects','search_courses'];

async function structuredError(url) {
  // Personal profile against the standalone connector with a token it never issued.
  const client=new Client({name:'ubc-standalone-smoke-personal',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js'],env:{...clean,UBC_PROFILE:'personal',UBC_CONNECTOR_URL:url,UBC_CONNECTOR_TOKEN:'A'.repeat(43)},stderr:'pipe'});
  try {
    await client.connect(transport);
    const r=await client.callTool({name:'get_my_schedule',arguments:{campus:'UBCV',academicPeriod:'2026W-2'}});
    assert.ok(r.isError);assert.equal(JSON.parse(r.content[0].text).error,'CONNECTION_REVOKED');
    assert.equal(typeof JSON.parse(r.content[0].text).message,'string');
  }finally{await client.close();}
}

async function mcp() {
  const client=new Client({name:'ubc-standalone-smoke',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js'],env:{...clean,UBC_PROFILE:'public'},stderr:'pipe'});
  try {
    await client.connect(transport);  // performs initialize
    assert.equal(client.getServerVersion()?.name,'ubc-mcp');
    assert.equal(client.getServerVersion()?.version,version);
    const {tools}=await client.listTools();
    assert.deepEqual(tools.map(t=>t.name).sort(),PUBLIC_TOOLS);
    const status=await client.callTool({name:'get_data_status',arguments:{}});  // offline
    assert.ok(!status.isError);assert.match(status.content[0].text,/"connected": false/);
    const bad=await client.callTool({name:'get_course',arguments:{campus:'UBCV',subject:'../../private',course:'110'}});
    assert.ok(bad.isError);
    console.log('PASS: mcp server standalone (initialize, 7 tools, offline call, structured validation error)');
  }finally{await client.close();}
}

async function connector() {
  const dir=mkdtempSync(join(tmpdir(),'ubc-smoke-')),port=20000+Math.floor(Math.random()*20000);
  const child=spawn(process.execPath,['dist/connector/cli.js','serve'],{env:{...clean,UBC_DATA_DIR:dir,UBC_CONNECTOR_PORT:String(port)},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',d=>{stderr+=d;});
  try {
    let health;
    for(let i=0;i<50&&!health;i++) {
      try{const r=await fetch(`http://127.0.0.1:${port}/healthz`);if(r.ok)health=await r.json();}catch{await new Promise(r=>setTimeout(r,200));}
    }
    assert.ok(health,'connector did not become healthy: '+stderr);
    assert.deepEqual(health,{ok:true,version});
    assert.equal((await fetch(`http://127.0.0.1:${port}/ubc/`)).status,404);  // no adapter, no platform routes
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/snapshots`)).status,401);
    await structuredError(`http://127.0.0.1:${port}`);
    console.log('PASS: connector standalone (/healthz with version, no platform routes, tokens required, {error,message} CONNECTION_REVOKED on 401)');
  }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
}
await mcp();await connector();
