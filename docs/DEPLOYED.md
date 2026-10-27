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

Installed-extension pairing/upload/revocation still await loading the extension
in the same authenticated Chrome profile. Extension 0.2.1 adds a validated JSON
file import preview, allowing synthetic-data acceptance without scraping or
uploading real Workday selections. Existing 35 tests pass with import-preview and
explicit upload coverage. No connector upgrade is needed for this extension patch.
