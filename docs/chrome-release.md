# Extension release

## Release builds

Official packages are built with `npm run build:extension:release`, which sets
`UBC_RELEASE=official` so the origin in `release/extension.json` is embedded to
resume pre-0.4 connections. Plain `npm run build:extension` embeds nothing. See
"Release build configuration" in [firefox-publishing.md](firefox-publishing.md).
Without the origin, a pre-0.4 connection is parked and the user is asked to reconnect.

## Release assets

`.github/workflows/browser-extension-release.yml` runs when a release is
published (prereleases included) or by hand for an existing tag. It tests,
makes both official builds, lints the Firefox build and attaches to the release:

- `ubc-course-capture-chrome-<version>.zip`: load unpacked, or upload to the Chrome Web Store;
- `ubc-course-capture-firefox-<version>-unsigned.zip`: for Mozilla signing; Firefox
  does not install it permanently as is;
- `ubc-course-capture-source-<version>.zip`: `git archive` of the tag, for Add-ons review;
- `ubc-course-capture-<version>-SHA256SUMS.txt`.

`<version>` is the `version` in `extension/manifest.json`, which is separate
from the npm package version. Bump it whenever the extension changes.

web-ext comes from `release/tools/package-lock.json`, installed with
`--ignore-scripts`; CI lints with the same copy.

## Store submission

Store jobs skip until configured, and then run only for a stable (non-prerelease)
release, or a manual run with `submit_to_stores`. The first listing in each
store is created by hand; the workflow header lists the variables and secrets.
A store refuses a version it already has.

- Chrome Web Store: upload and publish through API v2.
- Firefox Add-ons: `web-ext sign` with the source archive. The channel comes
  from the `FIREFOX_CHANNEL` variable, `unlisted` by default; an unlisted signed
  XPI is attached to the release as `ubc-course-capture-firefox-<version>.xpi`,
  with `ubc-course-capture-firefox-<version>.xpi.sha256`.

Store listing privacy policy:
https://github.com/KKazuhaK/UBC-MCP/blob/main/docs/extension-privacy.md
(Chinese: `docs/extension-privacy.zh.md`). The Firefox build declares
authentication information, personally identifying information (instructor
names, the user's own registrations) and website content in its data consent.
The Chrome Web Store data disclosure is filled in by hand in the developer
dashboard; declare the same three categories there.

Icons are in `src/collector/icons/` (`icon.svg` is the source; `icon-store.svg`
adds the 16 px transparent padding the Chrome Web Store asks for and renders
`icon-128.png`). The builds copy the PNGs into `icons/`.
