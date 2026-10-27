# UBC Course Capture privacy

UBC Course Capture is an independent project, not affiliated with UBC or Workday.
With your permission, it opens a short-lived background UBC Workday registration page every 15 minutes and uploads recognized registration snapshots. It also reads supported course-search pages while open. It can validate a JSON snapshot you explicitly select.

Captured data may include course/section codes, titles, instructors, meeting dates,
times and locations, published capacity and seat information. The separate
registration capture includes your registered/waitlisted course choices. It is
designed to discard your student name and student ID. It does not intentionally
collect grades, finances, passwords, Workday cookies or browsing history.

Automatic synchronization and manual upload send snapshots to /v1/snapshots on the MCPHub HTTPS origin you explicitly choose. Preview and export actions do not themselves upload snapshots. No public
server is selected for new installations. Connect with MCPHub opens its UBC
connection page, where you sign in and approve. A one-use code is automatically
exchanged for an upload-only credential without copying a token or pairing code. That credential is kept in
extension-local storage, not browser sync storage. There is no analytics or
advertising endpoint. Automatic registration sync opens a temporary Workday page while the browser is running and the Workday session is valid. The user can pause sync. It does not read a full catalog or perform registration actions.
A background worker completes the approved connection even if the popup closes.
It injects a small handoff script only into the specific Hub authorization tab;
that script reads the one-use code, not Hub cookies, profiles or session tokens.
Site access is optional and requested for the selected Hub origin and UBC Workday. Upload credentials are bound to the Hub origin and never reused for another server.

The connector stores encrypted snapshots under your independent connection. The
operator controls the server and encryption key and can access the stored data.
Disconnect on the UBC connection page revokes read/upload credentials and deletes
current snapshots. Backups have a separate retention policy managed by the host
operator. Forget local connection removes the extension's local credential only.
Downloaded JSON exports are plaintext files under your own control.

Firefox's submission manifest declares authenticationInfo and websiteContent
transmission, because pairing credentials and selected Workday page data are
sent to the configured service. It does not declare that the extension sends no
data. The Firefox package requires version 142 or newer for built-in data consent.

For privacy questions, open an issue without credentials or private snapshots:
https://github.com/KKazuhaK/UBC-MCP/issues
