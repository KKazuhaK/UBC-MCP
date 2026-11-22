import {parseSnapshot,type Snapshot} from '../model.js';
import {hubOrigin,storedConnection} from './connection.js';
import {extractWorkdayDom} from './dom.js';
import {normalizeCapture} from './normalize.js';
import {extractRegistrationDom,normalizeRegistrations} from './registrations.js';
import {DEFAULT_HUB,HUB_PAGE_PATH} from './defaults.js';
import {remindHours} from './reminder-policy.js';
declare const browser:typeof chrome;
const extensionApi=typeof browser!=='undefined'?browser:chrome;
const el=(id:string)=>document.getElementById(id)!;
const status=el('status');
let pending:Snapshot[]=[],busy=false,paired=false,autoSync=false;
function feedback(message:string,state:'loading'|'success'|'error'|'info'='info') {
  status.textContent=message;status.dataset.state=state;
}
function controls() {
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=busy||(b.id==='upload'&&(!paired||!pending.length))||(b.id==='sync-all'&&(!paired||!autoSync))||(b.id==='auto-toggle'&&!paired));
  document.querySelectorAll<HTMLInputElement>('input').forEach(i=>i.disabled=busy);
  el('upload-hint').textContent=!paired?'Connect your account before uploading.':pending.length?`${pending.length} period(s) ready. Review the preview before uploading.`:'Preview a Workday page or import a file to enable upload.';
}
function errorMessage(e:unknown) {
  if(e instanceof Error&&['TimeoutError','AbortError'].includes(e.name))return 'The request timed out. Check your connection and try again.';
  if(e instanceof TypeError)return 'Could not reach the sync service. Check your connection and try again.';
  return e instanceof Error?e.message:'Something went wrong. Please try again.';
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
  el('connection').textContent=connection?`Connected · ${connection.origin}`:'Not connected yet.';
  el('connect-setup').hidden=paired;el('connected-actions').hidden=!paired;
  el('auto-status').textContent=!paired?'Connect to MCPHub to sync.':x.ubcSyncError?`Sync issue: ${x.ubcSyncError}`:x.ubcAutoSync?`Automatic sync is on.${x.ubcLastSync?.at?' Last sync: '+new Date(x.ubcLastSync.at).toLocaleString()+'.':''}`:'Enable automatic sync with the button below.';
  el('auto-toggle').textContent=x.ubcAutoSync?'Pause automatic sync':'Enable automatic sync';
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
    await Promise.race([setup(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Could not read the local connection. Reopen the extension or reload it, then try again.')),8000);})]);
    // A request the popup could not finish (it closes while the browser asks for access) reports here.
    const a=data.ubcAuthorization;
    if(!paired&&a?.status==='error'&&a.message)feedback(a.message,'error');
    else feedback(paired?'Connected. Workday sync is ready.':'Ready. Open MCPHub and click “Connect this browser”.');
  }catch(e){el('connection').textContent='Local connection could not be checked.';feedback(errorMessage(e),'error');}
  finally{if(timer)clearTimeout(timer);busy=false;controls();}
}
void initialize();
el('forget').onclick=()=>action('forget','Removing local connection…',async()=>{
  await extensionApi.storage.local.remove(['ubcUploadToken','ubcConnection','ubcAuthorization','ubcAutoSync','ubcLastSync','ubcSyncError','ubcConnectedAt','ubcSnoozeUntil']);pending=[];el('preview').textContent='';await showConnection();
  try{await extensionApi.runtime.sendMessage({type:'ubc.sync.stop'});}catch{/* The local connection is already removed. */}
  feedback('Local connection removed. To revoke server access and delete snapshots, use the connection page.','success');
});
async function capture(kind:'sections'|'registrations'):Promise<Snapshot[]> {
  const [tab]=await extensionApi.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!/^https:\/\/wd10\.myworkday\.com\/ubc\//.test(tab.url??''))throw new Error(kind==='sections'?'Open UBC Workday Find Course Sections, refresh the results, then try again.':'Open UBC Workday View My Courses, then try again.');
  if(kind==='sections') {
    const [r]=await extensionApi.scripting.executeScript({target:{tabId:tab.id},func:extractWorkdayDom});
    if(!r?.result)throw new Error('No course data returned. Refresh the Workday page and try again.');return [normalizeCapture(r.result)];
  }
  const [r]=await extensionApi.scripting.executeScript({target:{tabId:tab.id},func:extractRegistrationDom});
  if(!r?.result)throw new Error('No registrations returned. Refresh View My Courses and try again.');return normalizeRegistrations(r.result);
}
function clearPreview(){pending=[];el('preview').textContent='';}
function showPreview() {
  el('preview').textContent=pending.map(s=>`${s.campus} ${s.academicPeriod.id} · ${s.kind}\n${s.sections.length} sections · ${s.capturedAt}\n`+s.sections.map(c=>`${c.subject} ${c.course} ${c.code}`).join('\n')).join('\n\n');
  feedback(`Preview ready: ${pending.length} period(s), ${pending.reduce((n,s)=>n+s.sections.length,0)} section(s). ${paired?'Review below, then click Upload.':'Connect your account before uploading.'}`,'success');
}
for(const [id,kind]of [['preview-sections','sections'],['preview-registrations','registrations']]as const)
  el(id).onclick=()=>action(id,kind==='sections'?'Reading course sections…':'Reading your registrations…',async()=>{clearPreview();pending=await capture(kind);showPreview();});
el('snapshot-file').onchange=()=>action('snapshot-file','Reading and validating your file…',async()=>{
  const input=el('snapshot-file') as HTMLInputElement;clearPreview();
  try{
    const file=input.files?.[0];if(!file){feedback('No file selected.');return;}
    if(file.size>4_000_000)throw new Error('Snapshot file must be at most 4 MB.');
    let data:unknown;try{data=JSON.parse(await file.text());}catch{throw new Error('This file is not valid JSON. Choose an exported UBC snapshot.');}
    const items=Array.isArray(data)?data:[data];if(!items.length||items.length>20)throw new Error('Choose a file with 1–20 snapshots.');
    try{pending=items.map(s=>parseSnapshot(s));}catch{throw new Error('This is not a supported UBC snapshot. Export it again using the extension.');}showPreview();
  }finally{input.value='';}
});
el('upload').onclick=()=>action('upload','Preparing upload…',async()=>{
  const connection=storedConnection(await extensionApi.storage.local.get(['ubcConnection']));
  if(!connection)throw new Error('Connect the extension first.');if(!pending.length)throw new Error('Preview data first.');
  const {uploadToken:ubcUploadToken,origin:uploadOrigin}=connection;
  let completed=0;const total=pending.length;
  while(pending.length){
    feedback(`Uploading period ${completed+1} of ${total}… Keep this popup open until it finishes.`,'loading');
    el('upload').textContent=`Uploading ${completed+1} of ${total}…`;
    const r=await fetch(uploadOrigin+'/v1/snapshots',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${ubcUploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(pending[0]),signal:AbortSignal.timeout(20_000)});
    if(!r.ok){await r.body?.cancel();if(r.status===401){await extensionApi.storage.local.remove(['ubcUploadToken','ubcConnection']);await showConnection();throw new Error('Your connection was revoked. Connect again with MCPHub.');}throw new Error(`Upload stopped after ${completed} of ${total} periods (HTTP ${r.status}). Refresh Workday and preview again.`);}
    await r.body?.cancel();pending.shift();completed++;
  }
  feedback(`Synced ${completed} period(s).${autoSync?' Automatic sync keeps them up to date while Workday is open.':''}`,'success');
});
for(const [id,kind]of [['capture','sections'],['registrations','registrations']]as const)
  el(id).onclick=()=>action(id,'Preparing your export…',async()=>{
    const snapshots=await capture(kind),first=snapshots[0]!;
    const url=URL.createObjectURL(new Blob([JSON.stringify(kind==='sections'?first:snapshots,null,2)],{type:'application/json'}));
    try{feedback('Choose where to save the export…','loading');await extensionApi.downloads.download({url,filename:kind==='sections'?`ubc-${first.campus}-${first.academicPeriod.id}.json`:'ubc-private-registrations.json',saveAs:true});}
    finally{URL.revokeObjectURL(url);}
    feedback('Export saved. Keep registration files private. You can import this file later to preview and sync it.','success');
  });

el('open-hub').onclick=()=>action('open-hub','Opening MCPHub…',async()=>{
  if(!DEFAULT_HUB){(el('manual-connect') as HTMLDetailsElement).open=true;throw new Error('Enter your MCPHub address below.');}
  await extensionApi.tabs.create({url:DEFAULT_HUB+HUB_PAGE_PATH});
  feedback('Click “Connect this browser” on the MCPHub page. This popup can be closed.');
});
/**
 * Asks for access to another Hub and then finishes the request. The request is saved first:
 * Chrome closes this popup while its access prompt is open, and the background then finishes it.
 */
async function withHubAccess(intent:{type:'authorize'|'pair';origin:string;code?:string}){
  void extensionApi.storage.local.set({ubcPendingIntent:{...intent,at:Date.now()},ubcAuthorization:null});
  // The permission request must stay the first await of the click.
  if(!await extensionApi.permissions.request({origins:[intent.origin+'/*']})){
    await extensionApi.storage.local.remove('ubcPendingIntent');
    throw new Error('Allow access to your MCPHub to continue.');
  }
  const response=await extensionApi.runtime.sendMessage({type:'ubc.intent.resume'});
  if(!response?.ok)throw new Error(response?.error??'Could not connect to your MCPHub.');
}
el('hub-login').onclick=()=>action('hub-login','Opening your MCPHub…',async()=>{
  const selected=hubOrigin((el('hub-origin') as HTMLInputElement).value);
  await withHubAccess({type:'authorize',origin:selected});
  feedback('Continue in the MCPHub tab. This popup can be closed.');
});
el('pair').onclick=()=>action('pair','Connecting…',async()=>{
  const selected=hubOrigin((el('hub-origin') as HTMLInputElement).value||DEFAULT_HUB||'');
  const code=(el('pair-code') as HTMLInputElement).value.trim();
  if(!/^[\w-]{43}$/.test(code))throw new Error('Enter the pairing code shown on the MCPHub UBC page.');
  await withHubAccess({type:'pair',origin:selected,code});
  (el('pair-code') as HTMLInputElement).value='';
  await showConnection();feedback('Connected. Your first Workday sync has started.','success');
});
el('sync-all').onclick=()=>action('sync-all','Syncing open Workday pages…',async()=>{
  if(!paired)throw new Error('Connect to MCPHub first.');
  if(!await extensionApi.permissions.request({origins:['https://wd10.myworkday.com/*']}))throw new Error('Allow UBC Workday access to enable automatic sync.');
  await extensionApi.storage.local.set({ubcAutoSync:true});
  const result=await extensionApi.runtime.sendMessage({type:'ubc.sync.all'});
  if(!result?.ok)throw new Error(result?.error??'Could not sync Workday.');
  await showConnection();
  if(result.error&&result.readable){feedback(`Synced ${result.count} snapshot(s), but another page failed: ${result.error}`,'error');return;}
  if(result.error)throw new Error(result.error);
  if(!result.readable)throw new Error('Could not sync Workday. Sign in to Workday and try again.');
  feedback(`Synced ${result.count} Workday snapshot(s).`,'success');
});
el('auto-toggle').onclick=()=>action('auto-toggle','Updating automatic sync…',async()=>{
  const previous=autoSync;
  if(!previous&&!await extensionApi.permissions.request({origins:['https://wd10.myworkday.com/*']}))throw new Error('Allow UBC Workday access to enable automatic sync.');
  await extensionApi.storage.local.set({ubcAutoSync:!previous,ubcSyncError:null});
  const response=await extensionApi.runtime.sendMessage({type:'ubc.sync.configure'});
  if(!response?.ok)throw new Error(response?.error??'Could not update automatic sync.');
  await showConnection();feedback(previous?'Automatic sync paused.':'Automatic sync enabled.','success');
});
if(extensionApi.storage.onChanged)extensionApi.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!('ubcAuthorization'in changes||'ubcConnection'in changes||'ubcLastSync'in changes||'ubcAutoSync'in changes||'ubcSyncError'in changes))return;
  void showConnection().then(data=>{
    const a=data.ubcAuthorization;
    if(a?.status==='connected')feedback('Connected through MCPHub. Your connection is saved for future syncs.','success');
    else if(a?.status==='error')feedback(a.message??'Connection failed. Try again.','error');
    controls();
  }).catch(()=>feedback('Could not read your connection. Reopen the popup.','error'));
});
const remindSelect=document.getElementById('remind-after') as HTMLSelectElement|null;
if(remindSelect)remindSelect.onchange=()=>action('remind-after','Saving…',async()=>{
  const hours=remindHours(Number(remindSelect.value));
  await extensionApi.storage.local.set({ubcRemindAfterHours:hours,ubcSnoozeUntil:null});
  feedback(hours?'Reminder saved.':'Reminders are off.','success');
});
