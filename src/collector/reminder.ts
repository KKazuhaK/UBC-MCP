import {HOUR,ago,remindHours} from './reminder-policy.js';
import {WORKDAY_REGISTRATIONS_URL} from './defaults.js';
declare const browser:typeof chrome;
const api=typeof browser!=='undefined'?browser:chrome;
const el=(id:string)=>document.getElementById(id)!;
const say=(text:string,state='info')=>{el('status').textContent=text;el('status').dataset.state=state;};
async function load(){
  const s=await api.storage.local.get(['ubcLastSync','ubcRemindAfterHours']);
  const at=(s.ubcLastSync as {at?:string}|undefined)?.at;
  el('age').textContent=at?`Your course data was last updated ${ago(at,Date.now())}.`:'Your course data has not been synced yet.';
  (el('remind-after') as HTMLSelectElement).value=String(remindHours(s.ubcRemindAfterHours));
}
el('open-workday').onclick=async()=>{
  await api.tabs.create({url:WORKDAY_REGISTRATIONS_URL,active:true});
  window.close();
};
for(const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-snooze]')))
  button.onclick=async()=>{
    await api.storage.local.set({ubcSnoozeUntil:Date.now()+Number(button.dataset.snooze)*HOUR});
    say(`OK. You'll be reminded ${button.textContent!.toLowerCase().replace('remind me ','')}.`,'success');
    setTimeout(()=>window.close(),900);
  };
(el('remind-after') as HTMLSelectElement).onchange=async()=>{
  const hours=remindHours(Number((el('remind-after') as HTMLSelectElement).value));
  await api.storage.local.set({ubcRemindAfterHours:hours});
  say(hours?'Saved.':'Reminders are off. You can turn them on again in the extension popup.','success');
};
void load();
