// Runs only in the tab opened by this extension for a pending Hub authorization.
// No cookies, profile fields or Hub tokens are read.
declare const browser:typeof chrome;
(()=>{
  const api=typeof browser!=='undefined'?browser:chrome;
  const state=/^#extension-auth=([a-f0-9]{64})$/.exec(location.hash)?.[1];
  if(!state||document.documentElement.dataset.ubcLinkObserver)return;
  document.documentElement.dataset.ubcLinkObserver='active';
  let sending=false;
  const read=async()=>{
    const output=document.getElementById('ubc-extension-authorization');
    if(!output?.textContent||sending)return;
    let payload:any;try{payload=JSON.parse(output.textContent);}catch{return;}
    if(payload.state!==state||!/^[\w-]{43}$/.test(payload.code??''))return;
    sending=true;
    try{
      const result=await api.runtime.sendMessage({type:'ubc.authorize.claim',state,code:payload.code});
      output.textContent='';output.dataset.result=result?.ok?'connected':'error';output.dataset.message=result?.error??'';
    }catch{output.textContent='';output.dataset.result='error';output.dataset.message='Could not reach the extension. Start again from its popup.';}
  };
  const observer=new MutationObserver(()=>{void read();});observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});void read();
  setTimeout(()=>observer.disconnect(),10*60_000);
})();
