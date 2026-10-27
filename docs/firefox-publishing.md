# Firefox signing preparation

Extension 0.3.0 is prepared for Firefox 142+. It selects the Promise-based browser
namespace, tolerates Firefox's missing storage.setAccessLevel, and bounds local
startup initialization. User feedback confirms that reloading the local build
fixed the persistent Checking state. Direct MCPHub connection requires connector alpha.5 or later. Live browser
acceptance remains required after upgrading both components.

Build from the accompanying source archive with Node 24+, npm ci and
npm run build:firefox. The output is .data/firefox-extension, containing a root
manifest, HTML, bundled JavaScript and license notices. No environment file,
Workday export, user credential or private database is needed for the build.
Run npx --yes web-ext@10.8.0 lint --source-dir .data/firefox-extension
--warnings-as-errors to repeat validation (0 errors/warnings at preparation).

The submission ZIP is unsigned. Renaming it to XPI does not sign it or make a
persistent installation work. Mozilla signing is required. Use the Mozilla
Developer Hub submission flow, choose self-distribution/unlisted for the private
pilot, upload the ZIP and provide the source archive when asked. Public AMO
listing can be chosen separately by the owner. Preserve the fixed Gecko ID
ubc-course-capture@mcp.kazuhahub.com across releases.

Reviewable submission information:
- Name: UBC Course Capture
- Summary: Preview and sync selected UBC Workday course snapshots to your private MCP connection.
- Homepage/source: https://github.com/KKazuhaK/UBC-MCP
- Privacy: docs/extension-privacy.md in the same source repository.
- Data consent: authenticationInfo and websiteContent, no telemetry.
- Optional HTTPS host permission: the user enters their own MCPHub origin and
  grants access to that origin only; there is no prefilled public server.
- activeTab/scripting: read the current UBC Workday DOM only on explicit action.
- downloads: optional JSON export; storage: local upload credential.
- A bundled background script completes approved Hub connection requests. It
  neither uploads snapshots automatically nor performs registration actions. No
  remote code is downloaded. Bundled validation dependencies are included in the source build.

The script is bundled from TypeScript with esbuild and Zod validation. The source
archive and lockfile supply the corresponding original source and dependencies.
The public service currently operates as a private pilot: do not expand access or
include production credentials for a reviewer. Arrange a separately authorized
limited test account if Mozilla requires authenticated end-to-end review.

The account owner must log into Mozilla and accept any developer/distribution
agreements themselves. No signing request has been submitted and no signed XPI
has been issued. Do not disable Firefox signature verification. After signing,
install the returned signed XPI through normal Firefox add-on installation and
verify it survives a browser restart. This acceptance is still outstanding.

Official references:
https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
