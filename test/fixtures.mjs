export const now=Date.parse('2026-10-26T14:00:00Z');
export function section(overrides={}){
  return {id:'CPSC_V-110-101',subject:'CPSC',course:'110',code:'CPSC_V 110 101',title:'Computation, Programs, and Programming',
    activity:'lecture',instructors:[],registrationStatusRaw:'Open',capacity:100,enrolled:90,seatsAvailable:10,
    waitlistCapacity:null,waitlistCount:null,reservedSeatsAvailable:null,restrictions:null,
    scheduleKind:'scheduled',meetings:[{weekdays:[1,3,5],startMinute:600,endMinute:660,startDate:'2026-09-08',endDate:'2026-12-07',timeZone:'America/Vancouver',location:null}],
    allowedCompanionIds:null,requiredActivities:null,observedAt:'2026-10-26T13:59:00Z',...overrides};
}
export function snapshot(overrides={}){
  return {schemaVersion:1,kind:'sections',campus:'UBCV',academicPeriod:{id:'2026W-T1',label:'2026-27 Winter Term 1 (UBC-V)',yearSession:'2026W',term:'1'},
    capturedAt:'2026-10-26T14:00:00Z',source:'workday-browser',coverage:{subjects:['CPSC'],complete:false},
    sections:[section()],enrollments:null,...overrides};
}
