# Validation and release state

Checked on 2026-10-26. A field confirmed in the UI does not establish an API
contract. Runtime observations and personal snapshots are excluded from Git.

## A — Workday feasibility

Authenticated, read-only browser inspection confirmed these fields in Vancouver
2026-27 Winter Term 2:

- Search cards: section code/title, instructional format, registration status,
  delivery mode, credits, enrolled/capacity, waitlisted/waitlist capacity and
  indication of reserved seats.
- Section detail: instructor, academic period, total section capacity, unreserved
  seats available, reserved seats available, eligibility text, required other
  instructional formats, full meeting patterns and the reserved-seat eligibility table.
- Open, Waitlist and Closed states appeared in actual course results.
- Meeting patterns split around reading break. The first card interval alone
  is insufficient for full-term conflict analysis.
- An umbrella Winter Session returned no results in this report, whereas the
  specific Winter Term 2 returned course sections. A blank result is not treated
  as proof that no courses exist.

No registration, saved-schedule change or course modification was performed.
No browser session, password or cookie was extracted. View My Courses was also
inspected: its multi-level table exposes section, registration state, format,
meeting intervals and instructors. The first identity column is excluded from
exports except for extracting the academic-period suffix. Current DOM validation
covers Vancouver only. Installed-extension exports, Okanagan Workday, autonomous
refresh and an approved Academic API connection remain unverified.

## B — Public sources

Live successful reads:

- Vancouver CPSC 210 official Calendar description and prerequisite text.
- Okanagan COSC 111 official Calendar description.
- UBCGrades Vancouver MATH 100, 2022S distribution with individual sections and
  a distinct overall record.
- UBCGrades available historical session list.

## C/D — Code verification

Automated checks cover encrypted storage, two-user isolation, separate upload/read
tokens, immediate revocation, failure on lost encryption keys, anti-replay ordering,
body size limits, public-source allowlisting, source-schema failure, campus/period
scope, preservation of null counts, stale-open filtering, actual-date intersection,
meeting adjacency, unknown components and split meeting-date capture.

The standard MCP client verifies stdio initialization, discovery, a read-only
tool call and input validation. Public live tests are separate from offline tests.
Thirty offline tests pass, including a regression for academic-period labels
stored in aria-label/title rather than visible first-column text.

The installed Chrome extension successfully exported a real registration file.
That private file passed a local acceptance run through upload-token HTTP sync,
encrypted loopback connector, personal stdio MCP discovery, get_my_schedule,
check_schedule, cross-binding isolation and revocation. Only aggregate test
results were printed. The file was not uploaded to an Internet service and is
not included in the repository or releases. Course-search/detail export through
the installed extension still needs its own round trip.

## E/F — Deployment gates

The public alpha package was installed on the deployed Hub as `ubc-public` and
reported version 0.1.0-alpha.1, MCP 2025-11-25 and seven tools. An actual Hub UI
get_course call returned Vancouver CPSC 210 successfully. An actual Hub
get_course_grades call also returned Vancouver MATH 100, 2022S, including
individual sections and a separate OVERALL record. The public entry is visible
to authenticated Hub users; this does not grant anonymous access.

Personal profile: require isolated per-user binding, actual
snapshot synchronization, revoke/rebind validation and a second user's acceptance
test. Do not expose an operator's personal Workday snapshot as a public service.

The current alpha does not include continuous seat monitoring,
self-service binding provisioning, automatic registration, complete degree
auditing or a production SLA. These are explicit outstanding milestones.
