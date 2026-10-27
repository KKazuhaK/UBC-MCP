# Deployment record — 2026-10-26

## Public service

- Hub: https://mcp.kazuhahub.com/
- Server name: `ubc-public`
- Authenticated MCP endpoint: https://mcp.kazuhahub.com/mcp/ubc-public
- Version: `0.1.0-alpha.1`
- Source revision: `b932437`
- Installed from the compiled release `.tgz`, with Node `24.21.0`.
- Transport: stdio child; negotiated MCP `2025-11-25`.
- Visibility: Public to authenticated Hub users.
- Seven tools; all read-only.

Hosted acceptance calls succeeded for `get_course(UBCV, CPSC, 210)` and
`get_course_grades(UBCV, MATH, 100, 2022S)`. Existing Hub definitions were
preserved. The public process has no Workday snapshot or personal token.

## Personal service

The personal connector and eleven-tool stdio profile passed local acceptance
using an installed-extension registration export. No personal file was sent to
the hosted Hub or another Internet service.

The operator reports the hosted connector is deployed in an independent non-root
container on the Hub network, reachable internally at http://ubc-connector:8792.
The HTTPS sync endpoint is https://mcp.kazuhahub.com/v1/snapshots. Its persistent
data directory is /opt/ubc-connector/data and is not mounted into Hub. Hub was not
restarted. Operator-reported synthetic tests passed isolation, token scope,
revocation, recreation persistence and observation-time preservation. These tests
have not been independently repeated from this workstation.

The ubc-personal definition was added through the authenticated Hub UI on
2026-10-26, with private visibility, start-on-demand, the same pinned release and
Node version as public, UBC_PROFILE=personal and the internal connector URL.
UBC_CONNECTOR_TOKEN is a required per-user environment credential slot. No shared
token or snapshot file is configured. The UI confirms an unbound user receives
"Personal credentials required". No production user binding has been supplied,
so eleven-tool discovery, personal queries and two-account Hub isolation remain
pending. No real personal snapshot has been uploaded from this workstation.

The operator also reports the old standalone Anteater and Canvas containers
were stopped; their old domains return 502 while Hub stdio entries remain
independent. This is separate from UBC and is recorded as a reported side effect,
not a validated or requested deployment requirement.

## Package and rollback

Release: https://github.com/KKazuhaK/UBC-MCP/releases/tag/v0.1.0-alpha.1

The release includes the compiled MCP package, unpacked-extension zip and
SHA256SUMS.txt. Release assets are fixed; fixes should use a new version rather
than replacing an asset already installed by Hub. Disable only `ubc-public` to
roll back this initial deployment. Do not modify other server definitions.

## Self-service upgrade prepared locally

Version 0.1.0-alpha.2 implements /ubc/ onboarding using existing Hub session and
per-user credential APIs, plus extension 0.2.0 pairing and preview/upload. No Hub
files, settings or service definitions were changed for this upgrade. Local
synthetic tests cover account isolation, one-use/expiring pairing, revocation,
persistence, credential scope, browser-origin rejection and GUI actions. The
operator still needs to update the isolated connector, enable UBC_PUBLIC_ORIGIN,
and proxy /ubc/ before hosted acceptance. Installed-extension upload and two real
Hub-account acceptance have not been performed. No real registration snapshot
has been uploaded by this upgrade.

## Hosted browser acceptance — 2026-10-26 (America/Los_Angeles)

The operator reports alpha.2 is deployed. In an existing authenticated Chrome
profile, /ubc/ recognized the real session. Clicking Connect produced the
connected status and saved that user's credential through the existing API.
The unmodified alpha.1 Hub personal stdio entry became Online with eleven tools;
a real get_data_status call through the Hub returned personal.connected=true
and an empty periods array. No real snapshot was uploaded.

Installed extension 0.2.1 was paired in the Work Chrome profile using a one-use
code from the already signed-in Lian. profile. This confirms the extension needs
only its own scoped upload credential, not Hub or Workday cookies. A synthetic
ZZTEST 999 section in period 2026W-GUI-TEST was imported, previewed and explicitly
uploaded in the real popup. The popup reported a successful one-period sync.
The connection page listed the scope, and a real search_sections call through
Hub returned the section with the exact original capturedAt/observedAt and a
correct stale indicator. The Hub form supplied an invalid zero latestMinute by
default; explicitly setting 1440 allowed the valid query. Hub was not modified.

Disconnect was confirmed in the frontmost Chrome window. The page returned to
not-connected with no snapshots. Repeating the Hub query refused access due to
missing personal credentials. Re-importing the same synthetic file in the
extension and retrying upload returned HTTP 401. Forget local connection then
removed the extension credential. No real schedule was uploaded. Cross-user Hub
acceptance and live course-search export remain unverified; private visibility
has not been expanded.

Extension 0.2.1 adds validated JSON file import preview for synthetic acceptance
and existing exports. All 35 tests pass with import-preview/explicit-upload
coverage. No connector upgrade is needed for this extension patch.

## UI feedback upgrade prepared — alpha.3 / extension 0.2.2

Extension controls now use spaced stacked actions, primary/secondary styles and
three numbered steps. A sticky top status shows loading, success and actionable
errors. Pairing, file parsing, page capture, export and upload share a busy guard;
controls recover on failure. Upload shows per-period progress and a revoked
credential is removed locally. The optional export controls are collapsed.
The /ubc/ page adds immediate action-specific loading labels, spinners, disabled
controls, explicit timeout feedback and responsive action spacing. No Hub change
is needed. Local synthetic browser previews verified layout and visible pending
states; the production website remains alpha.2 until its operator upgrades only
the connector. The extension requires refreshing the existing unpacked extension.
37 local tests and protocol checks pass, including delayed-request duplicate-click
and error-recovery tests. No real tokens, user bindings or snapshots were used
for this UI review.
