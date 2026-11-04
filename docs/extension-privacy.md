# UBC Course Capture privacy policy

[中文](extension-privacy.zh.md)

UBC Course Capture is a browser extension for Chrome and Firefox. It reads
course and registration data from UBC Workday pages in your browser and sends
it to a UBC connector behind an MCPHub server that you choose, so AI assistants
you connect to that server can plan courses with your own data. It is an
independent open-source project, not made by or affiliated with UBC or Workday.

This policy covers extension version 0.4.0 and later. (0.4.0 declared only
authentication information and website content in Firefox's data consent;
0.4.1 adds personally identifying information.) The source is public at
https://github.com/KKazuhaK/UBC-MCP; the extension is in `src/collector/` and
`extension/`, and the server side in `src/connector/`.

## Summary

- The extension reads UBC Workday pages (`https://wd10.myworkday.com/ubc/`) only
  after you grant it access, and sends recognized course and registration data
  only to the MCPHub address you enter. The one exception is a connection saved
  by a version before 0.4; see [Older connections](#older-connections).
- Your Workday password and cookies are never read. Your name, student ID and
  other page content are not sent: registration captures are built to leave
  out your name and student ID.
- There is no analytics, tracking or advertising, and the data is not sold.
- The person who runs that MCPHub server (the operator) can read what the
  extension uploads. Use a server whose operator you trust.

## What the extension sends

**Course sections.** From any UBC Workday page that lists course sections the
extension recognizes (course search results and the section detail dialog, but
also any other Workday view laid out the same way, such as a saved schedule):
the course and section code and title, instructional format, registration
status, instructor names, section capacity, enrolled and waitlisted counts with
their capacities, reserved and unreserved seat counts, reserved-seat
eligibility rules and their seat counts, eligibility text, required companion
activities, meeting days, times, dates and locations, the academic period and
campus, and Workday's internal identifier for each section. Which sections are
captured depends on what the page shows, so it can also reveal what you
searched for or planned.

**Your registrations.** From a Workday table with View My Courses' columns:
for each course you are registered or waitlisted in, the section code and
title, instructional format, meeting patterns, instructors, Workday's
identifier for the section, and whether you are enrolled or waitlisted. Rows in
any other state are dropped. The first column of that table contains
identifying information; only the academic period is matched from it and the
rest is discarded.

**What it reads but does not send.** To find these items, the extension's
script reads the whole content of every UBC Workday page it runs on, including
its text and tables, inside your browser. Whatever is on those pages, such as
your name, student ID, grades or finances if a page shows them, stays in your
browser and is not stored.

**What it never reads.** Workday passwords, cookies or session tokens; browsing
history; pages outside UBC Workday, apart from the MCPHub approval step
described below.

## When it reads

- **Connect with MCPHub turns on automatic sync**, as soon as you click it,
  even if you do not finish connecting. You can pause it with Pause automatic
  sync at any time. Connecting with a one-time pairing code does not turn it on
  by itself.
- **Background registration sync.** About one minute after sync is turned on
  and then every 15 minutes while the browser is running, the extension makes
  your browser open View My Courses in a background tab, with your existing
  Workday sign-in. It reads the page, uploads the result and closes the tab (it
  leaves the tab open if you have switched to it). If you are signed out,
  nothing is read.
- **Pages you open.** While automatic sync is on, the extension also runs on
  each UBC Workday page you load. When the page shows recognized course
  sections or a complete registration table, it uploads them a few seconds
  after the page changes and again about every four minutes while the page
  stays open.
- **Manual actions.** Sync now does the above at once. The other buttons run
  only when you click them: Preview course sections and Preview my
  registrations read the current Workday tab; importing an exported JSON file
  validates the file you pick; nothing from a preview or import is uploaded
  until you click Upload previewed data. Export course snapshot and Export my
  registrations save a file and upload nothing.

## Where the data goes

The extension sends data only to the MCPHub origin you entered (or, for an
older connection, the address below), over HTTPS, without browser cookies:

| Request | When | What is sent |
| --- | --- | --- |
| `GET /ubc/capabilities` | Connect with MCPHub | nothing beyond a normal request |
| `POST /ubc/api/claim` | after you approve the connection, or with a pairing code | the one-time code |
| `POST /v1/snapshots` | each sync or upload | one snapshot (the data above) and your upload credential |

Like any web request, these reveal your IP address, the time and your browser
version to that server, and carry the extension's own origin
(`chrome-extension://…` or `moz-extension://…`). The extension itself makes no
requests to Workday; the background tab it opens is an ordinary page load by
your browser, with your Workday cookies, as if you had opened it.

**Connecting.** Connect with MCPHub opens the UBC connection page on your MCPHub
in a new tab, where you sign in to MCPHub and approve. The extension then runs a
small script in that tab only. It reads the one-time code the page hands to
the extension, not your MCPHub cookies, profile or session, and exchanges that
code for an upload credential.

### Older connections

Official release builds (the zips attached to GitHub releases and the store
versions) contain one built-in address, `https://mcp.kazuhahub.com`, the
project's original server. It is used only if your browser still holds a
credential saved by a version before 0.4, which stored no address: syncs and
uploads then go to that server with that credential, as they did before, until
you connect again. Nothing is sent there for new installs or 0.4.x connections,
and builds made from source without `UBC_RELEASE=official` contain no address
at all.

**Downloads.** Export saves a JSON file to a place you choose. It is a plain,
unencrypted copy of the data above, and it is yours to keep private.

## What the browser keeps

In the extension's local storage, which is not synced between your devices:
the MCPHub address and your upload credential; whether automatic sync is on;
the time and size of the last sync and the last sync error; the state of the
last connection attempt (while connecting, a random value, expiry time and tab
number tying the approval tab to the extension; afterwards the address and a
success or error message); and a credential saved by a version before 0.4, if
any. Disconnect this browser removes all of these except the MCPHub address,
which stays to prefill the field. An old credential is no longer used once you
connect again.

Captured course data is not written to storage. It is held in memory while it
is previewed or uploaded, and the script in a Workday tab keeps a copy of what
it last sent, to skip unchanged uploads, until that tab is closed or reloaded.

The upload credential can add snapshots to your connection and replace older
ones; it cannot read them back.

## On the server

The UBC connector, the part of MCPHub that receives snapshots, is run by the
operator of the MCPHub you entered. It:

- checks each snapshot's format and keeps only the latest one for each campus,
  academic period and kind (course sections or registrations), up to 20, under
  your own connection;
- encrypts the snapshot contents with AES-256-GCM using a key file kept in the
  same data directory as its database, so the operator can decrypt them, and a
  backup of that directory holds both the data and the key. The campus,
  academic period, kind and capture time are stored unencrypted next to them;
- keeps snapshots until a newer one replaces them or you disconnect; there is
  no time-based expiry;
- stores unencrypted your MCPHub user name (or, for a connection made through
  OAuth, the issuer and account identifier), a label for the connection, hashes
  of your credentials and of pending pairing codes with their expiry; an
  encrypted copy of your credentials; and, in memory only, recent IP addresses
  for rate limiting.

**Who can read it.** Anyone holding your connection's read credential, which
MCPHub stores for you; and, if the connector's own MCP endpoint is enabled, any
MCP client signed in through the configured sign-in service as your account.
When an MCP client or AI assistant you connect uses the UBC personal tools,
your snapshots are passed to that client, and from there to its AI provider
under that provider's own policy. The operator can also read stored data.
MCPHub's activity log may record each tool call (tool, user, time, IP address),
and can store tool inputs and outputs unless payload storage is off or the call
uses a per-user credential, as the UBC personal tools normally do. The server
or its hosting may also keep request logs and backups under the operator's own
retention policy.

**Deleting it.** On the UBC connection page in MCPHub, 断开并删除我的数据
(Disconnect and delete my data) revokes your credentials and deletes your
current snapshots and account link from the connector; only a revoked record
of the connection, with its label and credential hashes, remains. Deleted rows
can stay in the database file until they are overwritten. Copies already in
backups, or already sent to an AI client, follow their own retention.
Disconnect this browser in the extension removes only the credential and
settings in your browser; your data stays on the server until you disconnect
there. Uninstalling the extension removes its local storage.

## Permissions

| Permission | Why |
| --- | --- |
| Site access to your MCPHub (optional, `https://*/*` narrowed to the origin you enter) | connect and upload; requested when you connect |
| Site access to `https://wd10.myworkday.com/*` (optional) | read Workday pages for automatic sync; requested when you connect or turn sync on |
| `activeTab`, `scripting` | read the Workday tab you preview; run the sync script in Workday tabs and the approval script in the MCPHub tab |
| `alarms` | run the 15-minute registration sync |
| `storage` | keep the connection and settings listed above |
| `downloads` | save JSON exports you ask for |

The extension downloads no remote code; all its scripts are bundled in the
package. In Firefox it declares, in Firefox's data consent, that it transmits
authentication information (the pairing code and upload credential), personally
identifying information (instructor names, and registration records tied to
your account) and website content (Workday course data).

## Chrome Web Store user data

UBC Course Capture's use of user data complies with the Chrome Web Store User
Data Policy, including the Limited Use requirements. Data is used only to
provide the extension's single purpose, syncing your UBC course data to your
own connection; it is not used for advertising, credit or lending decisions,
or sold, and is not transferred except as this policy describes.

## Changes and contact

Changes to this policy are made in this file; its history is on GitHub. For
questions, open an issue at https://github.com/KKazuhaK/UBC-MCP/issues, without
credentials or private snapshots.
