import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {hubDefine} from '../scripts/default-hub.mjs';
import {reminderDue,remindHours} from '../dist/collector/reminder-policy.js';

const REMINDER='chrome-extension://extension-id/reminder.html';
async function boot(state,{openTabs=[]}={}){
 let onAlarm,onStartup=[];const created=[],tabs=[];
 const chrome={runtime:{id:'extension-id',getURL:p=>'chrome-extension://extension-id/'+p,onMessage:{addListener:()=>{}},onStartup:{addListener:fn=>onStartup.push(fn)}},
  permissions:{contains:async()=>true},
  storage:{local:{get:async()=>state,set:async x=>Object.assign(state,x),remove:async()=>{},setAccessLevel:async()=>{}}},
  tabs:{query:async q=>[...openTabs,...tabs].filter(t=>q.url===REMINDER?t.url===REMINDER:t.url?.startsWith('https://wd10.myworkday.com/ubc/')),
   create:async x=>{tabs.push(x);return {id:9};},get:async()=>({id:9,status:'complete',url:'https://wd10.myworkday.com/ubc/d/task/2998$28771.htmld',active:false}),
   sendMessage:async()=>({ok:true,count:3,kinds:['registrations']}),remove:async()=>{},onUpdated:{addListener:()=>{}}},
  alarms:{get:async()=>({}),create:async(name,info)=>created.push({name,...info}),clear:async()=>{},onAlarm:{addListener:fn=>onAlarm=fn}},
  scripting:{executeScript:async()=>{}}};
 const code=await build({entryPoints:['src/collector/background.ts'],bundle:true,platform:'browser',format:'iife',write:false,target:'chrome120',define:hubDefine()});
 runInNewContext(code.outputFiles[0].text,{chrome,fetch:async()=>({ok:true}),crypto:webcrypto,URL,AbortSignal,console,Date,setTimeout:fn=>queueMicrotask(fn)});
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
 return {created,tabs,state,startup:()=>onStartup.forEach(fn=>fn()),alarm:name=>onAlarm({name}),settle};
}
const hoursAgo=h=>new Date(Date.now()-h*3600_000).toISOString();
const connected=(extra={})=>({ubcConnection:{origin:'https://mcp.kazuhahub.com',uploadToken:'t'.repeat(43)},ubcAutoSync:true,...extra});

test('a browser start or the alarm never opens Workday; old data opens the reminder page once',async()=>{
 const b=await boot(connected({ubcLastSync:{at:hoursAgo(80),count:1}}));
 b.startup();await b.settle();
 assert.ok(b.created.some(a=>a.name==='ubc-startup-sync'&&a.delayInMinutes===1));
 b.alarm('ubc-startup-sync');await b.settle();
 assert.deepEqual(b.tabs.map(t=>t.url),[REMINDER]);
 assert.ok(b.state.ubcSnoozeUntil>Date.now(),'an ignored reminder snoozes itself');
 b.alarm('ubc-registration-sync');await b.settle();
 assert.equal(b.tabs.length,1,'no second reminder while snoozed');
});
test('an open Workday page is synced in the background, and fresh data needs no reminder',async()=>{
 const b=await boot(connected({ubcLastSync:{at:hoursAgo(1),count:1}}),{openTabs:[{id:4,url:'https://wd10.myworkday.com/ubc/d/home.htmld'}]});
 b.alarm('ubc-registration-sync');await b.settle();
 assert.equal(b.tabs.length,0);
 assert.ok(Date.now()-Date.parse(b.state.ubcLastSync.at)<60_000,'synced from the open page');
});
test('no reminder when reminders are off, sync is paused, or one is already open',async()=>{
 for(const [state,openTabs] of [
  [connected({ubcLastSync:{at:hoursAgo(500),count:1},ubcRemindAfterHours:0}),[]],
  [connected({ubcLastSync:{at:hoursAgo(500),count:1},ubcAutoSync:false}),[]],
  [connected({ubcLastSync:{at:hoursAgo(500),count:1}}),[{id:5,url:REMINDER}]],
 ]){const b=await boot(state,{openTabs});b.alarm('ubc-registration-sync');await b.settle();assert.equal(b.tabs.length,0);}
});
test('reminder policy: chosen age, snooze, first sync measured from connecting',()=>{
 const now=Date.parse('2026-11-21T12:00:00Z'),at=h=>new Date(now-h*3600_000).toISOString();
 assert.equal(remindHours(undefined),72);assert.equal(remindHours(24),24);assert.equal(remindHours(0),0);assert.equal(remindHours(5),72);
 assert.equal(reminderDue({lastSyncAt:at(71)},now),false);assert.equal(reminderDue({lastSyncAt:at(73)},now),true);
 assert.equal(reminderDue({lastSyncAt:at(25),remindAfterHours:24},now),true);
 assert.equal(reminderDue({lastSyncAt:at(500),remindAfterHours:0},now),false);
 assert.equal(reminderDue({lastSyncAt:at(500),snoozeUntil:now+1},now),false);
 assert.equal(reminderDue({connectedAt:at(80)},now),true);assert.equal(reminderDue({},now),false);
});
