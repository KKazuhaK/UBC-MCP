import {load} from 'cheerio';
import {Campus, Subject, CourseNumber} from '../model.js';
import {PublicHttp, SourceError} from '../http.js';
export const ORIGINS = {UBCV:'https://vancouver.calendar.ubc.ca',UBCO:'https://okanagan.calendar.ubc.ca'};
const clean = (s:string) => s.replace(/\s+/g,' ').trim();
export function parseSubjects(html:string, campus:Campus) {
  const $=load(html), found = new Map<string,{code:string;name:string;url:string}>();
  $('a[href]').each((_,el) => {
    const a=$(el), label=clean(a.text()), match=/^([A-Z]{2,6})_[VO]\s*[-–:]\s*(.+)$/.exec(label);
    const href=a.attr('href'); if (!match || !href) return;
    const url=new URL(href,ORIGINS[campus]);
    if (url.origin !== ORIGINS[campus] || !url.pathname.startsWith('/course-descriptions/subject/')) return;
    found.set(match[1]!, {code:match[1]!,name:match[2]!,url:url.href});
  });
  if (!found.size) throw new SourceError('CATALOG_FORMAT_CHANGED','No subject records found in official Calendar');
  return [...found.values()];
}
export function parseCourses(html:string,campus:Campus,subject:string,url:string) {
  const $=load(html); const courses: Array<{campus:Campus;subject:string;course:string;title:string;credits:string;description:string;prerequisites:string|null;corequisites:string|null;url:string}> = [];
  $('article.node--type-course').each((_,el) => {
    const root=$(el), h=root.find('h3').first(), title=clean(h.find('strong').text());
    const m=/^([A-Z]{2,6})_[VO]\s+(\d{3}[A-Z]?)\s+\(([^)]+)\)/.exec(clean(h.text()));
    if (!m || m[1]!==subject || !title) return;
    const description=clean(root.find('p').map((_,p)=>$(p).text()).get().join(' '));
    const prereq=/Prerequisites?:\s*([\s\S]*?)(?=Corequisites?:|$)/i.exec(description)?.[1]?.trim() ?? null;
    const coreq=/Corequisites?:\s*([\s\S]*)/i.exec(description)?.[1]?.trim() ?? null;
    courses.push({campus,subject,course:m[2]!,title,credits:m[3]!,description,prerequisites:prereq,corequisites:coreq,url});
  });
  if (!courses.length) throw new SourceError('CATALOG_FORMAT_CHANGED','No course records found; source may have changed');
  return courses;
}
export class Catalog {
  constructor(private http:PublicHttp) {}
  async subjects(campus:Campus) {
    Campus.parse(campus);
    const url=`${ORIGINS[campus]}/course-descriptions/courses-subject`;
    const r=await this.http.get(url);
    return {source:url,fetchedAt:r.fetchedAt,scope:'catalog_archive',subjects:parseSubjects(r.text,campus)};
  }
  async courses(campus:Campus,subject:string) {
    subject=Subject.parse(subject);
    const index=await this.subjects(campus), entry=index.subjects.find(s=>s.code===subject);
    if (!entry) throw new SourceError('SUBJECT_NOT_FOUND','Subject not found in this campus Calendar');
    const r=await this.http.get(entry.url);
    return {source:entry.url,fetchedAt:r.fetchedAt,scope:'catalog_archive',
      note:'Catalog entries do not prove current offerings or availability.',
      courses:parseCourses(r.text,campus,subject,entry.url)};
  }
  async course(campus:Campus,subject:string,course:string) {
    course=CourseNumber.parse(course);
    const result=await this.courses(campus,subject), record=result.courses.find(c=>c.course===course);
    if (!record) throw new SourceError('COURSE_NOT_FOUND','Course not found in this campus Calendar');
    const {courses,...meta}=result; return {...meta,course:record};
  }
}
