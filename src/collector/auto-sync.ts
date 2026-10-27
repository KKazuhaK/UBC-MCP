import {extractWorkdayDom} from './dom.js';
import {normalizeCapture} from './normalize.js';
import {extractRegistrationDom,normalizeRegistrations} from './registrations.js';
import type {Snapshot} from '../model.js';
declare const browser:typeof chrome;
const api=typeof browser!=='undefined'?browser:chrome;
const marker='__ubcCourseCaptureAutoSync';
const root=globalThis as unknown as Record<string,unknown>;
if(!root[marker]){
  root[marker]=true;
  let timer:ReturnType<typeof setTimeout>|undefined,last='',lastAt=0,running=false;
  async function run(force=false){
    if(running)return {ok:false,error:'A sync is already running.'};
    running=true;
    try{
      const access=await api.runtime.sendMessage({type:'ubc.sync.enabled'});
      if(!access?.ok||!access.enabled)return {ok:false,error:'Automatic sync is disabled.'};
      const snapshots:Snapshot[]=[];
      const courses=extractWorkdayDom();
      if(courses.cards.length||courses.details){
        try{snapshots.push(normalizeCapture(courses));}catch{/* The page is still loading or lacks a clear period. */}
      }
      const registrations=extractRegistrationDom();
      let registrationIssue='';
      if(registrations.rows.length){
        // Refuse a potentially partial registration table: Workday may render
        // rows incrementally or paginate. Missing a count is not proof of completeness.
        const nearLabels:number[]=[];
        for(const label of ['My Enrolled Courses','My Waitlisted Courses']){
          const el=Array.from(document.querySelectorAll('body *')).find(e=>!e.children.length&&(e.textContent??'').trim()===label);
          let parent=el?.parentElement;
          for(let i=0;parent&&i<4;i++,parent=parent.parentElement){
            const match=/\b(\d+)\s*items?\b/i.exec(parent.textContent??'');
            if(match){nearLabels.push(Number(match[1]));break;}
          }
        }
        const texts=[document.body?.innerText??'',document.body?.textContent??''];
        const candidates=[nearLabels,...texts.map(text=>[...text.matchAll(/My (?:Enrolled|Waitlisted) Courses\s*(\d+)\s*items?\b/gi)].map(m=>Number(m[1])))];
        const counts=candidates.find(values=>values.length&&values.reduce((a,b)=>a+b,0)===registrations.rows.length)??candidates.find(values=>values.length)??[];
        if(counts.length&&counts.reduce((a,b)=>a+b,0)===registrations.rows.length){
          try{snapshots.push(...normalizeRegistrations(registrations));}catch{registrationIssue='Could not recognize the registration periods on this page.';}
        }else registrationIssue=`Registration table may be incomplete (${registrations.rows.length} rows; ${counts.length?counts.reduce((a,b)=>a+b,0):'unknown'} expected).`;
      }
      if(!snapshots.length)return {ok:false,error:registrationIssue||'No complete supported Workday data is visible on this page.'};
      const signature=JSON.stringify(snapshots,(key,value)=>key==='capturedAt'||key==='observedAt'?undefined:value);
      if(!force&&signature===last&&Date.now()-lastAt<240_000)return {ok:true,unchanged:true,count:0};
      const result=await api.runtime.sendMessage({type:'ubc.sync.snapshots',snapshots});
      if(!result?.ok)return {ok:false,error:result?.error??'Sync failed.'};
      last=signature;lastAt=Date.now();return {ok:true,count:result.count,kinds:[...new Set(snapshots.map(s=>s.kind))]};
    }catch{return {ok:false,error:'Could not read or sync this Workday page.'};}
    finally{running=false;}
  }
  const schedule=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>{void run();},5000);};
  api.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(message?.type!=='ubc.sync.now'||sender.id!==api.runtime.id)return false;
    void run(true).then(sendResponse);return true;
  });
  const observer=new MutationObserver(schedule);
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  schedule();
  setInterval(()=>{void run();},240_000);
}
