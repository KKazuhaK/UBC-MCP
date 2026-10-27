# UBC MCP

UBC course discovery and registration planning as a standalone MCP server that
works with any standard MCP client. No hosting platform, account service or
hardcoded server address is required. Independent project; not affiliated with
UBC or Workday.

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
`dist/cli.js` as its argument. No public-source API key is required. For
example, in a client that uses the common `mcpServers` JSON format:

```json
{"mcpServers":{"ubc":{"command":"node","args":["/absolute/path/to/dist/cli.js"]}}}
```

A stdio container image (`Dockerfile`, published by the `MCP server image`
workflow as `ghcr.io/kkazuhak/ubc-mcp` once a release is tagged) runs with
`docker run -i --rm`.
`node dist/cli.js --version` prints the package version, which is read from
`package.json` (a single source also used by the connector's `/healthz`).

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

## Connect a personal snapshot (local / administrative tools)

For local verification, set `UBC_PROFILE=personal` and `UBC_SNAPSHOT_FILE` to an
absolute private JSON file path. Never point a shared Hub service at an
individual's file.

For multi-user use, start the connector with `npm run connector`. It needs no
platform: `GET /healthz` returns `{"ok":true,"version":...}` and the bearer-token
snapshot API works with the CLI alone. It binds
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

The extension has no built-in server address. Load the `extension/` folder as an unpacked Chrome extension, or build and load `extension-firefox/` for Firefox. Automatic synchronization requires user-granted host access to UBC Workday and the server address you enter (see the optional MCPHub section). Without a server, use the offline export and `push` flow below. It does not read passwords or cookies.
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

Keep the public profile lightweight; run the connector in an isolated container
if personal use is enabled. Do not mount its data directory or encryption key
into any aggregator or client container. Platform-specific deployment is in the
optional section below.

```sh
npm test
npm run test:protocol
npm run test:smoke   # standalone stdio server + connector, no platform, offline
npm run test:live
npm run build:extension
```

The live suite makes bounded public read requests; the default suite is offline.
No test loads personal Workday cookies or sends a registration request.

### Connector Docker deployment

See [the container deployment guide](deploy/selfhost/README.md) for automated multi-architecture images, controlled upgrades, persistent data migration and rollback. This deploys the connector independently of MCPHub.

## Optional: MCPHub integration

Everything here is optional and disabled by default. The MCP server and the
connector core never depend on it. The integration is one adapter module per
mode (`src/connector/adapters/mcphub-oauth.ts`, and the deprecated cookie-based
`mcphub.ts`) selected by configuration. The variables below apply to the
cookie-based `mcphub` adapter; `mcphub-oauth` has its own set, listed in the next section:

| Variable | Meaning |
| --- | --- |
| `UBC_PLATFORM_ADAPTER` | `mcphub-oauth` (recommended, see [Connecting to MCPHub](#connecting-to-mcphub-oauth)) or `mcphub` (**deprecated**, forwards the user's Hub session cookie); `none` disables explicitly (wins over the legacy variables). Unset with none of the variables below set: off, and `/ubc/*` return 404. |
| `UBC_PUBLIC_ORIGIN` | Required with the adapter: HTTPS origin on which users reach the connector's `/ubc/` page. |
| `UBC_PLATFORM_URL` | Hub base URL for API calls. Defaults to `UBC_PUBLIC_ORIGIN`. `UBC_HUB_URL` is a deprecated alias. |
| `UBC_PLATFORM_SERVER_NAME` | Name of the Hub server entry that holds the user's credential. Default `ubc-personal`. |

Server names must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`.

### Connecting to MCPHub (OAuth)

`UBC_PLATFORM_ADAPTER=mcphub-oauth` connects a user's snapshots to MCPHub with
standard OAuth 2.1 (authorization code + PKCE S256) instead of forwarding the
user's MCPHub session cookie. The connector never reads, forwards or relies on
MCPHub cookies, requests only the scope `credentials:write:<server name>`, uses
the access token once and discards it. Default remains: no adapter.

**MCPHub admin steps**

1. Register the connector as an OAuth client in MCPHub as a **public client (no
   secret)**: PKCE S256 is what protects the flow. Redirect URI:
   `${UBC_PUBLIC_ORIGIN}/ubc/oauth/callback`
   (for example `https://hub.example.com/ubc/oauth/callback`). Do not register a
   confidential client until you run an MCPHub that contains the fix
   "fix: let confidential clients complete the authorization code flow"; older
   versions cannot complete `/oauth/authorize` for confidential clients.
2. There is no dashboard control for `credentialWriteClients`; set it with the
   administrator API. The server update replaces the whole server config, so read it,
   add the field, and send it back. The example uses an all-access system bearer key
   in `Authorization`; with a dashboard session token, send it as `x-auth-token`
   instead. The `jq` step adds the client to any ids already listed:

   ```sh
   HUB=https://hub.example.com; NAME=ubc-personal
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$HUB/api/servers/$NAME" \
     | jq '{config: (.data.config // .data | .credentialWriteClients = (((.credentialWriteClients // []) + ["ubc-connector"]) | unique))}' \
     | curl -s -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
         -d @- "$HUB/api/servers/$NAME"
   ```

   Check the response of the first call for the exact shape on your MCPHub version;
   the PUT body is `{"config": { ...full server config..., "credentialWriteClients": ["<client id>"] }}`.
   Before sending it back, make sure the first call returned real values rather than
   masked placeholders for any secret headers or environment variables; writing a
   masked value back would replace the real one. If they are masked, add the field
   in the server's entry in `mcp_settings.json` instead (JSON mode).
3. The `ubc-personal` server must be visible (shared or public) to the users who
   connect, and must define the `env.UBC_CONNECTOR_TOKEN` credential. The scoped
   token never acts as an administrator, so it cannot see a private server.
4. If `UBC_PLATFORM_URL` is an internal address (for example `http://mcphub:3000`),
   configure MCPHub's public base URL (`install.baseUrl` in the system config, or the
   `INSTALL_BASE_URL` environment variable). MCPHub builds the endpoints in its
   discovery document from it; without it the advertised `authorization_endpoint`
   would be the internal address, which browsers cannot reach. The connector logs
   a warning on first use when the advertised authorization host differs from
   `UBC_PLATFORM_URL` and is not https.

Limitations: MCPHub's custom bearer header name (`routing.bearerAuthHeaderName`) and
base paths are not supported by this adapter yet; it sends `Authorization: Bearer` and
uses `/api/credentials/<server>` and `/oauth/*` from the discovery document as served.

**Connector configuration** (validated at startup; a missing or invalid value stops the process with a clear message)

| Variable | Meaning |
| --- | --- |
| `UBC_PLATFORM_ADAPTER` | `mcphub-oauth` |
| `UBC_PUBLIC_ORIGIN` | Required. Origin users reach `/ubc/` on: `https://...` (plain `http://` only for `localhost`, `127.0.0.1`, `[::1]`). No path. |
| `UBC_PLATFORM_URL` | Required. MCPHub base URL. Used for `/.well-known/oauth-authorization-server`, `/api/credentials/<server>`, and (re-based onto this host) the token and userinfo endpoints. Use `https`; plain `http` only on a trusted private network (a warning is logged). |
| `UBC_OAUTH_CLIENT_ID` | Required. The OAuth client id registered in MCPHub. |
| `UBC_OAUTH_CLIENT_SECRET` | Optional; leave unset (public client with PKCE). Only for MCPHub versions that support confidential clients in the authorization code flow ("fix: let confidential clients complete the authorization code flow"). If set, sent as `client_secret_post`, or HTTP Basic when MCPHub advertises only `client_secret_basic`. |
| `UBC_PLATFORM_SERVER_NAME` | MCPHub server entry holding the credential. Default `ubc-personal`; same validation as the cookie adapter. |
| `UBC_SESSION_SECRET` | Required, at least 32 bytes (for example `openssl rand -base64 48`). Signs the connector's own cookies. Changing it signs everyone out of the connector page, nothing else. |

**Flow**

1. On `/ubc/` the user clicks **Connect with MCPHub**. `/ubc/oauth/start` creates
   a random `state` and PKCE verifier, stores them in a short-lived (10 minute)
   signed `HttpOnly` `SameSite=Lax` cookie (`Secure` unless the origin is
   loopback http) and redirects to MCPHub's authorization endpoint.
2. MCPHub redirects to `/ubc/oauth/callback`. The connector checks the signed
   cookie and `state` (single use), exchanges the code with the PKCE verifier,
   and calls `userinfo` to learn the MCPHub username (`sub`).
3. It finds or creates the connector account for that username (the same account
   model as the cookie adapter, so existing users keep their snapshots), then
   `PUT`s that account's READ token to `/api/credentials/<server>` with the access
   token as Bearer. The access token is then dropped.
4. The connector sets its own signed session cookie (account id, **15 minutes**: it is only needed to finish pairing; after that, connect again from the page) and
   shows the page with a pairing code for the extension. The extension's
   "Connect with MCPHub" works as before.
5. **Disconnect** requires a fresh authorization: the page starts the flow with
   `intent=disconnect`; after MCPHub confirms the same user, the callback deletes
   the credential on MCPHub and revokes the connector binding and snapshots.
   Connector revocation always wins if the MCPHub delete fails. **Forget this
   browser** only clears the connector session cookie.

All state-changing calls from the page need the connector session plus a CSRF
token (synchronizer token, sent as `X-CSRF-Token`) and a same-origin request.
MCPHub error bodies are never shown or logged (on an `error=` redirect only the standard error code such as `invalid_scope`, `invalid_client` or `access_denied` is logged, so operators can tell misconfiguration from a user declining); users see a short message, and
tokens, codes, verifiers and credential values are never logged.

Proxy note: the connector only looks at its own `ubc_session` and `ubc_oauth`
cookies. If you want to be strict, forward only those to `/ubc/` in the reverse
proxy instead of the whole `Cookie` header.

### Upgrading

- **New variables:** `UBC_PLATFORM_ADAPTER` (`mcphub` or `none`), `UBC_PLATFORM_URL`
  (replaces `UBC_HUB_URL`, which still works) and `UBC_PLATFORM_SERVER_NAME`.
  `UBC_PUBLIC_ORIGIN` is unchanged.
- **Existing Hub deployments keep working.** If `UBC_PLATFORM_ADAPTER` is unset but
  `UBC_PUBLIC_ORIGIN` is set (as before), the connector enables the mcphub
  adapter automatically and logs a deprecation warning. Set
  `UBC_PLATFORM_ADAPTER=mcphub` explicitly; automatic enabling will be removed later.
  A stray `UBC_HUB_URL` without `UBC_PUBLIC_ORIGIN` is ignored with a warning, as before;
  with neither set the connector runs without an adapter.
- **Switching from `mcphub` (cookie) to `mcphub-oauth`:** register the OAuth client
  and add its id to `credentialWriteClients` on MCPHub first (see above), then
  change `UBC_PLATFORM_ADAPTER=mcphub-oauth` and add `UBC_PLATFORM_URL`,
  `UBC_PUBLIC_ORIGIN` (unchanged), `UBC_OAUTH_CLIENT_ID`, `UBC_SESSION_SECRET`
  (and optionally `UBC_OAUTH_CLIENT_SECRET`) and restart. The database is
  untouched: accounts are keyed by the MCPHub username in both modes, so existing
  users keep their binding, snapshots and extension credentials. Users click
  **Connect with MCPHub** once on `/ubc/` to authorize; the READ credential stored
  in MCPHub is rewritten with the same token. The cookie routes
  (`/ubc/api/connect`, `/ubc/api/disconnect`) do not exist in the new mode. Roll
  back by switching the variable back.
- **Deprecation:** the cookie-based `mcphub` adapter logs a warning at startup and
  will be removed in a future release. Automatic enabling from `UBC_PUBLIC_ORIGIN` alone is also deprecated.
- **Version:** the version now comes from `package.json` (`--version`, MCP server info,
  `/healthz`, User-Agent). `/healthz` returns `{"ok":true,"version":"..."}`.
- **Extension first run:** no server address is built in; the field starts empty and
  you enter your own HTTPS address. Connections made with 0.4.x keep their stored
  origin. A pre-0.4 connection (token without an origin) is migrated only by
  official builds (`npm run build:extension:release`, `UBC_RELEASE=official`), which
  embed the origin from `release/extension.json`; dev and fork builds embed nothing.
  If it cannot be resolved the extension keeps the token under another key and shows
  "Please reconnect"; it is removed after a new connection succeeds or on Forget.
- **Images:** the stdio server image is published as `ghcr.io/kkazuhak/ubc-mcp` by
  the `MCP server image` workflow. Release tags must equal `v` + the `package.json`
  version or the workflows fail. As in the connector workflow, every `v*` tag (stable or
  pre-release) also moves the `beta` tag; only stable tags move `latest`.

### Self-service connection (alpha.2)

With the optional self-service routes deployed, enter your own MCPHub HTTPS origin in the extension, grant access, and approve the connection in Hub. The extension automatically opens a temporary background registration page and syncs it every 15 minutes while the browser and Workday session remain available. Recognized course-search pages are synced while open. A manual sync button and offline JSON export remain available.

The connection page calls existing Hub APIs as the signed-in user to save only
that user's READ credential. It does not change Hub source, server configuration
or permissions. Hub access rules still apply: each user must be allowed to access the configured Hub server (`ubc-personal` by default).

The extension requests local storage and optional access to the user-selected Hub origin and UBC Workday, in addition to activeTab/scripting/downloads. It stores the UPLOAD credential
in extension-local trusted-context storage, never browser sync storage. Pairing
codes must be kept private. Forgetting the extension's local connection does not
revoke the server credential; use Disconnect on the connection page to revoke all
credentials and delete current snapshots. Historical backups have separate retention.

### Connect the extension through your MCPHub

Extension 0.4.0 and connector alpha.5 support **Connect with MCPHub** and automatic sync of supported open pages. New installations
start with an empty server field. Enter your own MCPHub HTTPS origin, allow access
to that origin, sign in there, and approve the extension connection. No token or
pairing code needs to be copied. The connection persists in local extension
storage across normal browser restarts. Firefox still requires a signed install
for the extension itself to survive a restart.

Only `/ubc/` needs to be proxied to the connector on that Hub origin, alongside
`/v1/snapshots`; no Hub code, identity-provider setup or `/api/` route changes are
needed. The connector verifies the current Hub session and existing access to the configured
Hub server before issuing the upload-only credential. This is session reuse rather
than a new OAuth server (this is the deprecated `mcphub` adapter; prefer `mcphub-oauth`). An outdated connector is reported before authorization.

Credentials remain bound to their original origin when switching servers. Legacy
0.2.x connections remain bound to their original deployment; they are never
silently reassigned to a newly entered origin. Manual code pairing remains an
advanced fallback. The extension syncs registrations through a temporary background Workday tab every 15 minutes, plus recognized open course-search pages. A manual sync button and a pause control are available. It does not fetch the full catalog.
