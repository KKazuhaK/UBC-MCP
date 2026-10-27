import {parseSnapshot,type Snapshot} from '../model.js';
import {DEFAULT_HUB,hubOrigin,storedConnection} from './connection.js';
import {extractWorkdayDom} from './dom.js';
import {normalizeCapture} from './normalize.js';
import {extractRegistrationDom,normalizeRegistrations} from './registrations.js';
declare const browser:typeof chrome;
const extensionApi=typeof browser!=='undefined'?browser:chrome;
let origin=DEFAULT_HUB;
const el=(id:string)=>document.getElementById(id)!;
const status=el('status');
let pending:Snapshot[]=[],busy=false,paired=false,autoSync=false;
function feedback(message:string,state:'loading'|'success'|'error'|'info'='info') {
  status.textContent=message;status.dataset.state=state;
}
function controls() {
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=busy||(b.id==='upload'&&(!paired||!pending.length))||(b.id==='sync-all'&&(!paired||!autoSync))||(b.id==='auto-toggle'&&!paired));
  document.querySelectorAll<HTMLInputElement>('input').forEach(i=>i.disabled=busy);
  el('upload-hint').textContent=!paired?'Pair your account before uploading.':pending.length?`${pending.length} period(s) ready. Review the preview before uploading.`:'Preview a Workday page or import a file to enable upload.';
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
  const x=await extensionApi.storage.local.get(['ubcUploadToken','ubcConnection','ubcHubOrigin','ubcAuthorization','ubcAutoSync','ubcLastSync','ubcSyncError']) as Record<string,any>;const connection=storedConnection(x);paired=!!connection;origin=connection?.origin??DEFAULT_HUB;
  autoSync=!!x.ubcAutoSync;
  el('connection').textContent=connection?`Connected · ${connection.origin}`:'Not connected · Sign in through your MCPHub.';
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
    const setup=async()=>{
      // Firefox has no setAccessLevel. This extension declares no content scripts.
      if(typeof extensionApi.storage.local.setAccessLevel==='function')await extensionApi.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
      const data=await showConnection();(el('hub-origin') as HTMLInputElement).value=data.ubcHubOrigin??(paired?origin:'');
    };
    await Promise.race([setup(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Could not read the local connection. Reopen the extension or reload it, then try again.')),8000);})]);
    feedback(paired?'Connected. Workday sync is ready.':'Ready. Enter your MCPHub address to connect.');
  }catch(e){el('connection').textContent='Local connection could not be checked.';feedback(errorMessage(e),'error');}
  finally{if(timer)clearTimeout(timer);busy=false;controls();}
}
void initialize();
el('pair').onclick=()=>action('pair','Pairing with your account…',async()=>{
  const input=el('pair-code') as HTMLInputElement,code=input.value.trim();
  if(!/^[\w-]{43}$/.test(code))throw new Error('Paste a valid pairing code from the connection page.');
  origin=hubOrigin((el('hub-origin') as HTMLInputElement).value);
  if(extensionApi.permissions?.request&&!await extensionApi.permissions.request({origins:[origin+'/*']}))throw new Error('Site access is needed to connect to this MCPHub.');
  input.value='';
  const r=await fetch(origin+'/ubc/api/claim',{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(15_000)});
  if(!r.ok){
    await r.body?.cancel();
    if(r.status===403&&typeof browser!=='undefined')throw new Error('Firefox pairing is not enabled on this server (HTTP 403). The operator needs to upgrade the UBC connector; generating another code will not fix this.');
    if(r.status===401)throw new Error('Pairing code expired or already used. Generate a new code in your own Hub account and try again.');
    if(r.status===429)throw new Error('Too many pairing attempts. Wait a minute, then try again.');
    throw new Error(`Pairing service returned HTTP ${r.status}. Please retry or contact the service operator.`);
  }
  const x=await r.json();if(!/^[\w-]{43}$/.test(x.uploadToken))throw new Error('Invalid pairing response. Please try a new pairing code.');
  await extensionApi.storage.local.set({ubcConnection:{origin,uploadToken:x.uploadToken}});await showConnection();feedback('Account paired. Next, preview your Workday data.','success');
});
el('forget').onclick=()=>action('forget','Removing local connection…',async()=>{
  await extensionApi.storage.local.remove(['ubcUploadToken','ubcConnection','ubcAuthorization','ubcAutoSync','ubcLastSync','ubcSyncError']);pending=[];el('preview').textContent='';await showConnection();
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
  feedback(`Preview ready: ${pending.length} period(s), ${pending.reduce((n,s)=>n+s.sections.length,0)} section(s). ${paired?'Review below, then click Upload.':'Pair your account before uploading.'}`,'success');
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
  const connection=storedConnection(await extensionApi.storage.local.get(['ubcUploadToken','ubcConnection']));
  if(!connection)throw new Error('Pair the extension first.');if(!pending.length)throw new Error('Preview data first.');
  const {uploadToken:ubcUploadToken,origin:uploadOrigin}=connection;
  let completed=0;const total=pending.length;
  while(pending.length){
    feedback(`Uploading period ${completed+1} of ${total}… Keep this popup open until it finishes.`,'loading');
    el('upload').textContent=`Uploading ${completed+1} of ${total}…`;
    const r=await fetch(uploadOrigin+'/v1/snapshots',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${ubcUploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(pending[0]),signal:AbortSignal.timeout(20_000)});
    if(!r.ok){await r.body?.cancel();if(r.status===401){await extensionApi.storage.local.remove(['ubcUploadToken','ubcConnection']);await showConnection();throw new Error('Your connection was revoked. Pair again using a new code.');}throw new Error(`Upload stopped after ${completed} of ${total} periods (HTTP ${r.status}). Refresh Workday and preview again.`);}
    await r.body?.cancel();pending.shift();completed++;
  }
  feedback(`Synced ${completed} period(s). You can close Chrome. Sync again when your Workday data changes.`,'success');
});
for(const [id,kind]of [['capture','sections'],['registrations','registrations']]as const)
  el(id).onclick=()=>action(id,'Preparing your export…',async()=>{
    const snapshots=await capture(kind),first=snapshots[0]!;
    const url=URL.createObjectURL(new Blob([JSON.stringify(kind==='sections'?first:snapshots,null,2)],{type:'application/json'}));
    try{feedback('Choose where to save the export…','loading');await extensionApi.downloads.download({url,filename:kind==='sections'?`ubc-${first.campus}-${first.academicPeriod.id}.json`:'ubc-private-registrations.json',saveAs:true});}
    finally{URL.revokeObjectURL(url);}
    feedback('Export saved. Keep registration files private. You can import this file later to preview and sync it.','success');
  });

el('hub-login').onclick=()=>action('hub-login','Opening your MCPHub…',async()=>{
  const selected=hubOrigin((el('hub-origin') as HTMLInputElement).value);
  if(!await extensionApi.permissions.request({origins:[selected+'/*','https://wd10.myworkday.com/*']}))throw new Error('Allow access to your selected MCPHub and UBC Workday to continue.');
  await extensionApi.storage.local.set({ubcAutoSync:true});
  const response=await extensionApi.runtime.sendMessage({type:'ubc.authorize.start',origin:selected});
  if(!response?.ok)throw new Error(response?.error??'Could not open your MCPHub.');
  feedback('Continue in the MCPHub tab. This popup can be closed.');
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
