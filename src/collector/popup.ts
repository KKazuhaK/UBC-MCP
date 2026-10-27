import {parseSnapshot} from '../model.js';
import {extractWorkdayDom} from './dom.js';
import {normalizeCapture} from './normalize.js';
import {extractRegistrationDom,normalizeRegistrations} from './registrations.js';
const status=document.querySelector<HTMLElement>('#status')!;
document.querySelector<HTMLButtonElement>('#capture')!.addEventListener('click',async()=>{
  const button=document.querySelector<HTMLButtonElement>('#capture')!;button.disabled=true;
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id||!/^https:\/\/wd10\.myworkday\.com\/ubc\//.test(tab.url??''))throw new Error('Open UBC Workday Find Course Sections first');
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractWorkdayDom});
    if(!result?.result)throw new Error('No page capture returned');
    const snapshot=normalizeCapture(result.result);
    const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
    await chrome.downloads.download({url,filename:`ubc-${snapshot.campus}-${snapshot.academicPeriod.id}.json`,saveAs:true});
    URL.revokeObjectURL(url);
    status.textContent=`Captured ${snapshot.sections.length} visible sections. Coverage is partial. Detail dialogs include full meeting patterns and seat pools. Sync the saved file with your local upload token.`;
  }catch(e){status.textContent=e instanceof Error?e.message:'Capture failed';}finally{button.disabled=false;}
});
document.querySelector<HTMLButtonElement>('#registrations')!.addEventListener('click',async()=>{
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id||!/^https:\/\/wd10\.myworkday\.com\/ubc\//.test(tab.url??''))throw new Error('Open UBC Workday View My Courses first');
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractRegistrationDom});
    if(!result?.result)throw new Error('No registration capture');
    const snapshots=normalizeRegistrations(result.result),url=URL.createObjectURL(new Blob([JSON.stringify(snapshots,null,2)],{type:'application/json'}));
    await chrome.downloads.download({url,filename:'ubc-private-registrations.json',saveAs:true});URL.revokeObjectURL(url);
    status.textContent=`Exported private registrations across ${snapshots.length} periods. The file contains course selections, not your name or student ID. Keep it private; sync only to your own binding.`;
  }catch(e){status.textContent=e instanceof Error?e.message:'Registration capture failed';}
});

// Upload credentials remain in extension-local storage, never page DOM or sync storage.
const origin='https://mcp.kazuhahub.com';
let pending:import('../model.js').Snapshot[]=[];
const el=(id:string)=>document.getElementById(id)!;
async function showConnection(){const x=await chrome.storage.local.get('ubcUploadToken');el('connection').textContent=x.ubcUploadToken?'Extension paired. Preview before uploading.':'Extension not paired.';}
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).then(showConnection);
el('pair').onclick=async()=>{
  const input=el('pair-code') as HTMLInputElement,code=input.value.trim();input.value='';
  try{
    if(!/^[\w-]{43}$/.test(code))throw new Error('Paste a valid unexpired pairing code');
    const r=await fetch(origin+'/ubc/api/claim',{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(15_000)});
    if(!r.ok)throw new Error('Pairing failed. Generate a new code in the connection page.');
    const x=await r.json();if(!/^[\w-]{43}$/.test(x.uploadToken))throw new Error('Invalid pairing response');
    await chrome.storage.local.set({ubcUploadToken:x.uploadToken});await showConnection();status.textContent='Paired. Your Workday password and cookies were not shared.';
  }catch(e){status.textContent=e instanceof Error?e.message:'Pairing failed';}
};
el('forget').onclick=async()=>{await chrome.storage.local.remove('ubcUploadToken');pending=[];(el('upload') as HTMLButtonElement).disabled=true;el('preview').textContent='';await showConnection();status.textContent='Local credential removed. To revoke server access and delete data, use the connection page.';};
function showPreview(){
    el('preview').textContent=pending.map(s=>`${s.campus} ${s.academicPeriod.id} · ${s.kind}\n${s.sections.length} sections · ${s.capturedAt}\n`+s.sections.map(c=>`${c.subject} ${c.course} ${c.code}`).join('\n')).join('\n\n');
    (el('upload') as HTMLButtonElement).disabled=false;status.textContent='Review above. Upload sends these course selections to your private UBC connection.';
}
async function preview(kind:'sections'|'registrations') {
  pending=[];(el('upload') as HTMLButtonElement).disabled=true;el('preview').textContent='';
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id||!/^https:\/\/wd10\.myworkday\.com\/ubc\//.test(tab.url??''))throw new Error('Open the relevant UBC Workday page first');
    if(kind==='sections'){
      const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractWorkdayDom});if(!r?.result)throw new Error('No capture');pending=[normalizeCapture(r.result)];
    }else{
      const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractRegistrationDom});if(!r?.result)throw new Error('No capture');pending=normalizeRegistrations(r.result);
    }
    showPreview();
  }catch(e){status.textContent=e instanceof Error?e.message:'Preview failed';}
}
el('preview-sections').onclick=()=>preview('sections');el('preview-registrations').onclick=()=>preview('registrations');
el('upload').onclick=async()=>{
  const button=el('upload') as HTMLButtonElement;button.disabled=true;let completed=0;
  try{
    const {ubcUploadToken}=await chrome.storage.local.get('ubcUploadToken');if(!ubcUploadToken)throw new Error('Pair the extension first');
    if(!pending.length)throw new Error('Preview data first');
    while(pending.length){
      const r=await fetch(origin+'/v1/snapshots',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${ubcUploadToken}`,'Content-Type':'application/json'},body:JSON.stringify(pending[0]),signal:AbortSignal.timeout(20_000)});
      if(!r.ok){await r.body?.cancel();throw new Error(`Upload stopped after ${completed} periods (HTTP ${r.status}). Refresh Workday and preview again, or re-pair if revoked.`);}
      await r.body?.cancel();pending.shift();completed++;
    }
    status.textContent=`Synced ${completed} periods. You can close Chrome. Data stays a snapshot until you sync again.`;
  }catch(e){status.textContent=e instanceof Error?e.message:'Upload failed';}
};

el('snapshot-file').onchange=async()=>{
  const input=el('snapshot-file') as HTMLInputElement;
  pending=[];(el('upload') as HTMLButtonElement).disabled=true;el('preview').textContent='';
  try{
    const file=input.files?.[0];if(!file)return;
    if(file.size>4_000_000)throw new Error('Snapshot file must be at most 4 MB');
    const data=JSON.parse(await file.text()),items=Array.isArray(data)?data:[data];
    if(!items.length||items.length>20)throw new Error('Expected 1–20 snapshots');
    pending=items.map(s=>parseSnapshot(s));showPreview();
  }catch(e){status.textContent=e instanceof Error?e.message:'Invalid snapshot file';}finally{input.value='';}
};
