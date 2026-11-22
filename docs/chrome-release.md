# Extension release

## Release builds

Build the package with `npm run build:extension` (Chrome) and `npm run build:firefox`.
The default MCPHub (`https://mcp.kazuhahub.com`) is named only in `extension/manifest.json` (its host permission and the `/ubc/` page bridge); the build scripts read it from there (`scripts/default-hub.mjs`). Users of another MCPHub enter its address in the popup.

## Release assets

`.github/workflows/browser-extension-release.yml` runs when a release is
published (prereleases included) or by hand for an existing tag. It tests,
makes both builds, lints the Firefox build and attaches to the release:

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
- Microsoft Edge Add-ons: the Chrome zip, uploaded and published through Edge
  Add-ons API v1.1.
- Firefox Add-ons: `web-ext sign` with the source archive. The channel comes
  from the `FIREFOX_CHANNEL` variable, `unlisted` by default (set it to
  `listed` for the public listing, which Firefox updates automatically); an unlisted signed
  XPI is attached to the release as `ubc-course-capture-firefox-<version>.xpi`,
  with `ubc-course-capture-firefox-<version>.xpi.sha256`.

What to enter when each listing is first created by hand (text, permission
justifications, data disclosures, reviewer notes): [store-listing.md](store-listing.md).

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
