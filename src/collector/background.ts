import {hubOrigin} from './connection.js';
declare const browser:typeof chrome;
const api=typeof browser!=='undefined'?browser:chrome;
const token=(v:unknown):v is string=>typeof v==='string'&&/^[\w-]{43}$/.test(v);
type Authorization={origin:string;state:string;expires:number;tabId?:number;status:'pending'|'connected'|'error';message?:string};
let claiming=false;
async function inject(tabId:number,url:string){
  const {ubcAuthorization:a}=await api.storage.local.get('ubcAuthorization') as {ubcAuthorization?:Authorization};
  if(!a||a.status!=='pending'||a.tabId!==tabId||a.expires<Date.now())return;
  const u=new URL(url);
  if(u.origin!==a.origin||u.pathname!=='/ubc/'||u.hash!==`#extension-auth=${a.state}`)return;
  await api.scripting.executeScript({target:{tabId},files:['hub-link.js']});
}
async function handle(message:any,sender:chrome.runtime.MessageSender){
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
      await api.storage.local.remove('ubcUploadToken');return {ok:true};
    }catch(e){await api.storage.local.set({ubcAuthorization:{origin:a.origin,status:'error',message:e instanceof Error?e.message:'Connection failed.'}});throw e;}
    finally{claiming=false;}
  }
  throw new Error('Unknown request.');
}
api.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!['ubc.authorize.start','ubc.authorize.claim'].includes(message?.type))return false;
  void handle(message,sender).then(sendResponse,e=>sendResponse({ok:false,error:e instanceof Error?e.message:'Connection failed.'}));return true;
});
api.tabs.onUpdated.addListener((id,change,tab)=>{if(change.status==='complete'&&tab.url)void inject(id,tab.url).catch(()=>{});});
if(typeof api.storage.local.setAccessLevel==='function')void api.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
