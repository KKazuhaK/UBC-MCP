# UBC MCP

UBC course discovery and registration planning, designed for MCPHub deployment.
Independent project; not affiliated with UBC or Workday.

## Current alpha

The public profile provides seven read-only tools over the official UBC Academic
Calendar and UBCGrades. Vancouver and Okanagan catalog reads and a historical
grade-distribution request have passed live checks.

The personal profile adds four tools over a user's isolated Workday snapshots.
The snapshot connector, encryption, credential separation and revocation have
automated integration coverage. A manual course-capture extension is included.
It captures visible search results and an open section detail dialog; a separate
explicit action captures private registrations from View My Courses. It does not
silently fetch the full catalog or refresh source data. The extension still needs
an installed-browser export/sync acceptance run before broader release.

Workday UI fields were inspected in an authenticated browser on 2026-10-26.
This is evidence of field availability, not evidence of a public Workday API or
an unattended production integration. See [validation](docs/VALIDATION.md).

## Run locally

Requires Node.js 24 or newer.

```sh
npm ci
npm run build
npm start
```

The default transport is stdio. stdout is reserved for MCP protocol messages.
`node dist/cli.js --list-tools` lists the public tools. Public mode reads no
personal environment credentials and cannot expose personal tools.

Configure an MCP client with `node` as the command and the absolute path to
`dist/cli.js` as its argument. No public-source API key is required.

## Tools

| Public | Purpose |
| --- | --- |
| `get_data_status` | Source capabilities, connection state, captured scopes and ages |
| `list_subjects` | Official Calendar subjects for one campus |
| `search_courses` | Search one subject's catalog entries |
| `get_course` | Full description and prerequisite/corequisite text |
| `list_grade_sessions` | Available historical sessions for API v2 or v3 |
| `get_course_grades` | Course and section grade distributions |
| `compare_courses` | Up to five catalog/grade comparisons |

| Personal | Purpose |
| --- | --- |
| `search_sections` | Search captured sections in one exact campus and period |
| `get_section_availability` | Source status, counts, seat pools and observation time |
| `get_my_schedule` | Captured personal registrations, if supplied |
| `check_schedule` | Meeting/date overlaps and available component constraints |

Campus defaults to `UBCV`; pass `UBCO` explicitly for Okanagan. Course arguments
use a subject such as `CPSC` and number such as `110`. Historical sessions use
`2026W`; availability queries require an exact `academicPeriod.id` returned by
`get_data_status`, for example `2026W-2`. Section searches and personal registrations
are stored as separate snapshot kinds; schedule checks can select either kind.
This prevents confusing Winter Term 2
in January 2027 with the 2027 Winter Session.

## Connect a personal snapshot

For local verification, set `UBC_PROFILE=personal` and `UBC_SNAPSHOT_FILE` to an
absolute private JSON file path. Never point a shared Hub service at an
individual's file.

For multi-user use, start the connector with `npm run connector`. It binds
loopback by default. Provision a binding using the local administrative CLI:

```sh
node dist/connector/cli.js create-binding student-label
```

This displays a random binding ID, read token and upload token once. Treat the
output as secret. The read token belongs in that user's Hub Credential slot;
the upload token stays with their local companion. Neither authorizes the other
operation. There is no public administrative HTTP endpoint.

Set `UBC_PROFILE=personal`, operator-controlled `UBC_CONNECTOR_URL` and the
user's `UBC_CONNECTOR_TOKEN` (READ token) in the personal process. Bindings never
come from tool arguments. Missing/revoked credentials never use a shared token.

The connector stores token hashes and AES-256-GCM-encrypted snapshot bodies in
SQLite. Preserve the complete data directory and its encryption key together.
The operator who controls the host and key can decrypt data. Restrict host access
and keep the directory and backups private. Source snapshots exported to the
user's Downloads folder are ordinary plaintext files and need private handling.

```sh
node dist/connector/cli.js revoke BINDING_ID
```

Revocation disables both tokens and removes active snapshots. Revoked data may
remain in historical backups; manage backup retention separately.

## Capture Workday course data

```sh
npm run build:extension
```

Load the `extension/` folder as an unpacked Chrome extension. It requests only
active-tab scripting and downloads, not cookies, persistent host access or passwords.
Log into Workday yourself and complete Duo. Navigate to **Find Course Sections**,
select a specific Winter Term (not the umbrella Winter Session), and search.
Refresh the results before capturing. Open a section detail dialog to include
unreserved/reserved seats, eligibility rules and all date intervals.

Click the extension's **Export course snapshot** button. It captures only DOM
records currently loaded. Coverage is always marked partial. A collapsed
`+N more` meeting list is treated as incomplete; missing meeting data is never
classified as asynchronous. The capture timestamp records the DOM observation,
not an upstream database refresh guarantee. Only the section detail currently
open gains complete meeting/seat-pool fields.

With `UBC_CONNECTOR_URL` and your `UBC_UPLOAD_TOKEN` configured in the local
environment, synchronize the saved file:

```sh
node dist/connector/cli.js push /absolute/path/to/ubc-snapshot.json
```

This explicitly uploads the structured course snapshot to your connector. It
does not upload the browser session, password, cookies or student profile. A push
replaces that binding's existing snapshot for the same campus and period; capture
all desired loaded records together. Older snapshots cannot replace newer ones.
On **View My Courses**, the separate **Export my registrations** action captures
the loaded Registered and Waitlisted rows, grouped into academic periods. It
discards student names/IDs and does not collect grades or financial details.
Keep that export private. The same push command accepts its snapshot array.
Registration snapshots do not replace section-search availability snapshots.
Automatic polling is not implemented in this alpha.

## Interpretation

- Catalog records do not establish current offerings. Full prerequisite text is
  preserved; there is no invented prerequisite tree or official degree audit.
- UBCGrades is historical. `OVERALL` is separate from sections to prevent double
  counting. The selected API version and session are returned with every report.
- Unknown counts remain `null`. Capacity minus enrollment is not substituted for
  unreserved availability. Workday detail fields identify the two seat pools.
- `openOnly` requires an observed Open status, a known positive unreserved/available
  count and an observation no older than five minutes. It does not prove eligibility.
- Source status is preserved separately from normalized status. Unknown states
  remain unknown. Stale snapshots remain inspectable with their original age.
- Schedule checks preserve multiple date intervals, including reading-break gaps.
  Unknown meeting patterns and component rules require manual verification.
  Final exams, travel time and personal eligibility are not inferred.
- Tool text is fenced as untrusted source data. No registration/write tools exist.

## Deploy and validate

See [Hub deployment](deploy/mcphub/README.md). Keep the public profile lightweight;
run the connector separately if personal use is enabled.

```sh
npm test
npm run test:protocol
npm run test:live
npm run build:extension
```

The live suite makes bounded public read requests; the default suite is offline.
No test loads personal Workday cookies or sends a registration request.
