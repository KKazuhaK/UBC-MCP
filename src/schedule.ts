import type {Section} from './model.js';
import {freshness} from './model.js';

function shareActualDate(a:Section['meetings'][number],b:Section['meetings'][number]) {
  const start=a.startDate>b.startDate?a.startDate:b.startDate;
  const end=a.endDate<b.endDate?a.endDate:b.endDate;
  if (start>end) return false;
  const days=a.weekdays.filter(d=>b.weekdays.includes(d));
  const first=new Date(`${start}T00:00:00Z`), day=first.getUTCDay()||7;
  const span=(Date.parse(`${end}T00:00:00Z`)-first.getTime())/86_400_000;
  return days.some(d=>(d-day+7)%7<=span);
}
export function checkSchedule(sections:Section[],now=Date.now()) {
  const conflicts:Array<{left:string;right:string;kind:string}>=[],warnings:string[]=[];
  for (const s of sections) {
    if (s.scheduleKind==='unknown') warnings.push(`${s.id}: meeting times unknown`);
    if (freshness(s.observedAt,now).stale) warnings.push(`${s.id}: snapshot is older than five minutes`);
    if (s.allowedCompanionIds===null || s.requiredActivities===null)
      warnings.push(`${s.id}: required components or compatibility unverified`);
    const same=sections.filter(t=>t.subject===s.subject&&t.course===s.course);
    for (const activity of s.requiredActivities??[]) if (!same.some(t=>t.activity===activity))
      warnings.push(`${s.id}: missing required ${activity}`);
    if (s.allowedCompanionIds!==null) for (const t of same) if (t.id!==s.id && t.activity!==s.activity && !s.allowedCompanionIds.includes(t.id))
      warnings.push(`${s.id}: ${t.id} is not an allowed companion`);
  }
  for (let i=0;i<sections.length;i++) for (let j=i+1;j<sections.length;j++) {
    const a=sections[i]!,b=sections[j]!;
    if (a.subject===b.subject&&a.course===b.course&&a.activity===b.activity)
      warnings.push(`Multiple ${a.activity} sections selected for ${a.subject} ${a.course}`);
    let overlap=false;
    for (const x of a.meetings) for (const y of b.meetings) {
      if (x.timeZone!==y.timeZone) {warnings.push(`${a.id}/${b.id}: mixed time zones require manual verification`);continue;}
      if (x.startMinute<y.endMinute&&y.startMinute<x.endMinute&&shareActualDate(x,y)) overlap=true;
    }
    if (overlap) conflicts.push({left:a.id,right:b.id,kind:'meeting_overlap'});
  }
  return {conflicts,warnings:[...new Set(warnings)],personalEligibility:'unknown',
    verdict:conflicts.length?'conflicts_found':warnings.length?'needs_verification':'no_meeting_conflicts',
    note:'Final exams, travel time, registration eligibility, and rules absent from source data are not verified.'};
}
