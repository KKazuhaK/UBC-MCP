import {freshness} from '../model.js';
import type {Retention} from './store.js';

const DAY=86_400_000;
/** Where the browser companion is installed or explained; the README section lists the store links as they appear. */
export const DEFAULT_INSTALL_URL='https://github.com/KKazuhaK/UBC-MCP#browser-stores';
export type ReadinessConfig={staleDays:number;installUrl:string};
/** Data older than a week is flagged: the connector stops serving it at 14 days, so users get a week of warning. */
export const DEFAULT_READINESS:ReadinessConfig={staleDays:7,installUrl:DEFAULT_INSTALL_URL};
/**
 * UBC_READINESS_STALE_DAYS and UBC_COMPANION_INSTALL_URL (https). Unset, the threshold is min(7, the snapshot stale window),
 * so any valid retention setting starts; set explicitly it must be a whole number of days within the snapshot stale window.
 */
export function readinessFromEnv(env:Record<string,string|undefined>=process.env,retention?:Pick<Retention,'staleDays'>):ReadinessConfig {
  const raw=(env.UBC_READINESS_STALE_DAYS??'').trim();
  let staleDays=Math.min(DEFAULT_READINESS.staleDays,retention?.staleDays??Infinity);
  if(raw){
    if(!/^[1-9]\d{0,3}$/.test(raw))throw new Error('UBC_READINESS_STALE_DAYS must be a positive whole number of days');
    staleDays=Number(raw);
    if(retention&&staleDays>retention.staleDays)throw new Error('UBC_READINESS_STALE_DAYS must not exceed UBC_SNAPSHOT_STALE_DAYS');
  }
  const url=(env.UBC_COMPANION_INSTALL_URL??'').trim();
  if(url){let u:URL;try{u=new URL(url);}catch{throw new Error('UBC_COMPANION_INSTALL_URL must be an https URL');}
    if(u.protocol!=='https:'||u.username||u.password)throw new Error('UBC_COMPANION_INSTALL_URL must be an https URL');}
  return {staleDays,installUrl:url||DEFAULT_READINESS.installUrl};
}
const plural=(n:number,unit:string)=>`${n} ${unit}${n===1?'':'s'}`;
export type ReadinessSummary={lastUploadedAt:number|null;newestCapturedAt:string|null;servable:boolean;staleDays:number};
/**
 * Service readiness contract v1, derived only from a binding's upload history, never from snapshot content:
 * never uploaded -> needs_setup; newest snapshot inside the serve window and fresher than the threshold -> ready,
 * older than the threshold -> degraded; uploaded before but nothing is served any more (past the window, or purged) -> expired.
 * Carries no tokens, snapshot content or course data.
 */
export function readiness(summary:ReadinessSummary,now:number,config:ReadinessConfig=DEFAULT_READINESS,setup?:{label:string;url:string}) {
  const checked_at=new Date(now).toISOString(),action={label:'Open the UBC companion',url:config.installUrl};
  if(summary.lastUploadedAt===null&&!summary.newestCapturedAt)
    return {version:1,state:'needs_setup',summary:'No course data has been uploaded yet. Install the UBC browser companion and sync from Workday.',
      action:setup??{label:'Install the UBC browser companion',url:config.installUrl},checked_at};
  if(!summary.servable||!summary.newestCapturedAt)
    return {version:1,state:'expired',summary:`Course data is older than ${windowText(summary.staleDays)} and no longer used — open the UBC companion to sync again`,action,checked_at};
  const age=freshness(summary.newestCapturedAt,now,config.staleDays*DAY/1000);
  if(age.stale) {
    const days=Math.floor(age.ageSeconds*1000/DAY),hours=Math.floor(age.ageSeconds/3600);
    const ago=days>=1?plural(days,'day'):plural(Math.max(hours,1),'hour');
    return {version:1,state:'degraded',summary:`Course data last updated ${ago} ago — open the companion to refresh.`,action,checked_at};
  }
  return {version:1,state:'ready',checked_at};
}
/** A whole number of days, otherwise hours: "5 days", "1 day", "12 hours", "36 hours". */
const windowText=(days:number)=>days>=1&&Number.isInteger(days)?plural(days,'day'):plural(Math.max(1,Math.round(days*24)),'hour');
