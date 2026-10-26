import {parseSnapshot,Section} from '../model.js';
import {parseMeeting} from './normalize.js';
export interface RawRegistration {label:string;periodLabel:string;state:string;activity:string;meetingLabels:string[];instructors:string[];sourceId:string|null;}
export interface RawRegistrations {capturedAt:string;rows:RawRegistration[];}

// Reads only planning columns. The first column contains identity information;
// only its academic-period suffix is matched, and the original value is discarded.
export function extractRegistrationDom():RawRegistrations {
  const clean=(s:string|null|undefined)=>(s??'').replace(/\s+/g,' ').trim();
  const rows:RawRegistration[]=[];
  for(const table of document.querySelectorAll('[role="table"],table')){
    const headers=Array.from(table.querySelectorAll('[role="columnheader"],th')).filter(h=>Number(h.getAttribute('colspan')??1)===1)
      .map(h=>clean(h.textContent).replace('Sort and filter column',''));
    const sectionIndex=headers.indexOf('Section'),statusIndex=headers.indexOf('Registration Status'),
      activityIndex=headers.indexOf('Instructional Format'),meetIndex=headers.indexOf('Meeting Patterns'),instructorIndex=headers.indexOf('Instructor');
    if([sectionIndex,statusIndex,activityIndex,meetIndex].some(i=>i<0))continue;
    let periodLabel='';
    for(const row of table.querySelectorAll('[role="row"],tr')){
      const cells=Array.from(row.querySelectorAll('[role="cell"],td'));if(cells.length!==headers.length)continue;
      // Workday exposes the registration moniker in aria-label/title even when
      // the visible first cell contains only a magnifier icon.
      const first=cells[0];
      const candidates=[first?.textContent,first?.getAttribute('aria-label'),
        ...Array.from(first?.querySelectorAll('[aria-label],[title]')??[]).flatMap(e=>[e.getAttribute('aria-label'),e.getAttribute('title')])];
      const period=candidates.map(value=>clean(value).match(/20\d{2}(?:-\d{2})? (?:Winter|Summer) (?:Term [12]|Session) \(UBC-[VO]\)/)?.[0]).find(Boolean);
      if(period)periodLabel=period;
      const prompt=cells[sectionIndex]?.querySelector('[data-automation-id="promptOption"]');
      const label=clean(prompt?.textContent);if(!/^[A-Z]{2,6}_[VO] \d{3}[A-Z]?-[A-Z0-9]+ - /.test(label))continue;
      const field=(i:number)=>Array.from(cells[i]?.querySelectorAll('[data-automation-id="promptOption"]')??[]).map(p=>clean(p.textContent));
      rows.push({label,periodLabel,state:field(statusIndex)[0]??'',activity:field(activityIndex)[0]??'',
        meetingLabels:Array.from(cells[meetIndex]?.querySelectorAll('[role="link"]')??[]).map(e=>clean(e.textContent)).filter(t=>/^\d{2}\/\d{2}\/\d{4} - /.test(t)),
        instructors:instructorIndex>=0?field(instructorIndex):[],
        sourceId:prompt?.closest('[data-automation-id^="selectedItem_"]')?.getAttribute('data-automation-id')?.replace('selectedItem_','')??null});
    }
  }
  return {capturedAt:new Date().toISOString(),rows};
}
export function normalizeRegistrations(raw:RawRegistrations){
  const groups=new Map<string,RawRegistration[]>();
  for(const row of raw.rows){
    if(!['Registered','Waitlisted','Waitlist'].includes(row.state))continue;
    const entries=groups.get(row.periodLabel)??[];entries.push(row);groups.set(row.periodLabel,entries);
  }
  if(!groups.size)throw new Error('No recognizable registered/waitlisted rows. A missing capture is not an empty schedule.');
  const activities:Record<string,string>={Lecture:'lecture',Laboratory:'lab',Discussion:'discussion',Tutorial:'tutorial',Seminar:'seminar'};
  return [...groups].map(([periodLabel,rows])=>{
    const p=/^(20\d{2})(?:-\d{2})? (Winter|Summer) (?:Term ([12])|Session) \(UBC-([VO])\)$/.exec(periodLabel);
    if(!p)throw new Error('Registration period is missing or ambiguous');
    const campus=p[4]==='V'?'UBCV':'UBCO',yearSession=`${p[1]}${p[2]==='Winter'?'W':'S'}`,term=p[3]??(p[2]==='Winter'?'full':'summer');
    const sections=rows.map(row=>{
      const m=/^([A-Z]{2,6})_([VO]) (\d{3}[A-Z]?)-([A-Z0-9]+) - (.+)$/.exec(row.label);
      if(!m||(m[2]==='V'?'UBCV':'UBCO')!==campus)throw new Error('Mixed or unknown registration campus');
      let meetings:ReturnType<typeof parseMeeting>[]=[];
      try{meetings=row.meetingLabels.map(label=>{
        const parts=label.split('|').map(s=>s.trim());
        const [range,days,time,...location]=parts;return parseMeeting([...location,days,time,range].join(' | '));
      });}catch{meetings=[];}
      return Section.parse({id:row.sourceId??`${m[1]}_${m[2]} ${m[3]}-${m[4]}`,subject:m[1],course:m[3],code:`${m[1]}_${m[2]} ${m[3]}-${m[4]}`,
        title:m[5],activity:activities[row.activity]??'other',instructors:row.instructors,
        registrationStatusRaw:null,capacity:null,enrolled:null,seatsAvailable:null,waitlistCapacity:null,waitlistCount:null,
        reservedSeatsAvailable:null,restrictions:null,scheduleKind:meetings.length?'scheduled':'unknown',meetings,
        allowedCompanionIds:null,requiredActivities:null,observedAt:raw.capturedAt});
    });
    return parseSnapshot({schemaVersion:1,kind:'registrations',campus,academicPeriod:{id:`${yearSession}-${term}`,label:periodLabel,yearSession,term},
      capturedAt:raw.capturedAt,source:'workday-browser',coverage:{subjects:[...new Set(sections.map(s=>s.subject))],complete:false},sections,
      enrollments:rows.map((row,i)=>({sectionId:sections[i]!.id,state:row.state==='Registered'?'enrolled':'waitlisted'}))});
  });
}
