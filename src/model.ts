import * as z from 'zod/v4';

export const Campus = z.enum(['UBCV', 'UBCO']);
export type Campus = z.infer<typeof Campus>;
export const Subject = z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/);
export const CourseNumber = z.string().trim().toUpperCase().regex(/^\d{3}[A-Z]?$/);
export const YearSession = z.string().regex(/^20\d{2}[WS]$/);
const text = z.string().max(8000);
const id = z.string().min(1).max(160);
const count = z.number().int().min(0).max(1_000_000).nullable();
export const Meeting = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  startDate: z.iso.date(), endDate: z.iso.date(),
  timeZone: z.enum(['America/Vancouver', 'America/Kelowna']),
  location: text.nullable(),
}).strict().refine(m => m.endMinute > m.startMinute && m.endDate >= m.startDate, 'Invalid meeting range');

export const Section = z.object({
  id, subject: Subject, course: CourseNumber, code: id, title: text,
  activity: z.enum(['lecture', 'lab', 'tutorial', 'discussion', 'seminar', 'other']),
  instructors: z.array(z.string().max(300)).max(30),
  registrationStatusRaw: z.string().max(300).nullable(),
  capacity: count, enrolled: count, seatsAvailable: count,
  waitlistCapacity: count, waitlistCount: count,
  reservedSeatsAvailable: count, restrictions: text.nullable(),
  unreservedSeatsAvailable: count.default(null),
  reservedSeatRules: z.array(z.object({rule:text,available:count,capacity:count}).strict()).max(100).default([]),
  scheduleKind: z.enum(['scheduled', 'asynchronous', 'unknown']),
  meetings: z.array(Meeting).max(40),
  // Null means that component compatibility has not been verified.
  allowedCompanionIds: z.array(id).max(500).nullable(),
  requiredActivities: z.array(z.string().max(100)).max(15).nullable(),
  observedAt: z.iso.datetime(),
}).strict().refine(s => s.scheduleKind !== 'scheduled' || s.meetings.length > 0,
  'A scheduled section needs meeting data');
export type Section = z.infer<typeof Section>;

export const Snapshot = z.object({
  schemaVersion: z.literal(1), campus: Campus,
  kind: z.enum(['sections','registrations']).default('sections'),
  academicPeriod: z.object({id, label: id, yearSession: YearSession, term: z.enum(['1','2','full','summer'])}).strict(),
  capturedAt: z.iso.datetime(),
  source: z.enum(['workday-browser', 'workday-export', 'academic-api']),
  // A snapshot is a bounded observation, never proof of full-catalog coverage.
  coverage: z.object({subjects: z.array(Subject).max(400), complete: z.boolean()}).strict(),
  sections: z.array(Section).max(5000),
  enrollments: z.array(z.object({sectionId: id, state: z.enum(['enrolled', 'waitlisted'])}).strict()).max(300).nullable(),
}).strict().superRefine((s, ctx) => {
  const ids = new Set<string>();
  for (const section of s.sections) {
    if (ids.has(section.id)) ctx.addIssue({code: 'custom', message: 'Duplicate section ID'});
    ids.add(section.id);
    if (Date.parse(section.observedAt) > Date.parse(s.capturedAt))
      ctx.addIssue({code:'custom', message:'Section observation cannot be newer than snapshot'});
  }
  for (const e of s.enrollments ?? []) if (!ids.has(e.sectionId))
    ctx.addIssue({code:'custom', message:'Enrollment refers to a section absent from snapshot'});
});
export type Snapshot = z.infer<typeof Snapshot>;

export function parseSnapshot(value: unknown, now = Date.now()): Snapshot {
  const snapshot = Snapshot.parse(value);
  if (Date.parse(snapshot.capturedAt) > now + 60_000) throw new Error('Snapshot timestamp is in the future');
  return snapshot;
}

export function freshness(observedAt: string, now = Date.now()) {
  const ageSeconds = Math.max(0, Math.floor((now - Date.parse(observedAt)) / 1000));
  return {observedAt, ageSeconds, stale: ageSeconds > 300, kind: 'snapshot' as const};
}

export function registrationState(raw: string | null): 'open'|'waitlist'|'closed'|'unknown' {
  const s = raw?.trim().toLowerCase();
  if (s === 'open') return 'open';
  if (s === 'waitlist' || s === 'waitlisted') return 'waitlist';
  if (s === 'closed' || s === 'full') return 'closed';
  return 'unknown';
}

export function availability(s: Section, now = Date.now()) {
  return {...s, registrationState: registrationState(s.registrationStatusRaw),
    freshness: freshness(s.observedAt, now), personalEligibility: 'unknown',
    note: 'Seat availability does not establish your eligibility or an offer of a seat.'};
}
