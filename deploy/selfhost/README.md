# Connector container

This deploys the UBC private connector only. Public/personal MCP stdio servers
inside MCPHub remain independent. No Hub image, source, database, login setting
or service definition needs to change.

The first validated multi-architecture build is available at
`ghcr.io/kkazuhak/ubc-connector@sha256:bcfd437b5a549c01a083770e08cda1478ec1f31a299e9773a9c8709bcee8cdd3`.
The mutable `edge` tag currently points at this build.

## Images and updates

GitHub Actions builds native Linux amd64 and arm64 images, tests each hardened
image with synthetic users, and publishes a multi-architecture image to
`ghcr.io/kkazuhak/ubc-connector` only after the checks pass.

| Tag | Meaning |
| --- | --- |
| `edge` | Default-branch build; use a digest when deploying it |
| `0.1.0-alpha.N` | An exact release |
| `beta` | Most recent release, including prereleases |
| `latest` | Stable releases only; absent until the first stable release |

Publishing an image does not restart a running server. Like the Canvas deployment,
update deliberately with `docker compose pull` followed by `docker compose up -d`.
There is no unattended updater. Keep the previous digest for rollback.

## Fresh installation

1. Save `docker-compose.yml` and `env.example` together; rename the latter to
   `.env` and protect it with `chmod 600 .env`.
2. Set `UBC_CONNECTOR_IMAGE` to an available version or digest,
   `UBC_PUBLIC_ORIGIN` to the existing Hub HTTPS origin, and `UBC_HUB_NETWORK`
   to the existing Docker network. Create the data directory explicitly:
   `install -d -m 700 -o 10792 -g 10792 /opt/ubc-connector/data`.
3. Set `UBC_DATA_PATH` to that host directory and `UBC_DATA_DIR=/data/connector`.
4. Run `docker compose config -q`, `docker compose pull`, and
   `docker compose up -d`. Confirm container health before opening the UI.

The Compose bind refuses to create a missing host directory. The process runs
as UID/GID 10792, with a read-only root filesystem, dropped capabilities and a
loopback-only published port. `/data` is the only durable write location.

The existing reverse proxy continues to send `/ubc/` and `/v1/snapshots` to
`127.0.0.1:8792`. Keep those routes, their authorization/cookie headers and body
limits. Do not expose `/healthz`, enable wildcard CORS, or replace Hub `/api/`.

## Migrate an existing source-built connector

Do **not** replace the live Compose file with the example without inspecting it.
First record `docker inspect` for the existing connector and its Compose config:

- the actual host data mount and the in-container `UBC_DATA_DIR`;
- current image digest, container/network name and aliases;
- public origin and any explicit `UBC_HUB_URL`;
- CPU/memory settings and existing port binding.

The deployed installation may store `connector.sqlite` directly in `/data`, or
under `/data/connector`. Preserve the actual path. A new empty path would start
a different database and make existing bindings appear lost.

Stop **only the connector**, then back up its whole data directory together with
`encryption.key`, the old Compose/env files and the current image digest. Check
SQLite integrity on the backup. Never copy a running SQLite database as a
standalone file, and never restore its database without the matching key.

Prefer editing only the existing connector's `image` and removing its `build`
entry. Preserve the live mounts, environment, network aliases and security
settings. Then pull the exact image and recreate only that connector. Do not
run `down`, delete volumes, modify Hub, or rebuild/restart the Hub container.

After the connector is healthy, verify that an existing binding still reads its
old snapshot with the original capture time; use a separate disposable binding
for upload/revoke checks. No real schedule is needed for deployment acceptance.

Rollback: set `image` back to the recorded previous digest and recreate only the
connector. Keep the same data mount and key. A database downgrade is a separate
operation and must use a consistent pre-upgrade backup when required by release
notes.

## Admin commands

Run commands in the already running connector, using its own data directory:

```sh
docker compose exec -T ubc-connector node dist/connector/cli.js create-binding 'Label'
docker compose exec -T ubc-connector node dist/connector/cli.js revoke BINDING_ID
```

`create-binding` prints secret read/upload credentials once. Keep them private;
ordinary users should use `/ubc/` self-service instead.

## Local build and validation

From this directory, with a filled `.env`:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
bash smoke-test.sh ubc-connector:local
```

The smoke test uses a fresh named volume and no real Hub or Workday accounts.
It verifies UID 10792, read-only startup, scoped tokens, A/B isolation, capture
times, restart persistence, revocation, the self-service page and extension
preflight. The test container and volume are removed on exit.
