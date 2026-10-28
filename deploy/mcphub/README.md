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

Run the connector as a separate container using `deploy/compose.yaml`. The
selected production deployment uses this isolation because Hub and its stdio
children run as root. Never mount connector data or its encryption key into Hub.
Persist
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

## Self-service GUI upgrade (alpha.2, no Hub changes)

Update only the connector image/app and unpacked extension. The existing alpha.1
Hub stdio clients remain compatible with the snapshot read API; do not change
Hub source, server definitions, visibility, startup configuration or database.

DEPRECATED cookie-based mode: new deployments should use UBC_PLATFORM_ADAPTER=mcphub-oauth
(README, "Connecting to MCPHub (OAuth)"), which needs an OAuth client registered in MCPHub and
listed in the server's credentialWriteClients.

Enable the connector GUI with UBC_PLATFORM_ADAPTER=mcphub and
UBC_PUBLIC_ORIGIN set to your Hub's public HTTPS origin (the adapter is off by
default). UBC_PLATFORM_URL (formerly UBC_HUB_URL) is optional and defaults to that public origin.
UBC_PLATFORM_SERVER_NAME defaults to ubc-personal. It is an
operator-controlled fixed upstream, never a URL supplied by a browser. Use the
public URL initially so the existing login gateway participates. Never bypass
identity validation by trusting username headers. Hub cookies are relayed in
memory only to this configured upstream for /api/better-auth/user,
/api/credentials and /api/credentials/ubc-personal. No admin/system token is used.
Persisted self-service credentials are AES-GCM encrypted with the existing key.

Keep the existing exact /v1/snapshots proxy location and add a /ubc/ location to
the same connector. Preserve Cookie, Origin and Authorization, disable caching
and request/access logging, and leave /healthz unexposed. Allow extension OPTIONS
requests on /v1/snapshots and /ubc/api/claim; the connector itself restricts methods
and origins. See deploy/ubc-self-service.nginx.conf.example. Do not route the
Hub /api/ prefix to the connector or change the login provider.

The user's browser visits /ubc/ after Hub login. The page verifies the user's
Hub identity and checks that ubc-personal is discoverable with the expected slot.
Connect saves the generated READ token through the user's existing credential
API; Pair issues a single-use five-minute code redeemable only for UPLOAD access.
The page does not expose READ tokens. Disconnect revokes connector access before
attempting to remove the user's saved Hub credential. If cleanup fails, the
revoked token remains unusable and the page tells the user to remove it manually.

With the current private Hub definition only the owner/admin can complete this
flow. Fail closed for other users. Broadening access is a separate operator
decision and is not included in this upgrade.

Acceptance before calling the GUI production-ready:
- Existing cookie login must be recognized, with no admin credential supplied.
- Connect must save only that account's Hub slot, without editing server config.
- Pair through the installed extension, preview synthetic data and upload it.
- Query through the existing Hub stdio client; verify original capture timestamps.
- Disconnect must stop reads/uploads; re-pairing must start with no old snapshots.
- Repeat as a second independently authorized Hub user before expanding the pilot.

The local suite uses an HTTP Hub mock for identity and credential API contracts;
it is not proof that the deployed gateway relays the same session cookies.
