// Declared only for the default Hub's UBC page. It lets that page see that the extension is
// installed and hand it a one-time pairing code after the person clicks "Connect this browser".
// It reads nothing else on the page and never sees cookies or Hub tokens.
import {BRIDGE_CHANNEL} from './defaults.js';
declare const browser:typeof chrome;
(()=>{
  const api=typeof browser!=='undefined'?browser:chrome;
  const root=document.documentElement;
  if(root.dataset.ubcCompanionBridge)return;
  root.dataset.ubcCompanionBridge='active';
  const post=(message:Record<string,unknown>)=>window.postMessage({channel:BRIDGE_CHANNEL,from:'extension',...message},location.origin);
  const version=api.runtime.getManifest().version;
  let claiming=false;
  const announce=async()=>{
    let connected=false;
    try{connected=!!(await api.runtime.sendMessage({type:'ubc.bridge.status'}))?.connected;}catch{/* The service worker restarts on the next message. */}
    post({type:'ready',version,connected});
  };
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    const data=event.data;
    if(!data||data.channel!==BRIDGE_CHANNEL||data.from!=='page')return;
    if(data.type==='hello'){void announce();return;}
    if(data.type!=='connect'||typeof data.code!=='string'||claiming)return;
    claiming=true;
    void api.runtime.sendMessage({type:'ubc.bridge.claim',code:data.code})
      .then(result=>post({type:'result',ok:!!result?.ok,error:result?.ok?'':result?.error??'Connection failed.'}),
        ()=>post({type:'result',ok:false,error:'Could not reach the extension. Reload this page and try again.'}))
      .finally(()=>{claiming=false;void announce();});
  });
  void announce();
})();
