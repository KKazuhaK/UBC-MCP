# Store listings: UBC Course Capture

What to enter when the extension is first listed in each store by hand. After
the first listing, `.github/workflows/browser-extension-release.yml` uploads
each stable release (or a manual run with `submit_to_stores`) automatically;
the workflow header lists the variables and secrets. Keep this file in step
with [the privacy policy](extension-privacy.md) and `extension/manifest.json`.

## Before the first upload

- Firefox add-on id: `ubc-course-capture@mcp.kazuhahub.com` (the build
  default). Do not set the repository variable `FIREFOX_ADDON_ID` yet: it
  turns on the Firefox submission job, which needs the listing to exist (see
  "Firefox Add-ons" below).
- Package for the first upload, from the release assets:
  `ubc-course-capture-chrome-<version>.zip` (Chrome Web Store and Edge
  Add-ons), `ubc-course-capture-firefox-<version>-unsigned.zip` and
  `ubc-course-capture-source-<version>.zip` (Firefox Add-ons). Only releases
  made after the extension release workflow was added carry them.
- Store versions only go up: bump `version` in `extension/manifest.json` for
  every extension change before it is submitted.
- Screenshots (1280x800 PNG; Chrome and Edge need at least one, Firefox
  recommends one): the popup connected and syncing, and a registration
  preview. Use a synthetic course (such as ZZTEST 999) and no real name or
  student number.
- Chrome Web Store small promo tile: 440x280 PNG (required by Chrome; Edge
  accepts it as optional).
- Store icon: `src/collector/icons/icon-128.png` (rendered from
  `icon-store.svg`, padded as the Chrome Web Store asks).

## Shared text

**Name:** UBC Course Capture

**Summary** (Chrome: at most 132 characters; also the Edge short description
and the Firefox summary):

> Syncs the UBC Workday course sections and registrations you can already see to your own UBC MCP connection, for course planning.

**Description:**

> UBC Course Capture lets AI assistants connected to your MCPHub plan courses
> with your real UBC data. While you are signed in to UBC Workday, it reads the
> course sections and your registrations that Workday already shows you, and
> sends them to the UBC connector on the MCPHub server you choose. Assistants
> connected to that server can then check seat counts, meeting times,
> conflicts and your current schedule.
>
> - One click to connect: on the MCPHub UBC page, press "Connect this browser".
>   Another MCPHub, or a pairing code, can be entered in the popup instead; data
>   goes only to the MCPHub you connect.
> - No passwords or cookies: it never reads your Workday password, cookies or
>   session, and uploads use a credential issued when you approve the
>   connection in MCPHub.
> - Leaves out who you are: registration captures drop your name and student
>   number before anything is sent.
> - Site access is limited to UBC Workday and the default MCPHub; any other
>   MCPHub address is asked for when you connect to it.
> - Automatic sync: once you connect, the extension opens View My Courses in a
>   background tab every 15 minutes, reads it and closes it, and also reads
>   recognized Workday pages you open. Pause automatic sync or disconnect at
>   any time.
>
> You need an MCPHub server with the UBC connector (open-source:
> https://github.com/KKazuhaK/UBC-MCP). This is an independent project and is
> not made by or affiliated with the University of British Columbia or Workday.

**Category:** Chrome: Productivity > Education; Edge: Productivity; Firefox:
Other.

**Language:** English.

**Homepage / support URL:** https://github.com/KKazuhaK/UBC-MCP

**Privacy policy URL:** https://github.com/KKazuhaK/UBC-MCP/blob/main/docs/extension-privacy.md

**License (Firefox):** GNU Affero General Public License v3.0 or later
(`AGPL-3.0-or-later`, as in `package.json`).

## Chrome Web Store: Privacy practices tab

**Single purpose:**

> Copy the UBC Workday course sections and registrations the signed-in student can see to the UBC MCP connection the student chooses, for course planning with their own data.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `activeTab` | Previews course sections or registrations from the Workday tab the user opens the popup on, when the user presses Preview. |
| `scripting` | Runs the capture script in UBC Workday tabs to read the course sections and registrations shown there, and reads the one-time connection code from the MCPHub approval tab the user opened. |
| `downloads` | Export saves the captured data as a JSON file to a place the user chooses (a Save As dialog opens). |
| `storage` | Keeps the MCPHub address, the upload credential, whether automatic sync is on and the last sync status on this device. |
| `alarms` | Runs the registration sync every 15 minutes while automatic sync is on. |
| Host permissions (`https://wd10.myworkday.com/*`, `https://mcp.kazuhahub.com/*`) | UBC Workday, to read the course and registration pages the extension syncs; and the default MCPHub, to upload them. |
| Content script (`https://mcp.kazuhahub.com/ubc/*`) | A small bridge on the default MCPHub's UBC page lets its "Connect this browser" button hand the extension a one-time pairing code. It reads nothing else on the page. |
| Host permissions (optional, `https://*/*`) | Requested at runtime only for another MCPHub address the user enters. Each self-hosted MCPHub has its own address, so it cannot be listed in advance. |

**Remote code:** No, I am not using remote code. All scripts are bundled in the package.

**Data usage** (tick these, matching the Firefox data consent):

- Personally identifiable information: instructor names, and the user's own registrations.
- Authentication information: the upload credential.
- Website content: course section and registration data from UBC Workday pages.

Leave the others unticked. Tick all three certifications (not sold, not used
for unrelated purposes, not used for creditworthiness).

**Test instructions** (Chrome's reviewer notes; the description and the
privacy policy also describe the background tab, so it is not read as hidden
behaviour): use the Edge certification notes below.

## Microsoft Edge Add-ons (Partner Center)

Edge takes the Chrome zip unchanged. Use the shared text above.

- **Privacy policy:** required, because the extension handles personal data;
  same URL.
- **Notes for certification:**

> The extension needs a UBC Workday account and an MCPHub server with the UBC connector to do anything beyond its popup. To try the connection flow: installing the extension opens https://mcp.kazuhahub.com/ubc/ (the popup's Open MCPHub to connect does the same); sign in there and press "连接此浏览器" (Connect this browser). The popup's "Another MCPHub, or a pairing code" section is the manual fallback. With automatic sync on, the extension opens View My Courses in a background tab every 15 minutes, reads it and closes it. Source: https://github.com/KKazuhaK/UBC-MCP (build: npm ci && npm run build:extension; output in extension/).

After the product exists, Partner Center > Publish API (v1.1) gives the Client
ID and API key for `EDGE_CLIENT_ID` and `EDGE_API_KEY`; the product id from the
extension overview page goes in `EDGE_PRODUCT_ID`. The API key expires; renew
it there before the date it shows.

## Firefox Add-ons (AMO)

- Distribution: **On this site (listed)**, so Firefox updates it
  automatically (an unlisted add-on updates only through an `update_url`,
  which this manifest does not have).
- Source code: upload `ubc-course-capture-source-<version>.zip`. Build steps
  for the reviewer are in [firefox-publishing.md](firefox-publishing.md)
  (Node 24, `npm ci`, `npm run build:firefox`, output in
  `.data/firefox-extension`).
- Data collection: the manifest already declares `authenticationInfo`,
  `personallyIdentifyingInfo` and `websiteContent` as required.
- Notes to reviewer: the same text as the Edge certification notes.

After the listing exists, Tools > Manage API Keys gives the JWT issuer and
secret for `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`; then set the variables
`FIREFOX_ADDON_ID=ubc-course-capture@mcp.kazuhahub.com` and
`FIREFOX_CHANNEL=listed` together (the job's default channel is `unlisted`).
