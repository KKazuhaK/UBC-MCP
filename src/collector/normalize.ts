import {parseSnapshot,Section} from '../model.js';
import type {RawCapture,RawCard} from './dom.js';

const activities:Record<string,string>={Lecture:'lecture',Laboratory:'lab',Discussion:'discussion',Tutorial:'tutorial',Seminar:'seminar'};
const pattern=/^([A-Z]{2,6})_([VO]) (\d{3}[A-Z]?)-([A-Z0-9]+) - (.+)$/;
const date=(s:string)=>{const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);if(!m)throw new Error('Unsupported meeting date');return `${m[3]}-${m[1]}-${m[2]}`;};
const clock=(s:string)=>{const m=/^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(s);if(!m)throw new Error('Unsupported meeting time');return (Number(m[1])%12+(m[3]==='PM'?12:0))*60+Number(m[2]);};
const days:Record<string,number>={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7};
export function parseMeeting(raw:string){
  const parts=raw.split('|').map(s=>s.trim());
  const dates=/^(\d{2}\/\d{2}\/\d{4}) - (\d{2}\/\d{2}\/\d{4})$/.exec(parts.at(-1)??'');
  const times=/^(\d{1,2}:\d{2} [AP]M) - (\d{1,2}:\d{2} [AP]M)$/.exec(parts.at(-2)??'');
  const weekdays=(parts.at(-3)??'').split(/\s+/).map(d=>days[d]);
  if(!dates||!times||weekdays.some(d=>!d)||!weekdays.length)throw new Error('Unknown Workday meeting pattern');
  return {weekdays:weekdays as number[],startMinute:clock(times[1]!),endMinute:clock(times[2]!),
    startDate:date(dates[1]!),endDate:date(dates[2]!),timeZone:'America/Vancouver' as const,location:parts.slice(0,-3).join(' | ')};
}
export function normalizeCapture(raw:RawCapture){
  const period=/^(20\d{2})(?:-\d{2})? (Winter|Summer) (?:Term ([12])|Session) \(UBC-([VO])\)$/.exec(raw.periodLabel);
  if(!period)throw new Error('Open Find Course Sections for one explicit campus and academic period');
  const campus=period[4]==='V'?'UBCV':'UBCO',yearSession=`${period[1]}${period[2]==='Winter'?'W':'S'}`;
  const term=period[3]??(period[2]==='Winter'?'full':'summer');
  const cards=new Map<string,RawCard>();
  for(const c of raw.cards)cards.set(c.label,c);
  if(raw.details&&!cards.has(raw.details.label))cards.set(raw.details.label,{label:raw.details.label,summary:'',meetingLabels:[],incompleteMeetings:true,sourceId:null});
  const sections=[];
  for(const card of cards.values()){
    const m=pattern.exec(card.label);if(!m)continue;
    if((m[2]==='V'?'UBCV':'UBCO')!==campus)throw new Error('Mixed campus capture refused');
    const detail=raw.details?.label===card.label?raw.details:null;
    const parts=card.summary.split('|').map(s=>s.trim());
    const counts=/Enrolled\/Capacity:\s*(\d+)\/(\d+)/.exec(card.summary),wait=/Waitlisted\/Waitlist Capacity:\s*(\d+)\/(\d+)/.exec(card.summary);
    const activity=activities[detail?.fields['Instructional Formats']??parts[0]??'']??'other';
    const unreserved=/^(\d+) of (\d+)$/.exec(detail?.fields['Unreserved Seats Available']??'');
    const reserved=/^(\d+) of (\d+)$/.exec(detail?.fields['Reserved Seats Available']??'');
    const rawMeetings=detail?.meetingLabels??card.meetingLabels;
    let meetings:ReturnType<typeof parseMeeting>[]=[];let fullTimes=!!detail||!card.incompleteMeetings;
    try {meetings=rawMeetings.map(parseMeeting);}catch{fullTimes=false;meetings=[];}
    const required=detail?.fields['Other Instructional Formats'];
    const requiredActivities=required?Object.entries(activities).filter(([name])=>required.includes(`${name} (Required)`)).map(([,value])=>value):null;
    sections.push(Section.parse({id:card.sourceId??`${m[1]}_${m[2]} ${m[3]}-${m[4]}`,
      subject:m[1],course:m[3],code:`${m[1]}_${m[2]} ${m[3]}-${m[4]}`,title:m[5],activity,
      instructors:detail?.instructors??[],registrationStatusRaw:detail?.fields['Status']??parts[1]??null,
      capacity:detail?.fields['Total Section Capacity']?Number(detail.fields['Total Section Capacity']):counts?Number(counts[2]):null,
      enrolled:counts?Number(counts[1]):null,seatsAvailable:null,
      waitlistCount:wait?Number(wait[1]):null,waitlistCapacity:wait?Number(wait[2]):null,
      unreservedSeatsAvailable:unreserved?Number(unreserved[1]):null,reservedSeatsAvailable:reserved?Number(reserved[1]):null,
      reservedSeatRules:(detail?.reservedRules??[]).map(r=>({rule:r.rule,available:Number(r.available),capacity:Number(r.capacity)})),
      restrictions:detail?.fields['Eligibility']??(card.summary.includes('Includes Reserved Seats')?'Includes reserved seats; rules not captured':null),
      scheduleKind:fullTimes&&meetings.length?'scheduled':'unknown',meetings,allowedCompanionIds:null,requiredActivities,observedAt:raw.capturedAt}));
  }
  if(!sections.length)throw new Error('No recognizable Workday course sections on this page');
  return parseSnapshot({schemaVersion:1,campus,academicPeriod:{id:`${yearSession}-${term}`,label:raw.periodLabel,yearSession,term},
    capturedAt:raw.capturedAt,source:'workday-browser',coverage:{subjects:[...new Set(sections.map(s=>s.subject))],complete:false},sections,enrollments:null});
}
