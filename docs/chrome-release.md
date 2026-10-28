# Chrome release

Official packages are built with `npm run build:extension:release`, which sets
`UBC_RELEASE=official` so the origin in `release/extension.json` is embedded to
resume pre-0.4 connections. Plain `npm run build:extension` embeds nothing. See
"Release build configuration" in [firefox-publishing.md](firefox-publishing.md).
Without the origin, a pre-0.4 connection is parked and the user is asked to reconnect.
