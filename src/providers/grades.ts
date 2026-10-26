import * as z from 'zod/v4';
import {Campus, Subject, CourseNumber, YearSession} from '../model.js';
import {PublicHttp, SourceError} from '../http.js';
const nullableNumber=z.number().finite().nullable();
const Report = z.object({campus:Campus,subject:Subject,course:CourseNumber,
  section:z.string(),year:z.string(),session:z.enum(['W','S']),
  average:nullableNumber,reported:z.number().int().min(0),
  educators:z.string().nullable(),grades:z.record(z.string(),nullableNumber),
  high:nullableNumber.optional(),low:nullableNumber.optional(),median:nullableNumber.optional(),
  course_title:z.string().optional(),detail:z.string().optional(),
});
export class Grades {
  constructor(private http:PublicHttp) {}
  async years(campus:Campus,version:2|3=3) {
    Campus.parse(campus);
    const source=`https://ubcgrades.com/api/v${version}/yearsessions/${campus}`;
    const r=await this.http.get(source);
    const sessions=z.array(YearSession).parse(JSON.parse(r.text));
    return {source,fetchedAt:r.fetchedAt,version,sessions};
  }
  async course(campus:Campus,subject:string,course:string,yearSession?:string) {
    subject=Subject.parse(subject); course=CourseNumber.parse(course);
    const [r3,r2]=await Promise.allSettled([this.years(campus,3),this.years(campus,2)]);
    const v3:{sessions:string[]}=r3.status==='fulfilled'?r3.value:{sessions:[]};
    const v2:{sessions:string[]}=r2.status==='fulfilled'?r2.value:{sessions:[]};
    if (r3.status==='rejected'&&r2.status==='rejected') throw new SourceError('GRADE_SOURCE_UNAVAILABLE','Unable to retrieve grade session lists');
    const selected=yearSession ? YearSession.parse(yearSession) : [...new Set([...v3.sessions,...v2.sessions])].sort().at(-1);
    if (!selected) throw new SourceError('NO_GRADE_DATA','No grade sessions available');
    const version=v3.sessions.includes(selected)?3:v2.sessions.includes(selected)?2:null;
    if (!version) throw new SourceError('NO_GRADE_DATA','No reports for this session; use list_grade_sessions');
    const source=`https://ubcgrades.com/api/v${version}/grades/${campus}/${selected}/${subject}/${course}`;
    const r=await this.http.get(source), reports=z.array(Report).parse(JSON.parse(r.text));
    if (reports.some(p=>p.campus!==campus || p.subject!==subject || p.course!==course || `${p.year}${p.session}`!==selected))
      throw new SourceError('GRADE_SCOPE_MISMATCH','Source returned reports for a different course/session');
    const overall=reports.find(p=>p.section==='OVERALL');
    return {source,fetchedAt:r.fetchedAt,yearSession:selected,version,scope:'historical_grades',
      note:'Historical grades are not current enrollment or a forecast of future performance. OVERALL is not an additional section.',
      overall:overall??null,sections:reports.filter(p=>p.section!=='OVERALL')};
  }
}
