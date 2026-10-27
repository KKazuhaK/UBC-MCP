# UBC Course Capture privacy

UBC Course Capture is an independent project, not affiliated with UBC or Workday.
It reads visible UBC Workday course information only when you choose a preview or
export action. It can also validate a JSON snapshot you explicitly select.

Captured data may include course/section codes, titles, instructors, meeting dates,
times and locations, published capacity and seat information. The separate
registration capture includes your registered/waitlisted course choices. It is
designed to discard your student name and student ID. It does not intentionally
collect grades, finances, passwords, Workday cookies or browsing history.

Preview and export do not upload snapshots. Only Upload sends the previewed data
to https://mcp.kazuhahub.com/v1/snapshots over HTTPS. Pairing exchanges a single-use
code for an upload-only credential at the same host. That credential is kept in
extension-local storage, not browser sync storage. There is no analytics or
advertising endpoint and no background synchronization.

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
