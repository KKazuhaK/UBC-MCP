import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js'],env:{...process.env,UBC_PROFILE:'public'},stderr:'pipe'});
const client=new Client({name:'ubc-protocol-check',version:'1.0.0'});
try {
  await client.connect(transport);const {tools}=await client.listTools();
  assert.equal(tools.length,7);assert.ok(tools.every(t=>t.annotations?.readOnlyHint));
  const result=await client.callTool({name:'get_data_status',arguments:{}});assert.ok(!result.isError);
  const invalid=await client.callTool({name:'get_course',arguments:{campus:'UBCV',subject:'../../private',course:'110'}});assert.ok(invalid.isError);
  console.log('PASS: stdio initialization, tool discovery, read-only call and input validation');
}finally{await client.close();}
