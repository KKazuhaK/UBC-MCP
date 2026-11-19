import {freshness} from '../model.js';
import type {Retention} from './store.js';

const DAY=86_400_000;
/** Where the browser companion is installed or explained; the README section lists the store links as they appear. */
export const DEFAULT_INSTALL_URL='https://github.com/KKazuhaK/UBC-MCP#browser-stores';
export type ReadinessConfig={staleDays:number;installUrl:string};
/** Data older than a week is flagged: the connector stops serving it at 14 days, so users get a week of warning. */
export const DEFAULT_READINESS:ReadinessConfig={staleDays:7,installUrl:DEFAULT_INSTALL_URL};
/** UBC_READINESS_STALE_DAYS (default 7, at most the snapshot stale window) and UBC_COMPANION_INSTALL_URL (https). */
export function readinessFromEnv(env:Record<string,string|undefined>=process.env,retention?:Pick<Retention,'staleDays'>):ReadinessConfig {
  const raw=(env.UBC_READINESS_STALE_DAYS??'').trim();let staleDays=DEFAULT_READINESS.staleDays;
  if(raw){staleDays=Number(raw);if(!Number.isFinite(staleDays)||staleDays<=0)throw new Error('UBC_READINESS_STALE_DAYS must be a positive number of days');}
  if(retention&&staleDays>retention.staleDays)throw new Error('UBC_READINESS_STALE_DAYS must not exceed UBC_SNAPSHOT_STALE_DAYS');
  const url=(env.UBC_COMPANION_INSTALL_URL??'').trim();
  if(url){let u:URL;try{u=new URL(url);}catch{throw new Error('UBC_COMPANION_INSTALL_URL must be an https URL');}
    if(u.protocol!=='https:'||u.username||u.password)throw new Error('UBC_COMPANION_INSTALL_URL must be an https URL');}
  return {staleDays,installUrl:url||DEFAULT_READINESS.installUrl};
}
const plural=(n:number,unit:string)=>`${n} ${unit}${n===1?'':'s'}`;
/**
 * Service readiness contract v1, derived only from a binding's snapshot count and newest capture time:
 * none stored -> needs_setup; newest older than the threshold (same age test as the tools' data freshness) -> degraded; else ready.
 * Carries no tokens, snapshot content or course data.
 */
export function readiness(summary:{count:number;newestCapturedAt:string|null},now:number,config:ReadinessConfig=DEFAULT_READINESS) {
  const checked_at=new Date(now).toISOString();
  if(!summary.count||!summary.newestCapturedAt)
    return {version:1,state:'needs_setup',summary:'No course data has been uploaded yet. Install the UBC browser companion and sync from Workday.',
      action:{label:'Install the UBC browser companion',url:config.installUrl},checked_at};
  const age=freshness(summary.newestCapturedAt,now,config.staleDays*DAY/1000);
  if(age.stale) {
    const days=Math.floor(age.ageSeconds*1000/DAY),hours=Math.floor(age.ageSeconds/3600);
    const ago=days>=1?plural(days,'day'):plural(Math.max(hours,1),'hour');
    return {version:1,state:'degraded',summary:`Course data last updated ${ago} ago — open the companion to refresh.`,checked_at};
  }
  return {version:1,state:'ready',checked_at};
}
