import {parseSnapshot,type Snapshot} from '../model.js';
import {extractWorkdayDom} from './dom.js';
import {normalizeCapture} from './normalize.js';
import {extractRegistrationDom,normalizeRegistrations} from './registrations.js';
const origin='https://mcp.kazuhahub.com';
const el=(id:string)=>document.getElementById(id)!;
const status=el('status');
let pending:Snapshot[]=[],busy=false,paired=false;
function feedback(message:string,state:'loading'|'success'|'error'|'info'='info') {
  status.textContent=message;status.dataset.state=state;
}
function controls() {
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=busy||(b.id==='upload'&&(!paired||!pending.length)));
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
  try{await work();}catch(e){feedback(errorMessage(e),'error');}
  finally{busy=false;document.body.setAttribute('aria-busy','false');if(button.tagName==='BUTTON'){button.textContent=original;button.removeAttribute('aria-busy');}controls();}
}
async function showConnection() {
  const x=await chrome.storage.local.get('ubcUploadToken');paired=!!x.ubcUploadToken;
  el('connection').textContent=paired?'Paired · Uploads go to your connected Hub account.':'Not paired · Generate a code in your Hub account.';
}
// Credentials stay in trusted extension-local storage, never page or sync storage.
busy=true;controls();
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).then(showConnection).then(()=>feedback(paired?'Ready. Preview data to sync.':'Ready. Pair your account to get started.')).catch(e=>feedback(errorMessage(e),'error')).finally(()=>{busy=false;controls();});
el('pair').onclick=()=>action('pair','Pairing with your account…',async()=>{
  const input=el('pair-code') as HTMLInputElement,code=input.value.trim();
  if(!/^[\w-]{43}$/.test(code))throw new Error('Paste a valid pairing code from the connection page.');
  input.value='';
  const r=await fetch(origin+'/ubc/api/claim',{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(15_000)});
  if(!r.ok){await r.body?.cancel();throw new Error('Pairing failed. The code may have expired or been used. Generate a new code and try again.');}
  const x=await r.json();if(!/^[\w-]{43}$/.test(x.uploadToken))throw new Error('Invalid pairing response. Please try a new pairing code.');
  await chrome.storage.local.set({ubcUploadToken:x.uploadToken});await showConnection();feedback('Account paired. Next, preview your Workday data.','success');
});
el('forget').onclick=()=>action('forget','Removing local connection…',async()=>{
  await chrome.storage.local.remove('ubcUploadToken');pending=[];el('preview').textContent='';await showConnection();
  feedback('Local connection removed. To revoke server access and delete snapshots, use the connection page.','success');
});
async function capture(kind:'sections'|'registrations'):Promise<Snapshot[]> {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!/^https:\/\/wd10\.myworkday\.com\/ubc\//.test(tab.url??''))throw new Error(kind==='sections'?'Open UBC Workday Find Course Sections, refresh the results, then try again.':'Open UBC Workday View My Courses, then try again.');
  if(kind==='sections') {
    const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractWorkdayDom});
    if(!r?.result)throw new Error('No course data returned. Refresh the Workday page and try again.');return [normalizeCapture(r.result)];
  }
  const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractRegistrationDom});
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
  const {ubcUploadToken}=await chrome.storage.local.get('ubcUploadToken');
  if(!ubcUploadToken)throw new Error('Pair the extension first.');if(!pending.length)throw new Error('Preview data first.');
  let completed=0;const total=pending.length;
  while(pending.length){
    feedback(`Uploading period ${completed+1} of ${total}… Keep this popup open until it finishes.`,'loading');
    el('upload').textContent=`Uploading ${completed+1} of ${total}…`;
    const r=await fetch(origin+'/v1/snapshots',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${ubcUploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(pending[0]),signal:AbortSignal.timeout(20_000)});
    if(!r.ok){await r.body?.cancel();if(r.status===401){await chrome.storage.local.remove('ubcUploadToken');await showConnection();throw new Error('Your connection was revoked. Pair again using a new code.');}throw new Error(`Upload stopped after ${completed} of ${total} periods (HTTP ${r.status}). Refresh Workday and preview again.`);}
    await r.body?.cancel();pending.shift();completed++;
  }
  feedback(`Synced ${completed} period(s). You can close Chrome. Sync again when your Workday data changes.`,'success');
});
for(const [id,kind]of [['capture','sections'],['registrations','registrations']]as const)
  el(id).onclick=()=>action(id,'Preparing your export…',async()=>{
    const snapshots=await capture(kind),first=snapshots[0]!;
    const url=URL.createObjectURL(new Blob([JSON.stringify(kind==='sections'?first:snapshots,null,2)],{type:'application/json'}));
    try{feedback('Choose where to save the export…','loading');await chrome.downloads.download({url,filename:kind==='sections'?`ubc-${first.campus}-${first.academicPeriod.id}.json`:'ubc-private-registrations.json',saveAs:true});}
    finally{URL.revokeObjectURL(url);}
    feedback('Export saved. Keep registration files private. You can import this file later to preview and sync it.','success');
  });
