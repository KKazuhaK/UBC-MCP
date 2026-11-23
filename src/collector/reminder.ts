import {HOUR,ago,remindHours} from './reminder-policy.js';
import {WORKDAY_REGISTRATIONS_URL} from './defaults.js';
import {localizeDocument,t} from './i18n.js';
declare const browser:typeof chrome;
const api=typeof browser!=='undefined'?browser:chrome;
const el=(id:string)=>document.getElementById(id)!;
localizeDocument(document);
const say=(text:string,state='info')=>{el('status').textContent=text;el('status').dataset.state=state;};
async function load(){
  const s=await api.storage.local.get(['ubcLastSync','ubcRemindAfterHours']);
  const at=(s.ubcLastSync as {at?:string}|undefined)?.at;
  el('age').textContent=at?t('Your course data was last updated {ago}.',{ago:ago(at,Date.now())}):t('Your course data has not been synced yet.');
  (el('remind-after') as HTMLSelectElement).value=String(remindHours(s.ubcRemindAfterHours));
}
el('open-workday').onclick=async()=>{
  await api.tabs.create({url:WORKDAY_REGISTRATIONS_URL,active:true});
  window.close();
};
const SNOOZED:Record<string,string>={'24':"OK. You'll be reminded tomorrow.",'72':"OK. You'll be reminded in 3 days.",'168':"OK. You'll be reminded in a week."};
for(const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-snooze]')))
  button.onclick=async()=>{
    await api.storage.local.set({ubcSnoozeUntil:Date.now()+Number(button.dataset.snooze)*HOUR});
    say(t(SNOOZED[button.dataset.snooze??'']??'OK.'),'success');
    setTimeout(()=>window.close(),900);
  };
(el('remind-after') as HTMLSelectElement).onchange=async()=>{
  const hours=remindHours(Number((el('remind-after') as HTMLSelectElement).value));
  await api.storage.local.set({ubcRemindAfterHours:hours});
  say(hours?t('Saved.'):t('Reminders are off. You can turn them on again in the extension popup.'),'success');
};
void load();
