import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCapture,parseMeeting} from '../dist/collector/normalize.js';
import {normalizeRegistrations,extractRegistrationDom} from '../dist/collector/registrations.js';
import {parseHTML} from 'linkedom';
function capture(){return {periodLabel:'2026-27 Winter Term 2 (UBC-V)',capturedAt:new Date().toISOString(),
  cards:[{label:'CPSC_V 110-201 - Example Course',sourceId:'15194$test',summary:'Lecture | Open | In Person Learning | 4 Credits | Enrolled/Capacity: 180/250 | Includes Reserved Seats | Waitlisted/Waitlist Capacity: 3/999',
    meetingLabels:['UBCV | Example Building | Tue Thu | 9:30 AM - 11:00 AM | 01/05/2027 - 02/11/2027'],incompleteMeetings:true}],details:null};}
test('summary preserves counts but never infers seats or complete meetings',()=>{
  const s=normalizeCapture(capture()).sections[0];
  assert.equal(s.enrolled,180);assert.equal(s.capacity,250);assert.equal(s.waitlistCount,3);
  assert.equal(s.seatsAvailable,null);assert.equal(s.unreservedSeatsAvailable,null);assert.equal(s.scheduleKind,'unknown');
});
test('detail captures seat pools and all reading-break date ranges',()=>{
  const raw=capture();raw.details={label:raw.cards[0].label,
    fields:{'Status':'Open','Total Section Capacity':'250','Unreserved Seats Available':'60 of 220','Reserved Seats Available':'10 of 30','Other Instructional Formats':'Laboratory (Required)','Instructional Formats':'Lecture'},
    meetingLabels:[...raw.cards[0].meetingLabels,'UBCV | Example Building | Tue Thu | 9:30 AM - 11:00 AM | 02/23/2027 - 04/08/2027'],
    instructors:['Example Instructor'],reservedRules:[{rule:'Example program',available:'10',capacity:'30'}]};
  const s=normalizeCapture(raw).sections[0];assert.equal(s.unreservedSeatsAvailable,60);assert.equal(s.reservedSeatsAvailable,10);
  assert.equal(s.seatsAvailable,null);assert.equal(s.meetings.length,2);assert.equal(s.scheduleKind,'scheduled');
  assert.deepEqual(s.requiredActivities,['lab']);assert.equal(s.reservedSeatRules.length,1);
});
test('mixed campus and malformed period captures are refused',()=>{
  const raw=capture();raw.periodLabel='2026-27 Winter Term 2 (UBC-O)';assert.throws(()=>normalizeCapture(raw),/Mixed campus/);
  raw.periodLabel='unknown';assert.throws(()=>normalizeCapture(raw),/academic period/);
});
test('missing or unsupported meeting formats do not become asynchronous',()=>{
  const raw=capture();raw.cards[0].meetingLabels=['TBA'];raw.cards[0].incompleteMeetings=false;
  const s=normalizeCapture(raw).sections[0];assert.equal(s.scheduleKind,'unknown');assert.deepEqual(s.meetings,[]);
});
test('date and time normalization includes noon/midnight',()=>{
  const m=parseMeeting('UBCV | Room | Mon | 12:00 PM - 1:00 PM | 01/11/2027 - 02/08/2027');
  assert.equal(m.startMinute,720);assert.equal(m.endMinute,780);assert.equal(m.startDate,'2027-01-11');
});
test('private registrations split periods without inventing availability',()=>{
  const base={label:'CPSC_V 110-201 - Example Course',periodLabel:'2026-27 Winter Term 2 (UBC-V)',state:'Registered',activity:'Lecture',
    meetingLabels:['01/05/2027 - 02/11/2027 | Tue Thu | 9:30 AM - 11:00 AM | UBCV | Example Building'],instructors:['Example Instructor'],sourceId:'15194$test'};
  const snapshots=normalizeRegistrations({capturedAt:new Date().toISOString(),rows:[base,{...base,label:'MATH_V 100-101 - Example Mathematics',sourceId:'15194$test2',state:'Waitlisted',periodLabel:'2026-27 Winter Term 1 (UBC-V)'}]});
  assert.equal(snapshots.length,2);assert.equal(snapshots[0].kind,'registrations');
  assert.equal(snapshots[0].enrollments[0].state,'enrolled');assert.equal(snapshots[1].enrollments[0].state,'waitlisted');
  assert.equal(snapshots[0].sections[0].registrationStatusRaw,null);assert.equal(snapshots[0].sections[0].seatsAvailable,null);
  assert.equal(snapshots[0].sections[0].meetings[0].startMinute,570);
});
test('empty registration capture is not interpreted as no registrations',()=>{
  assert.throws(()=>normalizeRegistrations({capturedAt:new Date().toISOString(),rows:[]}),/not an empty schedule/);
});
test('DOM collector reads an accessible period label and discards identity',()=>{
  const headers=['','Course Listing','Actions','Credits','Grading Basis','Section','Registration Status','Instructional Format','Delivery Mode','Meeting Patterns','Instructor','Start Date','End Date'];
  const cells=['<button aria-label="Private Student (12345678) - CPSC_V 110 - Example - 2026-27 Winter Term 2 (UBC-V) | View More"></button>','','','','',
    '<div data-automation-id="selectedItem_15194$example"><span data-automation-id="promptOption">CPSC_V 110-201 - Example</span></div>',
    '<span data-automation-id="promptOption">Registered</span>','<span data-automation-id="promptOption">Lecture</span>','',
    '<a role="link">01/05/2027 - 02/11/2027 | Tue Thu | 9:30 AM - 11:00 AM | UBCV | Example Building</a>','','',''];
  const {document}=parseHTML(`<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr></tbody></table>`);
  globalThis.document=document;
  try{const raw=extractRegistrationDom();assert.equal(raw.rows[0].periodLabel,'2026-27 Winter Term 2 (UBC-V)');
    assert.equal(raw.rows[0].sourceId,'15194$example');assert.equal(JSON.stringify(raw).includes('Private Student'),false);assert.equal(JSON.stringify(raw).includes('12345678'),false);
    assert.equal(normalizeRegistrations(raw)[0].enrollments.length,1);
  }finally{delete globalThis.document;}
});
