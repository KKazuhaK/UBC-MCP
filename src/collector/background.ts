import {hubOrigin,storedConnection} from './connection.js';
import {parseSnapshot} from '../model.js';
declare const browser:typeof chrome;
const api=typeof browser!=='undefined'?browser:chrome;
const token=(v:unknown):v is string=>typeof v==='string'&&/^[\w-]{43}$/.test(v);
type Authorization={origin:string;state:string;expires:number;tabId?:number;status:'pending'|'connected'|'error';message?:string};
let claiming=false;
const workdayOrigin='https://wd10.myworkday.com/ubc/';
// The UBC tenant's observed read-only View My Courses task.
const registrationsUrl=workdayOrigin+'d/task/2998$28771.htmld';
const alarmName='ubc-registration-sync';
let registrationRun:Promise<{ok:boolean;count:number;error:string}>|undefined;
async function injectWorkday(id:number,url:string){
  const state=await api.storage.local.get(['ubcConnection','ubcUploadToken','ubcAutoSync']);
  if(!state.ubcAutoSync||!storedConnection(state)||!url.startsWith(workdayOrigin))return false;
  if(!await api.permissions.contains({origins:['https://wd10.myworkday.com/*']}))return false;
  await api.scripting.executeScript({target:{tabId:id},files:['auto-sync.js']});return true;
}
async function workdayTabs(){
  return api.tabs.query({url:'https://wd10.myworkday.com/ubc/*'});
}
async function configureAlarm(){
  const state=await api.storage.local.get(['ubcConnection','ubcUploadToken','ubcAutoSync']);
  if(!api.alarms)return;
  if(state.ubcAutoSync&&storedConnection(state)){
    if(!await api.alarms.get(alarmName))await api.alarms.create(alarmName,{delayInMinutes:1,periodInMinutes:15});
  }
  else await api.alarms.clear(alarmName);
}
function syncRegistrations(){
  if(registrationRun)return registrationRun;
  registrationRun=(async()=>{
    let tabId:number|undefined;let lastError='Sign in to UBC Workday and try again.';
    try{
      const state=await api.storage.local.get(['ubcConnection','ubcUploadToken','ubcAutoSync']);
      if(!state.ubcAutoSync||!storedConnection(state)||!await api.permissions.contains({origins:['https://wd10.myworkday.com/*']}))return {ok:false,count:0,error:'Connect and allow Workday access first.'};
      const tab=await api.tabs.create({url:registrationsUrl,active:false});tabId=tab.id;
      if(!tabId)throw new Error('Could not open Workday.');
      for(let attempt=0;attempt<20;attempt++){
        await new Promise(resolve=>setTimeout(resolve,1000));
        const current=await api.tabs.get(tabId);
        if(current.status!=='complete'||!current.url?.startsWith(workdayOrigin))continue;
        try{
          if(!await injectWorkday(tabId,current.url))break;
          const result=await api.tabs.sendMessage(tabId,{type:'ubc.sync.now'});
          if(result?.ok&&result.kinds?.includes('registrations'))return {ok:true,count:result.count??0,error:''};
          if(result?.error&&!result.error.startsWith('No complete supported'))lastError=result.error;
        }catch{/* Workday may still be rendering. */}
      }
      return {ok:false,count:0,error:lastError};
    }catch{return {ok:false,count:0,error:'Could not open the Workday registration page.'};}
    finally{
      if(tabId)try{const tab=await api.tabs.get(tabId);if(!tab.active)await api.tabs.remove(tabId);}catch{/* The tab was already closed. */}
    }
  })().finally(()=>{registrationRun=undefined;});
  return registrationRun;
}
async function inject(tabId:number,url:string){
  const {ubcAuthorization:a}=await api.storage.local.get('ubcAuthorization') as {ubcAuthorization?:Authorization};
  if(!a||a.status!=='pending'||a.tabId!==tabId||a.expires<Date.now())return;
  const u=new URL(url);
  if(u.origin!==a.origin||u.pathname!=='/ubc/'||u.hash!==`#extension-auth=${a.state}`)return;
  await api.scripting.executeScript({target:{tabId},files:['hub-link.js']});
}
async function handle(message:any,sender:chrome.runtime.MessageSender){
  if(message.type==='ubc.sync.enabled'){
    if(sender.id!==api.runtime.id||!sender.tab?.id||!sender.url?.startsWith(workdayOrigin))throw new Error('Workday sync request refused.');
    const state=await api.storage.local.get(['ubcConnection','ubcUploadToken','ubcAutoSync']);
    return {ok:true,enabled:!!state.ubcAutoSync&&!!storedConnection(state)};
  }
  if(message.type==='ubc.sync.stop'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Sync request refused.');
    if(api.alarms)await api.alarms.clear(alarmName);
    return {ok:true};
  }
  if(message.type==='ubc.sync.configure'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Sync request refused.');
    await configureAlarm();return {ok:true};
  }
  if(message.type==='ubc.sync.snapshots'){
    if(sender.id!==api.runtime.id||!sender.tab?.id||!sender.url?.startsWith(workdayOrigin))throw new Error('Workday sync request refused.');
    const state=await api.storage.local.get(['ubcConnection','ubcUploadToken','ubcAutoSync']);
    const connection=storedConnection(state);
    if(!connection||!state.ubcAutoSync)throw new Error('Connect and enable Workday sync first.');
    if(!Array.isArray(message.snapshots)||!message.snapshots.length||message.snapshots.length>20)throw new Error('Invalid snapshot batch.');
    const snapshots=message.snapshots.map((s:unknown)=>parseSnapshot(s));
    let count=0;
    for(const snapshot of snapshots){
      const r=await fetch(connection.origin+'/v1/snapshots',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${connection.uploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(20000)});
      await r.body?.cancel();
      if(!r.ok)throw new Error(r.status===401?'Connection expired or revoked. Reconnect to MCPHub.':`Sync failed (HTTP ${r.status}).`);
      count++;
    }
    await api.storage.local.set({ubcLastSync:{at:new Date().toISOString(),count},ubcSyncError:null});
    return {ok:true,count};
  }
  if(message.type==='ubc.sync.all'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Sync request refused.');
    await configureAlarm();
    const tabs=await workdayTabs();let count=0,readable=0,lastError='',registrationSynced=false;
    for(const tab of tabs){
      if(!tab.id||!tab.url)continue;
      try{
        if(!await injectWorkday(tab.id,tab.url)){lastError='Automatic sync could not access Workday. Check the extension’s Workday site permission.';continue;}
        const result=await api.tabs.sendMessage(tab.id,{type:'ubc.sync.now'});
        if(result?.ok){readable++;count+=result.count??0;registrationSynced||=!!result.kinds?.includes('registrations');}
        else if(result?.error&&!result.error.startsWith('No complete supported'))lastError=result.error;
      }catch{lastError='Could not access an open Workday tab. Check Workday site permission and reload that page.';}
    }
    if(!registrationSynced){
      const result=await syncRegistrations();
      if(result.ok){readable++;count+=result.count;}
      else lastError=result.error;
    }
    return {ok:true,tabs:tabs.length,readable,count,error:lastError};
  }
  if(message.type==='ubc.authorize.start'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Request refused.');
    const origin=hubOrigin(message.origin??'');
    let capability:Response;
    try{capability=await fetch(origin+'/ubc/capabilities',{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)});}catch{throw new Error('Could not reach the UBC connector at this MCPHub address. Check the address and your connection.');}
    let info:any;try{info=await capability.json();}catch{info=null;}
    if(!capability.ok||info?.extensionAuthorization!==1)throw new Error('This server needs an updated UBC connector to connect through MCPHub.');
    const a:Authorization={origin,state:Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''),expires:Date.now()+10*60_000,status:'pending'};
    await api.storage.local.set({ubcAuthorization:a,ubcHubOrigin:origin});
    const tab=await api.tabs.create({url:origin+'/ubc/#extension-auth='+a.state});
    if(!tab.id)throw new Error('Could not open the MCPHub connection page.');
    a.tabId=tab.id;await api.storage.local.set({ubcAuthorization:a});
    // Handles cached pages that finish loading before onUpdated can see tabId.
    const current=await api.tabs.get(tab.id);if(current.status==='complete'&&current.url)await inject(tab.id,current.url);
    return {ok:true};
  }
  if(message.type==='ubc.authorize.claim'){
    const {ubcAuthorization:a}=await api.storage.local.get('ubcAuthorization') as {ubcAuthorization?:Authorization};
    if(!a||a.status!=='pending'||a.expires<Date.now()||claiming||sender.id!==api.runtime.id||sender.tab?.id!==a.tabId||!sender.url)throw new Error('Authorization expired. Start again from the extension.');
    const u=new URL(sender.url);
    if(u.origin!==a.origin||u.pathname!=='/ubc/'||message.state!==a.state||!token(message.code))throw new Error('Authorization does not match this browser.');
    claiming=true;
    try{
      const r=await fetch(a.origin+'/ubc/api/claim',{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:message.code}),signal:AbortSignal.timeout(15000)});
      if(!r.ok){await r.body?.cancel();throw new Error(`Connection failed (HTTP ${r.status}). Please start again from the extension.`);}
      const body=await r.json();if(!token(body.uploadToken))throw new Error('The connector returned an invalid credential.');
      // Pairing credentials never go to the webpage or to browser sync by default.
      await api.storage.local.set({ubcConnection:{origin:a.origin,uploadToken:body.uploadToken},ubcAuthorization:{origin:a.origin,status:'connected',message:'Connected through MCPHub.'}});
      void configureAlarm().catch(()=>{});
      void workdayTabs().then(tabs=>Promise.all(tabs.map(t=>t.id&&t.url?injectWorkday(t.id,t.url):false))).catch(()=>{});
      await api.storage.local.remove('ubcUploadToken');return {ok:true};
    }catch(e){await api.storage.local.set({ubcAuthorization:{origin:a.origin,status:'error',message:e instanceof Error?e.message:'Connection failed.'}});throw e;}
    finally{claiming=false;}
  }
  throw new Error('Unknown request.');
}
api.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!['ubc.authorize.start','ubc.authorize.claim','ubc.sync.enabled','ubc.sync.stop','ubc.sync.configure','ubc.sync.snapshots','ubc.sync.all'].includes(message?.type))return false;
  void handle(message,sender).then(sendResponse,e=>{
    const error=e instanceof Error?e.message:'Connection failed.';
    if(message.type==='ubc.sync.snapshots'&&sender.id===api.runtime.id&&sender.url?.startsWith(workdayOrigin))void api.storage.local.set({ubcSyncError:error});
    sendResponse({ok:false,error});
  });return true;
});
api.tabs.onUpdated.addListener((id,change,tab)=>{if(change.status==='complete'&&tab.url){void inject(id,tab.url).catch(()=>{});if(tab.url.startsWith(workdayOrigin))void injectWorkday(id,tab.url).catch(()=>{});}});
api.runtime.onStartup?.addListener(()=>{void workdayTabs().then(tabs=>Promise.all(tabs.map(t=>t.id&&t.url?injectWorkday(t.id,t.url):false))).catch(()=>{});});
api.runtime.onStartup?.addListener(()=>{void configureAlarm().catch(()=>{});});
api.runtime.onInstalled?.addListener(()=>{void configureAlarm().catch(()=>{});});
api.alarms?.onAlarm.addListener(alarm=>{
  if(alarm.name!==alarmName)return;
  void syncRegistrations().then(async result=>{if(!result.ok)await api.storage.local.set({ubcSyncError:result.error});}).catch(()=>{});
});
void configureAlarm().catch(()=>{});
void Promise.resolve().then(()=>api.storage.local.remove('ubcProbe')).catch(()=>{});
if(typeof api.storage.local.setAccessLevel==='function')void api.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
