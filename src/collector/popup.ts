import {parseSnapshot,type Snapshot} from '../model.js';
import {hubOrigin,storedConnection} from './connection.js';
import {extractWorkdayDom} from './dom.js';
import {normalizeCapture} from './normalize.js';
import {extractRegistrationDom,normalizeRegistrations} from './registrations.js';
import {HUB_PAGE_PATH} from './defaults.js';
import {remindHours} from './reminder-policy.js';
import {currentLang,localizeDocument,t} from './i18n.js';
declare const browser:typeof chrome;
const extensionApi=typeof browser!=='undefined'?browser:chrome;
const el=(id:string)=>document.getElementById(id)!;
localizeDocument(document);
const status=el('status');
let pending:Snapshot[]=[],busy=false,paired=false,autoSync=false;
function feedback(message:string,state:'loading'|'success'|'error'|'info'='info') {
  status.textContent=message;status.dataset.state=state;
}
function controls() {
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=busy||(b.id==='upload'&&(!paired||!pending.length))||(b.id==='sync-all'&&(!paired||!autoSync))||(b.id==='auto-toggle'&&!paired));
  document.querySelectorAll<HTMLInputElement>('input').forEach(i=>i.disabled=busy);
  el('upload-hint').textContent=!paired?t('Connect your account before uploading.'):pending.length?t('{count} period(s) ready. Review the preview before uploading.',{count:pending.length}):t('Preview a Workday page or import a file to enable upload.');
}
function errorMessage(e:unknown) {
  if(e instanceof Error&&['TimeoutError','AbortError'].includes(e.name))return t('The request timed out. Check your connection and try again.');
  if(e instanceof TypeError)return t('Could not reach the sync service. Check your connection and try again.');
  return e instanceof Error?e.message:t('Something went wrong. Please try again.');
}
async function action(id:string,label:string,work:()=>Promise<void>) {
  if(busy)return;
  busy=true;controls();document.body.setAttribute('aria-busy','true');
  const button=el(id),original=button.textContent;
  if(button.tagName==='BUTTON'){button.textContent=label;button.setAttribute('aria-busy','true');}
  feedback(label,'loading');
  let completed=false;
  try{await work();completed=true;}catch(e){feedback(errorMessage(e),'error');}
  finally{busy=false;document.body.setAttribute('aria-busy','false');if(button.tagName==='BUTTON'){if(id!=='auto-toggle'||!completed)button.textContent=original;button.removeAttribute('aria-busy');}controls();}
}
async function showConnection() {
  const x=await extensionApi.storage.local.get(['ubcConnection','ubcHubOrigin','ubcAuthorization','ubcAutoSync','ubcLastSync','ubcSyncError','ubcRemindAfterHours']) as Record<string,any>;
  // Mark the option rather than set select.value, which not every DOM implements.
  const chosen=String(remindHours(x.ubcRemindAfterHours));
  document.querySelectorAll<HTMLOptionElement>('#remind-after option').forEach(o=>{if(o.value===chosen)o.setAttribute('selected','');else o.removeAttribute('selected');});const connection=storedConnection(x);paired=!!connection;
  autoSync=!!x.ubcAutoSync;
  el('connection').textContent=connection?`Connected · ${connection.origin}`:t('Not connected yet.');
  el('connect-setup').hidden=paired;el('connected-actions').hidden=!paired;
  el('auto-status').textContent=!paired?t('Connect to MCPHub to sync.'):x.ubcSyncError?t('Sync issue: {error}',{error:x.ubcSyncError}):x.ubcAutoSync?(x.ubcLastSync?.at?t('Automatic sync is on. Last sync: {time}.',{time:new Date(x.ubcLastSync.at).toLocaleString(currentLang()==='zh'?'zh-CN':'en')}):t('Automatic sync is on.')):t('Enable automatic sync with the button below.');
  el('auto-toggle').textContent=x.ubcAutoSync?t('Pause automatic sync'):t('Enable automatic sync');
  return x;
}
// Credentials stay in trusted extension-local storage, never page or sync storage.
busy=true;controls();
async function initialize(){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    let data:Record<string,any>={};
    const setup=async()=>{
      // Firefox has no setAccessLevel. The only content script is the Hub page bridge, which never reads storage.
      if(typeof extensionApi.storage.local.setAccessLevel==='function')await extensionApi.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
      data=await showConnection();(el('hub-origin') as HTMLInputElement).value=data.ubcHubOrigin??'';
    };
    await Promise.race([setup(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(t('Could not read the local connection. Reopen the extension or reload it, then try again.'))),8000);})]);
    // A request the popup could not finish (it closes while the browser asks for access) reports here.
    const a=data.ubcAuthorization;
    if(!paired&&a?.status==='error'&&a.message)feedback(a.message,'error');
    else feedback(paired?t('Connected. Workday sync is ready.'):t('Ready. Open MCPHub and click “Connect this browser”.'));
  }catch(e){el('connection').textContent=t('Local connection could not be checked.');feedback(errorMessage(e),'error');}
  finally{if(timer)clearTimeout(timer);busy=false;controls();}
}
void initialize();
el('forget').onclick=()=>action('forget',t('Removing local connection…'),async()=>{
  await extensionApi.storage.local.remove(['ubcUploadToken','ubcConnection','ubcAuthorization','ubcAutoSync','ubcLastSync','ubcSyncError','ubcConnectedAt','ubcSnoozeUntil']);pending=[];el('preview').textContent='';await showConnection();
  try{await extensionApi.runtime.sendMessage({type:'ubc.sync.stop'});}catch{/* The local connection is already removed. */}
  feedback(t('Local connection removed. To revoke server access and delete snapshots, use the connection page.'),'success');
});
async function capture(kind:'sections'|'registrations'):Promise<Snapshot[]> {
  const [tab]=await extensionApi.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!/^https:\/\/wd10\.myworkday\.com\/ubc\//.test(tab.url??''))throw new Error(kind==='sections'?t('Open UBC Workday Find Course Sections, refresh the results, then try again.'):t('Open UBC Workday View My Courses, then try again.'));
  if(kind==='sections') {
    const [r]=await extensionApi.scripting.executeScript({target:{tabId:tab.id},func:extractWorkdayDom});
    if(!r?.result)throw new Error(t('No course data returned. Refresh the Workday page and try again.'));return [normalizeCapture(r.result)];
  }
  const [r]=await extensionApi.scripting.executeScript({target:{tabId:tab.id},func:extractRegistrationDom});
  if(!r?.result)throw new Error(t('No registrations returned. Refresh View My Courses and try again.'));return normalizeRegistrations(r.result);
}
function clearPreview(){pending=[];el('preview').textContent='';}
function showPreview() {
  el('preview').textContent=pending.map(s=>`${s.campus} ${s.academicPeriod.id} · ${s.kind}\n${s.sections.length} sections · ${s.capturedAt}\n`+s.sections.map(c=>`${c.subject} ${c.course} ${c.code}`).join('\n')).join('\n\n');
  feedback(t('Preview ready: {periods} period(s), {sections} section(s).',{periods:pending.length,sections:pending.reduce((n,s)=>n+s.sections.length,0)})+' '+(paired?t('Review below, then click Upload.'):t('Connect your account before uploading.')),'success');
}
for(const [id,kind]of [['preview-sections','sections'],['preview-registrations','registrations']]as const)
  el(id).onclick=()=>action(id,kind==='sections'?t('Reading course sections…'):t('Reading your registrations…'),async()=>{clearPreview();pending=await capture(kind);showPreview();});
el('snapshot-file').onchange=()=>action('snapshot-file',t('Reading and validating your file…'),async()=>{
  const input=el('snapshot-file') as HTMLInputElement;clearPreview();
  try{
    const file=input.files?.[0];if(!file){feedback(t('No file selected.'));return;}
    if(file.size>4_000_000)throw new Error(t('Snapshot file must be at most 4 MB.'));
    let data:unknown;try{data=JSON.parse(await file.text());}catch{throw new Error(t('This file is not valid JSON. Choose an exported UBC snapshot.'));}
    const items=Array.isArray(data)?data:[data];if(!items.length||items.length>20)throw new Error(t('Choose a file with 1–20 snapshots.'));
    try{pending=items.map(s=>parseSnapshot(s));}catch{throw new Error(t('This is not a supported UBC snapshot. Export it again using the extension.'));}showPreview();
  }finally{input.value='';}
});
el('upload').onclick=()=>action('upload',t('Preparing upload…'),async()=>{
  const connection=storedConnection(await extensionApi.storage.local.get(['ubcConnection']));
  if(!connection)throw new Error(t('Connect the extension first.'));if(!pending.length)throw new Error(t('Preview data first.'));
  const {uploadToken:ubcUploadToken,origin:uploadOrigin}=connection;
  let completed=0;const total=pending.length;
  while(pending.length){
    feedback(t('Uploading period {n} of {total}… Keep this popup open until it finishes.',{n:completed+1,total}),'loading');
    el('upload').textContent=t('Uploading {n} of {total}…',{n:completed+1,total});
    const r=await fetch(uploadOrigin+'/v1/snapshots',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${ubcUploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(pending[0]),signal:AbortSignal.timeout(20_000)});
    if(!r.ok){await r.body?.cancel();if(r.status===401){await extensionApi.storage.local.remove(['ubcUploadToken','ubcConnection']);await showConnection();throw new Error(t('Your connection was revoked. Connect again with MCPHub.'));}throw new Error(t('Upload stopped after {done} of {total} periods (HTTP {status}). Refresh Workday and preview again.',{done:completed,total,status:r.status}));}
    await r.body?.cancel();pending.shift();completed++;
  }
  feedback(t('Synced {count} period(s).',{count:completed})+(autoSync?' '+t('Automatic sync keeps them up to date while Workday is open.'):''),'success');
});
for(const [id,kind]of [['capture','sections'],['registrations','registrations']]as const)
  el(id).onclick=()=>action(id,t('Preparing your export…'),async()=>{
    const snapshots=await capture(kind),first=snapshots[0]!;
    const url=URL.createObjectURL(new Blob([JSON.stringify(kind==='sections'?first:snapshots,null,2)],{type:'application/json'}));
    try{feedback(t('Choose where to save the export…'),'loading');await extensionApi.downloads.download({url,filename:kind==='sections'?`ubc-${first.campus}-${first.academicPeriod.id}.json`:'ubc-private-registrations.json',saveAs:true});}
    finally{URL.revokeObjectURL(url);}
    feedback(t('Export saved. Keep registration files private. You can import this file later to preview and sync it.'),'success');
  });

// Opened on an MCPHub's UBC page: offer that Hub, so nothing has to be typed.
let pageHub:{origin:string;tabId:number}|null=null;
async function detectPageHub(){
  try{
    const [tab]=await extensionApi.tabs.query({active:true,currentWindow:true});
    const u=new URL(tab?.url??'');
    if(tab?.id===undefined||u.protocol!=='https:'||!u.pathname.startsWith(HUB_PAGE_PATH))return;
    pageHub={origin:u.origin,tabId:tab.id};
    el('page-actions').hidden=false;(el('manual-connect') as HTMLDetailsElement).open=false;
    el('connect-page').textContent=t('Connect to {host}',{host:u.host});
    el('connect-hint').textContent=t('You are on the UBC page of {host}. Allow access once, and the page finishes connecting.',{host:u.host});
  }catch{/* Not a page the popup can read. */}
}
void detectPageHub();
el('connect-page').onclick=()=>action('connect-page','Connecting…',async()=>{
  if(!pageHub)throw new Error(t('Enter your MCPHub address below.'));
  await withHubAccess({type:'page',origin:pageHub.origin,tabId:pageHub.tabId});
  feedback(t('Finish on the MCPHub page; it connects this browser by itself. This popup can be closed.'),'success');
});
/**
 * Asks for access to another Hub and then finishes the request. The request is saved first:
 * Chrome closes this popup while its access prompt is open, and the background then finishes it.
 */
async function withHubAccess(intent:{type:'authorize'|'pair'|'page';origin:string;code?:string;tabId?:number}){
  void extensionApi.storage.local.set({ubcPendingIntent:{...intent,at:Date.now()},ubcAuthorization:null});
  // The permission request must stay the first await of the click.
  // UBC Workday is asked for in the same prompt: nothing is granted at install.
  if(!await extensionApi.permissions.request({origins:[intent.origin+'/*','https://wd10.myworkday.com/*']})){
    await extensionApi.storage.local.remove('ubcPendingIntent');
    throw new Error(t('Allow access to your MCPHub to continue.'));
  }
  const response=await extensionApi.runtime.sendMessage({type:'ubc.intent.resume'});
  if(!response?.ok)throw new Error(response?.error??t('Could not connect to your MCPHub.'));
}
el('hub-login').onclick=()=>action('hub-login',t('Opening your MCPHub…'),async()=>{
  const selected=hubOrigin((el('hub-origin') as HTMLInputElement).value);
  await withHubAccess({type:'authorize',origin:selected});
  feedback(t('Continue in the MCPHub tab. This popup can be closed.'));
});
el('pair').onclick=()=>action('pair','Connecting…',async()=>{
  const selected=hubOrigin((el('hub-origin') as HTMLInputElement).value);
  const code=(el('pair-code') as HTMLInputElement).value.trim();
  if(!/^[\w-]{43}$/.test(code))throw new Error(t('Enter the pairing code shown on the MCPHub UBC page.'));
  await withHubAccess({type:'pair',origin:selected,code});
  (el('pair-code') as HTMLInputElement).value='';
  await showConnection();feedback(t('Connected. Your first Workday sync has started.'),'success');
});
el('sync-all').onclick=()=>action('sync-all',t('Syncing open Workday pages…'),async()=>{
  if(!paired)throw new Error(t('Connect to MCPHub first.'));
  if(!await extensionApi.permissions.request({origins:['https://wd10.myworkday.com/*']}))throw new Error(t('Allow UBC Workday access to enable automatic sync.'));
  await extensionApi.storage.local.set({ubcAutoSync:true});
  const result=await extensionApi.runtime.sendMessage({type:'ubc.sync.all'});
  if(!result?.ok)throw new Error(result?.error??t('Could not sync Workday.'));
  await showConnection();
  if(result.error&&result.readable){feedback(`Synced ${result.count} snapshot(s), but another page failed: ${result.error}`,'error');return;}
  if(result.error)throw new Error(result.error);
  if(!result.readable)throw new Error(t('Could not sync Workday. Sign in to Workday and try again.'));
  feedback(t('Synced {count} Workday snapshot(s).',{count:result.count}),'success');
});
el('auto-toggle').onclick=()=>action('auto-toggle',t('Updating automatic sync…'),async()=>{
  const previous=autoSync;
  if(!previous&&!await extensionApi.permissions.request({origins:['https://wd10.myworkday.com/*']}))throw new Error(t('Allow UBC Workday access to enable automatic sync.'));
  await extensionApi.storage.local.set({ubcAutoSync:!previous,ubcSyncError:null});
  const response=await extensionApi.runtime.sendMessage({type:'ubc.sync.configure'});
  if(!response?.ok)throw new Error(response?.error??t('Could not update automatic sync.'));
  await showConnection();feedback(previous?t('Automatic sync paused.'):t('Automatic sync enabled.'),'success');
});
if(extensionApi.storage.onChanged)extensionApi.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!('ubcAuthorization'in changes||'ubcConnection'in changes||'ubcLastSync'in changes||'ubcAutoSync'in changes||'ubcSyncError'in changes))return;
  void showConnection().then(data=>{
    const a=data.ubcAuthorization;
    if(a?.status==='connected')feedback(t('Connected through MCPHub. Your connection is saved for future syncs.'),'success');
    else if(a?.status==='error')feedback(a.message??t('Connection failed. Try again.'),'error');
    controls();
  }).catch(()=>feedback(t('Could not read your connection. Reopen the popup.'),'error'));
});
const remindSelect=document.getElementById('remind-after') as HTMLSelectElement|null;
if(remindSelect)remindSelect.onchange=()=>action('remind-after','Saving…',async()=>{
  const hours=remindHours(Number(remindSelect.value));
  await extensionApi.storage.local.set({ubcRemindAfterHours:hours,ubcSnoozeUntil:null});
  feedback(hours?t('Reminder saved.'):t('Reminders are off.'),'success');
});
