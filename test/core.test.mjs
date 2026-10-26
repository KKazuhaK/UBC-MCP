import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSnapshot,freshness,availability} from '../dist/model.js';
import {checkSchedule} from '../dist/schedule.js';
import {PublicHttp} from '../dist/http.js';
import {parseCourses,parseSubjects} from '../dist/providers/catalog.js';
import {now,section,snapshot} from './fixtures.mjs';

test('unknown counts remain null and seats never establish personal eligibility',()=>{
  const s=availability(section({seatsAvailable:null,reservedSeatsAvailable:10}),now);
  assert.equal(s.seatsAvailable,null);assert.equal(s.personalEligibility,'unknown');
});
test('five-minute age uses original observation time',()=>{
  assert.equal(freshness('2026-10-26T13:54:59Z',now).stale,true);
  assert.equal(freshness('2026-10-26T13:55:00Z',now).stale,false);
});
test('reject future, duplicate and inconsistent snapshots',()=>{
  assert.throws(()=>parseSnapshot(snapshot(),now-120000));
  assert.throws(()=>parseSnapshot(snapshot({sections:[section(),section()]}),now));
  assert.throws(()=>parseSnapshot(snapshot({enrollments:[{sectionId:'missing',state:'enrolled'}]}),now));
  assert.throws(()=>parseSnapshot(snapshot({sections:[section({observedAt:'2026-10-26T14:00:01Z'})]}),now));
});
test('detect actual overlapping meetings',()=>{
  const result=checkSchedule([section(),section({id:'MATH-101',subject:'MATH',course:'101'})],now);
  assert.equal(result.conflicts.length,1);assert.equal(result.verdict,'conflicts_found');
});
test('same weekday/time in nonoverlapping date ranges is not a conflict',()=>{
  const second=section({id:'MATH-101',subject:'MATH',course:'101'});
  second.meetings[0].startDate='2027-01-05';second.meetings[0].endDate='2027-04-09';
  assert.equal(checkSchedule([section(),second],now).conflicts.length,0);
});
test('date intersection must actually contain a shared weekday',()=>{
  const a=section(),b=section({id:'MATH-101',subject:'MATH',course:'101'});
  for(const s of [a,b]){s.meetings[0].startDate='2026-10-27';s.meetings[0].endDate='2026-10-27';s.meetings[0].weekdays=[1];}
  assert.equal(checkSchedule([a,b],now).conflicts.length,0);
});
test('adjacent meetings do not overlap',()=>{
  const b=section({id:'MATH-101',subject:'MATH',course:'101'});b.meetings[0].startMinute=660;b.meetings[0].endMinute=720;
  assert.equal(checkSchedule([section(),b],now).conflicts.length,0);
});
test('TBA and unknown component rules never return complete validation',()=>{
  const r=checkSchedule([section({scheduleKind:'unknown',meetings:[]})],now);
  assert.equal(r.verdict,'needs_verification');assert.ok(r.warnings.some(w=>w.includes('unknown')));
});
test('missing companion and incompatible lab are exposed',()=>{
  const a=section({requiredActivities:['lecture','lab'],allowedCompanionIds:[]});
  assert.ok(checkSchedule([a],now).warnings.some(w=>w.includes('missing required lab')));
  const lab=section({id:'lab-1',activity:'lab',scheduleKind:'asynchronous',meetings:[]});
  assert.ok(checkSchedule([a,lab],now).warnings.some(w=>w.includes('not an allowed companion')));
});
test('catalog parsing preserves exact prerequisite text and campus',()=>{
  const html='<article class="node--type-course"><h3>CPSC_V 210 (4) <strong>Software Construction</strong></h3><p>Design. Prerequisite: One of CPSC 107, CPSC 110. Corequisite: MATH 100.</p></article>';
  const c=parseCourses(html,'UBCV','CPSC','https://vancouver.calendar.ubc.ca/course-descriptions/subject/cpscv')[0];
  assert.equal(c.prerequisites,'One of CPSC 107, CPSC 110.');assert.equal(c.corequisites,'MATH 100.');
  assert.throws(()=>parseCourses('<html>Blocked</html>','UBCV','CPSC','url'));
});
test('catalog cannot inject external subject URLs',()=>{
  assert.throws(()=>parseSubjects('<a href="https://example.org/course-descriptions/subject/cpscv">CPSC_V - Computer Science</a>','UBCV'));
});
test('public requests are allowlisted and cached without advancing timestamps',async()=>{
  let requests=0;
  const h=new PublicHttp(async()=>{requests++;return new Response('[]');});
  await assert.rejects(()=>h.get('https://127.0.0.1/private'));
  const a=await h.get('https://ubcgrades.com/api/test'),b=await h.get('https://ubcgrades.com/api/test');
  assert.equal(requests,1);assert.equal(a.fetchedAt,b.fetchedAt);
});
test('oversized public source response is refused',async()=>{
  const h=new PublicHttp(async()=>new Response('x',{headers:{'content-length':'9000000'}}));
  await assert.rejects(()=>h.get('https://ubcgrades.com/api/test'),/size limit/);
});
