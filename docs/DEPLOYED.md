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

The hosted personal connector, reverse proxy and per-user Hub bindings have
not been deployed. Host management access is required for the Docker volume
and private sync route. Do not mark personal registration or seat data available
in the public entry while these steps remain outstanding.

## Package and rollback

Release: https://github.com/KKazuhaK/UBC-MCP/releases/tag/v0.1.0-alpha.1

The release includes the compiled MCP package, unpacked-extension zip and
SHA256SUMS.txt. Release assets are fixed; fixes should use a new version rather
than replacing an asset already installed by Hub. Disable only `ubc-public` to
roll back this initial deployment. Do not modify other server definitions.
