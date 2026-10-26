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
