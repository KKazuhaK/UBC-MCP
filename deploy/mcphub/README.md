# MCPHub deployment

The target is the existing MCPHub at `https://mcp.kazuhahub.com/`. Hub owns remote
client authentication. UBC runs as a stdio child and does not need a second OAuth
server or public MCP port. Preserve existing server definitions and user bindings.

## Public alpha

Build and package with `npm ci`, `npm run build`, and `npm pack`. Publish the
reviewed compiled `.tgz` as a versioned release asset, record its SHA-256 and pin
the exact release URL in Hub. It includes `dist/`; a source-only Git archive does
not provide the compiled executable. Do not reference an unpublished npm package.

Use the released package as the first npx package, followed by the pinned Node 24
runtime package. Set `UBC_PROFILE=public`. Start with a private admin-visible
test entry, verify actual source calls, then make it visible to intended users.
The old Hub client may use the 2025 MCP protocol; test that handshake explicitly.

For a source-bundled image, `mcp_settings.bundled.example.json` expects a compiled
checkout with production dependencies at `/opt/mcp/ubc` and Node 24 at
`/opt/mcp/bin/node24`. This file is a template, not a record of deployed state.

## Personal alpha

Run the connector as a separate container using `deploy/compose.yaml`. Persist
its entire data volume. A fresh Docker named volume is initialized from the
image-owned `/data` directory. A host bind mount must instead be owned by UID 1000.
Add the service to the Hub's actual Docker network before using
`http://ubc-connector:8792`; a different Compose project does not automatically
share that network. Do not publish port 8792 on all interfaces.

If local companions upload through HTTPS, configure a dedicated reverse-proxy
route to the connector. Keep upload/read responses uncached, preserve Authorization,
set a four-megabyte request limit, and exclude credentials and request bodies
from logs. The read and upload endpoints are `/v1/snapshots`, distinguished by
method and token scope. Administrative operations are CLI-only.

Provision a separate binding for each invited user. Configure the READ token as
the required per-user `env.UBC_CONNECTOR_TOKEN` slot, with an operator-controlled
connector URL. Hub's template import behavior varies: use Advanced Options >
Per-user credential slots when batch import cannot preserve the template.

Never use `UBC_SNAPSHOT_FILE` on a shared personal entry. No shared credential
fallback exists. A personal service with no binding fails closed at startup.
Use private visibility for the pilot. Hub and connector administrators are trusted
with data custody; encryption does not hide snapshots from the host operator.

## Acceptance and rollback

1. Public stdio entry reports version `0.1.0-alpha.1` and seven read-only tools.
2. Call `get_course` for Vancouver CPSC 210 and `get_course_grades` for an available
   historical session through the Hub, not only directly on the development host.
3. Bind users A and B separately. Upload different snapshots; verify each user sees
   only their own periods, sections and registrations.
4. Revoke A. Reads and uploads stop immediately; B still works. Test a new A binding.
5. Restart the connector and Hub; verify data persists and token bindings survive.
6. Confirm old snapshots keep their original timestamps and are excluded by openOnly.

Keep the previous package URL for rollback. Update the existing definition in
place; do not rename a personal entry while changing credentials. A package
rollback does not restore revoked tokens or reset snapshot observation times.
