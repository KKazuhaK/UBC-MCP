# UBC MCP

UBC course discovery and registration planning, designed for MCPHub deployment.
Independent project; not affiliated with UBC or Workday.

## Current alpha

The public profile provides seven read-only tools over the official UBC Academic
Calendar and UBCGrades. Vancouver and Okanagan catalog reads and a historical
grade-distribution request have passed live checks.

The personal profile adds four tools over a user's isolated Workday snapshots.
The snapshot connector, encryption, credential separation and revocation have
automated integration coverage. The browser extension can automatically synchronize registrations in a short-lived background Workday tab after the user grants access. It also synchronizes recognized course-search pages while they are open; it does not fetch the full catalog. An installed-browser
registration export passed a real local connector/MCP acceptance run. Hosted self-service connection and registration synchronization have also been exercised with a real browser session. Course-search export acceptance remains outstanding.

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

## Self-service connection (alpha.2)

With the optional self-service routes deployed, enter your own MCPHub HTTPS origin in the extension, grant access, and approve the connection in Hub. The extension automatically opens a temporary background registration page and syncs it every 15 minutes while the browser and Workday session remain available. Recognized course-search pages are synced while open. A manual sync button and offline JSON export remain available.

The connection page calls existing Hub APIs as the signed-in user to save only
that user's READ credential. It does not change Hub source, server configuration
or permissions. Hub access rules still apply: each user must be allowed to access the `ubc-personal` service.

The extension requests local storage and optional access to the user-selected Hub origin and UBC Workday, in addition to activeTab/scripting/downloads. It stores the UPLOAD credential
in extension-local trusted-context storage, never browser sync storage. Pairing
codes must be kept private. Forgetting the extension's local connection does not
revoke the server credential; use Disconnect on the connection page to revoke all
credentials and delete current snapshots. Historical backups have separate retention.

## Connect a personal snapshot (local / administrative tools)

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

## Firefox status

Extension 0.2.3 prepares Firefox support and fixes startup stuck at Checking.
For a Firefox submission build, run npm run build:firefox. See
[signing preparation](docs/firefox-publishing.md) and
[privacy](docs/extension-privacy.md). The ZIP is unsigned; Mozilla signing is
still required for persistent installation. Firefox pairing/upload requires
connector alpha.4, which has not yet been deployed from this workstation.

## Capture Workday course data

```sh
npm run build:extension
```

For a private local acceptance run using an exported registration file:

```sh
node scripts/private-check.mjs /absolute/path/to/private-registrations.json
```

This starts a temporary loopback connector, checks personal MCP queries and
revocation, prints aggregate results, then removes the temporary encrypted store.
It does not upload the input file to the public Internet or delete the input file.

Load the `extension/` folder as an unpacked Chrome extension, or build and load `extension-firefox/` for Firefox. Automatic synchronization requires user-granted host access to UBC Workday and the selected Hub. It does not read passwords or cookies.
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
Registration snapshots are refreshed through a temporary background Workday tab; course-search snapshots cover recognized open pages only.

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
run the connector in an isolated container if personal use is enabled. Do not
mount its data directory or encryption key into the Hub container.

```sh
npm test
npm run test:protocol
npm run test:live
npm run build:extension
```

The live suite makes bounded public read requests; the default suite is offline.
No test loads personal Workday cookies or sends a registration request.

### Connector Docker deployment

See [the container deployment guide](deploy/selfhost/README.md) for automated multi-architecture images, controlled upgrades, persistent data migration and rollback. This deploys the connector independently of MCPHub.

### Connect the extension through your MCPHub

Extension 0.4.0 and connector alpha.5 support **Connect with MCPHub** and automatic sync of supported open pages. New installations
start with an empty server field. Enter your own MCPHub HTTPS origin, allow access
to that origin, sign in there, and approve the extension connection. No token or
pairing code needs to be copied. The connection persists in local extension
storage across normal browser restarts. Firefox still requires a signed install
for the extension itself to survive a restart.

Only `/ubc/` needs to be proxied to the connector on that Hub origin, alongside
`/v1/snapshots`; no Hub code, identity-provider setup or `/api/` route changes are
needed. The connector verifies the current Hub session and existing `ubc-personal`
access before issuing the upload-only credential. This is session reuse rather
than a new OAuth server. An outdated connector is reported before authorization.

Credentials remain bound to their original origin when switching servers. Legacy
0.2.x connections remain bound to their original deployment; they are never
silently reassigned to a newly entered origin. Manual code pairing remains an
advanced fallback. The extension syncs registrations through a temporary background Workday tab every 15 minutes, plus recognized open course-search pages. A manual sync button and a pause control are available. It does not fetch the full catalog.
