import {hubOrigin,storedConnection} from './connection.js';
import {parseSnapshot} from '../model.js';
import {DEFAULT_HUB,HUB_PAGE_PATH,WORKDAY_ORIGIN,WORKDAY_REGISTRATIONS_URL} from './defaults.js';
import {IGNORED_SNOOZE_MS,reminderDue} from './reminder-policy.js';
declare const browser:typeof chrome;
const api=typeof browser!=='undefined'?browser:chrome;
const token=(v:unknown):v is string=>typeof v==='string'&&/^[\w-]{43}$/.test(v);
type Intent={type:'authorize'|'pair';origin:string;code?:string;at:number};
const INTENT_TTL=5*60_000;
type Authorization={origin:string;state:string;expires:number;tabId?:number;status:'pending'|'connected'|'error';message?:string};
let claiming=false;
const workdayOrigin=WORKDAY_ORIGIN;
const registrationsUrl=WORKDAY_REGISTRATIONS_URL;
/** Every 15 minutes: sync the Workday pages already open, then remind if the data is old. */
const alarmName='ubc-registration-sync';
/** One check shortly after the browser starts. */
const startupAlarm='ubc-startup-sync';
/** A page or startup request skips the sync if the last one is this recent. */
const FRESH_MS=10*60_000;
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
/**
 * Syncs the open Workday pages. Only a sync the person asked for (Sync now, the Hub page, connecting)
 * may open View My Courses in a background tab; background checks never open Workday on their own.
 */
async function syncAll(openWorkday=true){
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
  if(!registrationSynced&&openWorkday){
    const result=await syncRegistrations();
    if(result.ok){readable++;count+=result.count;}
    else lastError=result.error;
  }
  // A readable run counts as a sync even when nothing changed, so "last sync" means last checked.
  if(readable)await api.storage.local.set({ubcLastSync:{at:new Date().toISOString(),count}});
  return {ok:true,tabs:tabs.length,readable,count,error:lastError};
}
/** Spends a pairing code at the Hub and saves the connection; automatic sync starts right away. */
async function claimConnection(origin:string,code:string){
  let r:Response;
  try{r=await fetch(origin+'/ubc/api/claim',{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(15000)});}
  catch{throw new Error('Could not reach your MCPHub. Check your connection and try again.');}
  if(!r.ok){await r.body?.cancel();throw new Error(r.status===400||r.status===401?'That pairing code is invalid, expired or already used. Get a new one on the MCPHub UBC page.':`Connection failed (HTTP ${r.status}). Please try again.`);}
  const body=await r.json();if(!token(body.uploadToken))throw new Error('The connector returned an invalid credential.');
  // Pairing credentials never go to the webpage or to browser sync by default.
  await api.storage.local.set({ubcConnection:{origin,uploadToken:body.uploadToken},ubcConnectedAt:new Date().toISOString(),ubcSnoozeUntil:null,ubcAutoSync:true,ubcSyncError:null,ubcAuthorization:{origin,status:'connected',message:'Connected through MCPHub.'}});
  await api.storage.local.remove('ubcUploadToken');
  void configureAlarm().catch(()=>{});
  // The first sync runs now instead of waiting for the next alarm.
  void syncAll().then(async result=>{if(result.error)await api.storage.local.set({ubcSyncError:result.error});}).catch(()=>{});
}
/** The default Hub's UBC page, in a top-level tab of this browser. */
function bridgePage(sender:chrome.runtime.MessageSender){
  if(sender.id!==api.runtime.id||!sender.tab?.id||!sender.url||(sender.frameId!==undefined&&sender.frameId!==0))return false;
  try{const u=new URL(sender.url);return !!DEFAULT_HUB&&u.origin===DEFAULT_HUB&&u.pathname.startsWith(HUB_PAGE_PATH);}catch{return false;}
}
async function startAuthorization(origin:string){
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
let resuming:Promise<{ok:boolean;error?:string}>|undefined;
/**
 * Finishes what the popup started before the browser asked for site access. Chrome closes the
 * popup while that prompt is open, so the popup saves its request first and the background
 * finishes it once access is granted (from the popup if it survived, or from permissions.onAdded).
 */
function resumeIntent(){
  if(resuming)return resuming;
  resuming=(async()=>{
    const {ubcPendingIntent:i}=await api.storage.local.get('ubcPendingIntent') as {ubcPendingIntent?:Intent};
    if(!i)return {ok:true};
    await api.storage.local.remove('ubcPendingIntent');
    let origin='';
    try{
      if(typeof i.at!=='number'||Date.now()-i.at>INTENT_TTL)throw new Error('That request expired. Try again from the extension.');
      origin=hubOrigin(i.origin);
      if(!await api.permissions.contains({origins:[origin+'/*']}))throw new Error('Allow access to your MCPHub to continue.');
      if(i.type==='authorize')return await startAuthorization(origin);
      if(i.type==='pair'&&token(i.code)){await claimConnection(origin,i.code);return {ok:true};}
      throw new Error('Enter the pairing code shown on the MCPHub UBC page.');
    }catch(e){
      const message=e instanceof Error?e.message:'Connection failed.';
      await api.storage.local.set({ubcAuthorization:{origin,status:'error',message}});
      return {ok:false,error:message};
    }
  })().finally(()=>{resuming=undefined;});
  return resuming;
}
/** A background check (alarm or browser start): sync open Workday pages, then remind if the data is old. */
async function backgroundCheck(){
  const state=await api.storage.local.get(['ubcConnection','ubcAutoSync','ubcLastSync']);
  if(!state.ubcAutoSync||!storedConnection(state))return;
  const last=Date.parse((state.ubcLastSync as {at?:string}|undefined)?.at??'');
  if(!Number.isFinite(last)||Date.now()-last>=FRESH_MS){
    const result=await syncAll(false);
    if(result.error&&result.readable)await api.storage.local.set({ubcSyncError:result.error});
  }
  await maybeRemind();
}
const reminderPage=()=>api.runtime.getURL('reminder.html');
async function closeReminders(){
  const tabs=(await api.tabs.query({url:reminderPage()})).filter(t=>t.id!==undefined&&t.url?.split(/[?#]/)[0]===reminderPage());
  if(tabs.length)await api.tabs.remove(tabs.map(t=>t.id!));
}
/** Opens the reminder page (not Workday) when the data is older than the person's chosen age. */
async function maybeRemind(){
  const s=await api.storage.local.get(['ubcConnection','ubcAutoSync','ubcLastSync','ubcConnectedAt','ubcRemindAfterHours','ubcSnoozeUntil']);
  if(!s.ubcAutoSync||!storedConnection(s))return;
  const now=Date.now();
  if(!reminderDue({lastSyncAt:(s.ubcLastSync as {at?:string}|undefined)?.at??null,connectedAt:(s.ubcConnectedAt as string|undefined)??null,remindAfterHours:s.ubcRemindAfterHours,snoozeUntil:s.ubcSnoozeUntil},now))return;
  if((await api.tabs.query({url:reminderPage()})).length)return;
  // Ignoring the page snoozes it, so it comes back later instead of on every check.
  await api.storage.local.set({ubcSnoozeUntil:now+IGNORED_SNOOZE_MS});
  await api.tabs.create({url:reminderPage()});
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
    await api.storage.local.set({ubcLastSync:{at:new Date().toISOString(),count},ubcSyncError:null,ubcSnoozeUntil:null});
    // The data is fresh again: an open reminder has done its job.
    void closeReminders().catch(()=>{});
    return {ok:true,count};
  }
  if(message.type==='ubc.sync.all'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Sync request refused.');
    return syncAll();
  }
  if(message.type==='ubc.authorize.start'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Request refused.');
    return startAuthorization(hubOrigin(message.origin??''));
  }
  if(message.type==='ubc.intent.resume'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Request refused.');
    return resumeIntent();
  }
  if(message.type==='ubc.pair.manual'){
    if(sender.tab||sender.id!==api.runtime.id)throw new Error('Request refused.');
    const origin=hubOrigin(message.origin??'');
    if(!token(message.code))throw new Error('Enter the pairing code shown on the MCPHub UBC page.');
    if(!await api.permissions.contains({origins:[origin+'/*']}))throw new Error('Allow access to your MCPHub to continue.');
    if(claiming)throw new Error('Connection is already in progress.');
    claiming=true;
    try{await claimConnection(origin,message.code);return {ok:true};}finally{claiming=false;}
  }
  if(message.type==='ubc.bridge.status'){
    if(!bridgePage(sender))throw new Error('Request refused.');
    const state=await api.storage.local.get(['ubcConnection','ubcAutoSync','ubcLastSync','ubcSyncError']);
    const connection=storedConnection(state);
    return {ok:true,connected:!!connection&&connection.origin===DEFAULT_HUB,autoSync:!!state.ubcAutoSync,lastSyncAt:(state.ubcLastSync as {at?:string}|undefined)?.at??null,syncError:state.ubcSyncError??null};
  }
  if(message.type==='ubc.bridge.sync'){
    if(!bridgePage(sender))throw new Error('Request refused.');
    const connection=storedConnection(await api.storage.local.get(['ubcConnection']));
    if(!connection||connection.origin!==DEFAULT_HUB)throw new Error('Connect this browser first.');
    // The page's own request turns sync back on: it is an explicit "sync now".
    await api.storage.local.set({ubcAutoSync:true});
    const result=await syncAll();
    await api.storage.local.set({ubcSyncError:result.error||null});
    return {ok:!!result.readable,count:result.count,error:result.error||(result.readable?'':'Could not read Workday. Sign in to Workday in this browser and try again.')};
  }
  if(message.type==='ubc.bridge.claim'){
    if(!bridgePage(sender))throw new Error('Request refused.');
    if(!token(message.code))throw new Error('The page sent an invalid pairing code. Reload it and try again.');
    if(claiming)throw new Error('Connection is already in progress.');
    claiming=true;
    try{await claimConnection(DEFAULT_HUB,message.code);return {ok:true};}
    catch(e){await api.storage.local.set({ubcAuthorization:{origin:DEFAULT_HUB,status:'error',message:e instanceof Error?e.message:'Connection failed.'}});throw e;}
    finally{claiming=false;}
  }
  if(message.type==='ubc.authorize.claim'){
    const {ubcAuthorization:a}=await api.storage.local.get('ubcAuthorization') as {ubcAuthorization?:Authorization};
    if(!a||a.status!=='pending'||a.expires<Date.now()||claiming||sender.id!==api.runtime.id||sender.tab?.id!==a.tabId||!sender.url)throw new Error('Authorization expired. Start again from the extension.');
    const u=new URL(sender.url);
    if(u.origin!==a.origin||u.pathname!=='/ubc/'||message.state!==a.state||!token(message.code))throw new Error('Authorization does not match this browser.');
    claiming=true;
    try{await claimConnection(a.origin,message.code);return {ok:true};}
    catch(e){await api.storage.local.set({ubcAuthorization:{origin:a.origin,status:'error',message:e instanceof Error?e.message:'Connection failed.'}});throw e;}
    finally{claiming=false;}
  }
  throw new Error('Unknown request.');
}
api.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!['ubc.authorize.start','ubc.authorize.claim','ubc.intent.resume','ubc.pair.manual','ubc.bridge.status','ubc.bridge.claim','ubc.bridge.sync','ubc.sync.enabled','ubc.sync.stop','ubc.sync.configure','ubc.sync.snapshots','ubc.sync.all'].includes(message?.type))return false;
  void handle(message,sender).then(sendResponse,e=>{
    const error=e instanceof Error?e.message:'Connection failed.';
    if(message.type==='ubc.sync.snapshots'&&sender.id===api.runtime.id&&sender.url?.startsWith(workdayOrigin))void api.storage.local.set({ubcSyncError:error});
    sendResponse({ok:false,error});
  });return true;
});
api.tabs.onUpdated.addListener((id,change,tab)=>{if(change.status==='complete'&&tab.url){void inject(id,tab.url).catch(()=>{});if(tab.url.startsWith(workdayOrigin))void injectWorkday(id,tab.url).catch(()=>{});}});
api.runtime.onStartup?.addListener(()=>{void workdayTabs().then(tabs=>Promise.all(tabs.map(t=>t.id&&t.url?injectWorkday(t.id,t.url):false))).catch(()=>{});});
api.runtime.onStartup?.addListener(()=>{void configureAlarm().catch(()=>{});void api.alarms?.create(startupAlarm,{delayInMinutes:1});});
api.runtime.onInstalled?.addListener(details=>{
  void configureAlarm().catch(()=>{});
  // A new installation opens the Hub's UBC page, where one click connects this browser.
  if(details?.reason==='install'&&DEFAULT_HUB)void api.tabs.create({url:DEFAULT_HUB+HUB_PAGE_PATH}).catch(()=>{});
});
api.permissions?.onAdded?.addListener(()=>{void resumeIntent().catch(()=>{});});
api.alarms?.onAlarm.addListener(alarm=>{
  if(alarm.name!==startupAlarm&&alarm.name!==alarmName)return;
  void backgroundCheck().catch(()=>{});
});
void configureAlarm().catch(()=>{});
void Promise.resolve().then(()=>api.storage.local.remove('ubcProbe')).catch(()=>{});
if(typeof api.storage.local.setAccessLevel==='function')void api.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
