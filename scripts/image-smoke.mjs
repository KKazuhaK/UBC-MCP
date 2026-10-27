// Usage: node scripts/image-smoke.mjs IMAGE
// Runs the stdio image with no network and no platform configuration.
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const image=process.argv[2];if(!image)throw new Error('usage: image-smoke.mjs IMAGE');
const client=new Client({name:'ubc-image-smoke',version:'1.0.0'});
const transport=new StdioClientTransport({command:'docker',args:['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL',image],env:{PATH:process.env.PATH??''},stderr:'pipe'});
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,7);
  assert.ok(!(await client.callTool({name:'get_data_status',arguments:{}})).isError);
  console.log('PASS: image initializes over stdio, lists 7 tools and answers an offline call');
}finally{await client.close();}
