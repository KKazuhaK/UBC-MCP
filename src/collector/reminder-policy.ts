/** How old the data may get before the extension opens a reminder, in hours; 0 turns reminders off. */
export const REMIND_CHOICES=[24,72,168,0] as const;
export const DEFAULT_REMIND_HOURS=72;
/** An ignored reminder comes back after this long, not on every check. */
export const IGNORED_SNOOZE_MS=12*3600_000;
export const HOUR=3600_000;
export function remindHours(value:unknown):number{
  return typeof value==='number'&&(REMIND_CHOICES as readonly number[]).includes(value)?value:DEFAULT_REMIND_HOURS;
}
/**
 * Whether a reminder is due: reminders are on, the data (or, before the first sync, the connection)
 * is older than the chosen age, and no snooze is running.
 */
export function reminderDue(s:{lastSyncAt?:string|null;connectedAt?:string|null;remindAfterHours?:unknown;snoozeUntil?:unknown},now:number):boolean{
  const hours=remindHours(s.remindAfterHours);
  if(!hours)return false;
  if(typeof s.snoozeUntil==='number'&&s.snoozeUntil>now)return false;
  const since=Date.parse(s.lastSyncAt??s.connectedAt??'');
  return Number.isFinite(since)&&now-since>=hours*HOUR;
}
export function ago(iso:string|null|undefined,now:number):string{
  const ms=now-Date.parse(iso??'');
  if(!Number.isFinite(ms))return 'never';
  const h=Math.floor(ms/HOUR);
  if(h<1)return 'less than an hour ago';
  if(h<48)return `${h} hour${h===1?'':'s'} ago`;
  const d=Math.floor(h/24);return `${d} days ago`;
}
