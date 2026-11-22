import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {hubDefine} from '../scripts/default-hub.mjs';

async function boot(state){
 let onAlarm,onStartup;const created=[],tabs=[];
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:()=>{}},onStartup:{addListener:fn=>{onStartup??=[];onStartup.push(fn);}}},
  permissions:{contains:async()=>true},
  storage:{local:{get:async()=>state,set:async x=>Object.assign(state,x),remove:async()=>{},setAccessLevel:async()=>{}}},
  tabs:{query:async()=>[],create:async x=>{tabs.push(x);return {id:9};},get:async()=>({id:9,status:'complete',url:'https://wd10.myworkday.com/ubc/d/task/2998$28771.htmld',active:false}),
   sendMessage:async()=>({ok:true,count:3,kinds:['registrations']}),remove:async()=>{},onUpdated:{addListener:()=>{}}},
  alarms:{get:async()=>({}),create:async(name,info)=>created.push({name,...info}),clear:async()=>{},onAlarm:{addListener:fn=>onAlarm=fn}},
  scripting:{executeScript:async()=>{}}};
 const code=await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',define:hubDefine()});
 runInNewContext(code.outputFiles[0].text,{chrome,fetch:async()=>({ok:true}),crypto:webcrypto,URL,AbortSignal,console,Date,setTimeout:fn=>queueMicrotask(fn)});
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
 return {created,tabs,state,startup:()=>onStartup.forEach(fn=>fn()),alarm:name=>onAlarm({name}),settle};
}
const connected=()=>({ubcConnection:{origin:'https://mcp.kazuhahub.com',uploadToken:'t'.repeat(43)},ubcAutoSync:true});
test('a browser start schedules one sync a minute later, which runs unless a recent sync already did',async()=>{
 const b=await boot({...connected(),ubcLastSync:{at:new Date(Date.now()-60*60_000).toISOString(),count:1}});
 b.startup();await b.settle();
 assert.ok(b.created.some(a=>a.name==='ubc-startup-sync'&&a.delayInMinutes===1));
 b.alarm('ubc-startup-sync');await b.settle();
 assert.equal(b.tabs.length,1,'opens the registration page once');
 assert.ok(Date.now()-Date.parse(b.state.ubcLastSync.at)<60_000);
 const fresh=await boot({...connected(),ubcLastSync:{at:new Date().toISOString(),count:1}});
 fresh.alarm('ubc-startup-sync');await fresh.settle();assert.equal(fresh.tabs.length,0);
 const paused=await boot({...connected(),ubcAutoSync:false});
 paused.alarm('ubc-startup-sync');await paused.settle();assert.equal(paused.tabs.length,0);
});
