import * as z from 'zod/v4';
import {Campus,Subject,CourseNumber,YearSession,availability,freshness} from './model.js';
import {PublicHttp,SourceError} from './http.js';
import {Catalog} from './providers/catalog.js';
import {Grades} from './providers/grades.js';
import {Personal} from './providers/personal.js';
import {checkSchedule} from './schedule.js';

const campus=Campus.default('UBCV');
const courseFields={campus,subject:Subject,course:CourseNumber};
const periodFields={campus,academicPeriod:z.string().min(1).max(160).describe('Exact academicPeriod.id returned by get_data_status')};
export class Tools {
  readonly http=new PublicHttp();
  readonly catalog=new Catalog(this.http);
  readonly grades=new Grades(this.http);
  constructor(readonly personal:Personal) {}
  private async period(campus:Campus,id:string,kind:'sections'|'registrations'='sections') {
    const all=await this.personal.snapshots();
    const s=all.find(s=>s.campus===campus&&s.academicPeriod.id===id&&s.kind===kind);
    if (!s) throw new SourceError('PERIOD_NOT_CAPTURED','No snapshot for this exact campus and period; inspect get_data_status.');
    return s;
  }
  definitions() {
    const defs = [
      {name:'get_data_status',description:'Check available sources, connection state, observed periods, coverage and data age. No refresh is implied.',schema:z.object({}),run:async()=>{
        let personal:unknown={connected:false};
        if (this.personal.configured()) {
          try {personal={connected:true,periods:(await this.personal.snapshots()).map(s=>({campus:s.campus,
            academicPeriod:s.academicPeriod,kind:s.kind,coverage:s.coverage,sections:s.sections.length,
            freshness:freshness(s.capturedAt),hasPersonalSchedule:s.enrollments!==null}))};}
          catch(e) {personal={connected:false,error:e instanceof SourceError?e.code:'CONNECTION_UNAVAILABLE'};}
        }
        return {publicSources:['UBC Academic Calendar (course archive)','UBCGrades (historical)'],
          personal,cache:this.http.status(),notes:['Availability is a dated snapshot, not guaranteed real time.',
          'Workday page access has to be validated separately for each supported collector version.']};
      }},
      {name:'list_subjects',description:'List official Calendar subject codes for a campus. Courses are catalog records, not current offerings.',schema:z.object({campus}),
        run:async(a:any)=>this.catalog.subjects(a.campus)},
      {name:'search_courses',description:'Search one official Calendar subject by keyword and/or course level. Preserves prerequisite text.',
        schema:z.object({campus,subject:Subject,query:z.string().max(200).optional(),level:z.number().int().min(0).max(9).optional(),limit:z.number().int().min(1).max(50).default(20)}),
        run:async(a:any)=>{const r=await this.catalog.courses(a.campus,a.subject);
          const matched=r.courses.filter(c=>(a.level===undefined||c.course[0]===String(a.level))&&
            (!a.query||`${c.course} ${c.title} ${c.description}`.toLowerCase().includes(a.query.toLowerCase())));
          return {...r,courses:matched.slice(0,a.limit),matched:matched.length,returned:Math.min(a.limit,matched.length),truncated:matched.length>a.limit};}},
      {name:'get_course',description:'Read full official catalog text for a course. Does not establish current offering or personal eligibility.',schema:z.object(courseFields),
        run:async(a:any)=>this.catalog.course(a.campus,a.subject,a.course)},
      {name:'list_grade_sessions',description:'List available historical grade sessions. Use before requesting a session with unknown coverage.',schema:z.object({campus,version:z.union([z.literal(2),z.literal(3)]).default(3)}),
        run:async(a:any)=>this.grades.years(a.campus,a.version)},
      {name:'get_course_grades',description:'Historical UBCGrades reports for a course, separating OVERALL from individual sections. No prediction of grades or current seat counts.',
        schema:z.object({...courseFields,yearSession:YearSession.optional()}),run:async(a:any)=>this.grades.course(a.campus,a.subject,a.course,a.yearSession)},
      {name:'compare_courses',description:'Compare up to five courses using official descriptions and historical grades. Reports individual source failures without inventing data.',
        schema:z.object({campus,courses:z.array(z.object({subject:Subject,course:CourseNumber})).min(2).max(5),yearSession:YearSession.optional()}),
        run:async(a:any)=>({comparisons:await Promise.all(a.courses.map(async(c:any)=>{
          const [catalog,grades]=await Promise.allSettled([this.catalog.course(a.campus,c.subject,c.course),this.grades.course(a.campus,c.subject,c.course,a.yearSession)]);
          return {...c,catalog:catalog.status==='fulfilled'?catalog.value:{error:'Catalog unavailable'},grades:grades.status==='fulfilled'?grades.value:{error:'Grade reports unavailable for selected session'}};
        }))})},
    ];
    if (!this.personal.configured()) return defs;
    return [...defs,
      {name:'search_sections',description:'Search your captured Workday sections in one exact period. openOnly excludes observations older than five minutes. Coverage can be incomplete.',
        schema:z.object({...periodFields,subject:Subject.optional(),course:CourseNumber.optional(),openOnly:z.boolean().default(false),
          days:z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),earliestMinute:z.number().int().min(0).max(1439).optional(),latestMinute:z.number().int().min(1).max(1440).optional(),
          limit:z.number().int().min(1).max(100).default(30)}),
        run:async(a:any)=>{const snap=await this.period(a.campus,a.academicPeriod);
          const selected=snap.sections.map(s=>availability(s)).filter(s=>(!a.subject||s.subject===a.subject)&&(!a.course||s.course===a.course)&&
            (!a.openOnly||(!s.freshness.stale&&s.registrationState==='open'&&
              ((s.unreservedSeatsAvailable!==null&&s.unreservedSeatsAvailable>0)||(s.seatsAvailable!==null&&s.seatsAvailable>0))))&&
            (!(a.days||a.earliestMinute!==undefined||a.latestMinute!==undefined)||
              (s.scheduleKind==='scheduled'&&s.meetings.every(m=>(!a.days||m.weekdays.every(d=>a.days.includes(d)))&&
                (a.earliestMinute===undefined||m.startMinute>=a.earliestMinute)&&(a.latestMinute===undefined||m.endMinute<=a.latestMinute)))));
          return {academicPeriod:snap.academicPeriod,coverage:snap.coverage,sections:selected.slice(0,a.limit),matched:selected.length,truncated:selected.length>a.limit};}},
      {name:'get_section_availability',description:'Return source-observed registration status, counts, restrictions and timestamp. Unknown counts remain null; eligibility stays unknown.',
        schema:z.object({...periodFields,sectionId:z.string().min(1).max(160)}),run:async(a:any)=>{
          const snap=await this.period(a.campus,a.academicPeriod),s=snap.sections.find(s=>s.id===a.sectionId);
          if (!s) throw new SourceError('SECTION_NOT_CAPTURED','Section not present in this snapshot; absence is not proof of cancellation.');
          return {campus:snap.campus,academicPeriod:snap.academicPeriod,source:snap.source,section:availability(s)};
        }},
      {name:'get_my_schedule',description:'Read your captured enrolled and waitlisted sections. A missing capture is not an empty schedule.',
        schema:z.object(periodFields),run:async(a:any)=>{
          const snap=await this.period(a.campus,a.academicPeriod,'registrations');
          if (snap.enrollments===null) throw new SourceError('SCHEDULE_NOT_CAPTURED','Personal registrations have not been captured.');
          return {academicPeriod:snap.academicPeriod,freshness:freshness(snap.capturedAt),
            registrations:snap.enrollments.map(e=>({...e,section:snap.sections.find(s=>s.id===e.sectionId)}))};
        }},
      {name:'check_schedule',description:'Check exact captured sections for actual date/time overlaps and known component rules. Missing times or rules cause an unverified verdict.',
        schema:z.object({...periodFields,kind:z.enum(['sections','registrations']).default('sections'),sectionIds:z.array(z.string().min(1).max(160)).min(1).max(30)}),run:async(a:any)=>{
          const snap=await this.period(a.campus,a.academicPeriod,a.kind);
          const ids=[...new Set<string>(a.sectionIds)],selected=ids.map(id=>snap.sections.find(s=>s.id===id));
          if (selected.some(s=>!s)) throw new SourceError('SECTION_NOT_CAPTURED','Cannot check a schedule with missing section records.');
          return {academicPeriod:snap.academicPeriod,...checkSchedule(selected.filter(s=>s!==undefined))};
        }},
    ];
  }
}
