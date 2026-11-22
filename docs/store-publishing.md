# Publishing UBC Course Capture to the browser stores

Once this setup is done, shipping an extension update takes one step: bump
`version` in `extension/manifest.json` and merge to `main`.
`.github/workflows/browser-extension-release.yml` then builds and tests the
extension, creates the GitHub release `extension-v<version>` (not marked
Latest, so the server release stays the one people see first) with the zips
attached, and submits that version to every configured store.

What you do by hand, once per store: create the developer account, create the
first listing with an uploaded zip, create API credentials, and store them in
the repository. This file walks through it. What to type into each listing
(descriptions, permission justifications, privacy answers, reviewer notes) is
in [store-listing.md](store-listing.md).

Enter every secret yourself, at the `gh secret set` prompt or in the GitHub
web UI (Settings > Secrets and variables > Actions). Never paste one into a
chat, an issue or a commit.

## How releases and the stores fit together

| Event | Builds and attaches zips | Submits to the stores |
| --- | --- | --- |
| Push to `main` that changes the version in `extension/manifest.json` | yes, to a new `extension-v<version>` release | yes |
| Push to `main` that changes `extension/manifest.json` but keeps the version | no (the release exists) | no |
| Server release `v*` published | yes, to that release | no |
| Stable `extension-v*` release published by hand | yes | yes |
| Manual run (Actions > Browser extension release > Run workflow) | yes, for the tag you give | only with `submit_to_stores` |

Every run starts with **Check store configuration**, which shows a table of
the stores in the run summary (ready, not configured, or misconfigured) and
fails when a store is half configured, for example a variable set without its
secrets. A store with no variable is skipped quietly.

Store versions only go up, and each store refuses a version it already has.
Whatever version you upload by hand for a first listing, the next automatic
release must be higher.

## Order of work

1. Pick the zips for the first listings: the assets of the latest release
   (`ubc-course-capture-chrome-<version>.zip`,
   `ubc-course-capture-firefox-<version>-unsigned.zip`,
   `ubc-course-capture-source-<version>.zip`). Download them with
   `gh release download <tag> -R KKazuhaK/UBC-MCP -p 'ubc-course-capture-*'`.
2. Create each store listing by hand (sections below) and wait for it to be
   accepted or at least submitted.
3. For each store, set its **secrets first, then its variables**. The
   variables are what switch a store's job on.
4. Check the configuration without submitting anything:

   ```sh
   gh workflow run browser-extension-release.yml -R KKazuhaK/UBC-MCP -f tag=<latest release tag>
   ```

   Open the run (`gh run list -R KKazuhaK/UBC-MCP -w browser-extension-release.yml -L 1`)
   and read the **Browser stores** table in its summary. Every store you set
   up should say `ready`.
5. From now on, bump the manifest version for each extension change.

## Chrome Web Store

Needs: a Chrome Web Store developer account (one-time registration fee) and a
Google Cloud project for the API.

1. **First listing.** In the [Chrome Web Store Developer
   Dashboard](https://chrome.google.com/webstore/devconsole), choose **New
   item**, upload the Chrome zip and fill in the listing and privacy tabs from
   [store-listing.md](store-listing.md). Submit it for review.
2. **IDs (variables).** The extension id is the 32-letter id on the item's
   **Package** tab (also in the item's URL). The publisher id is under
   **Publisher > Settings** in the dashboard.
3. **API access.** In the [Google Cloud console](https://console.cloud.google.com/):
   1. Create or pick a project and enable the **Chrome Web Store API**.
   2. Under **Google Auth Platform** (formerly OAuth consent screen), configure
      an External app with your own address, then **publish it to
      production**. While it stays in Testing, Google expires its refresh
      tokens after 7 days and the job starts failing. An unverified app is
      fine: only you sign in to it.
   3. Under **Clients**, create an OAuth client of type **Web application**
      with the authorized redirect URI
      `https://developers.google.com/oauthplayground`. Keep its client id and
      client secret.
4. **Refresh token.** Open the [OAuth 2.0
   Playground](https://developers.google.com/oauthplayground). In the gear
   menu tick **Use your own OAuth credentials** and enter the client id and
   secret. In step 1 enter the scope
   `https://www.googleapis.com/auth/chromewebstore`, press **Authorize APIs**
   and sign in with the Google account that owns the Chrome Web Store
   publisher. In step 2 press **Exchange authorization code for tokens** and
   copy the refresh token. Afterwards, remove your credentials from the
   Playground settings.
5. **Store them:**

   ```sh
   gh secret set CHROME_CLIENT_ID -R KKazuhaK/UBC-MCP
   gh secret set CHROME_CLIENT_SECRET -R KKazuhaK/UBC-MCP
   gh secret set CHROME_REFRESH_TOKEN -R KKazuhaK/UBC-MCP
   gh variable set CHROME_PUBLISHER_ID -R KKazuhaK/UBC-MCP --body '<publisher id>'
   gh variable set CHROME_EXTENSION_ID -R KKazuhaK/UBC-MCP --body '<extension id>'
   ```

   Each `gh secret set` asks for the value and does not echo it.

The job uploads the zip and publishes it, which sends the version to review;
Chrome publishes it when review passes.

## Microsoft Edge Add-ons

Needs: a Microsoft Partner Center account enrolled in the Microsoft Edge
program (free).

1. **First listing.** In [Partner
   Center](https://partner.microsoft.com/dashboard/microsoftedge/overview),
   choose **Create new extension**, upload the same Chrome zip and fill in the
   listing from [store-listing.md](store-listing.md). Submit it.
2. **Product id (variable).** The extension's overview page in Partner Center
   shows its product id, a GUID.
3. **API access.** In Partner Center, open **Microsoft Edge > Publish API**,
   turn on the current API version (v1.1) if asked, and create API
   credentials. Keep the **Client ID** and the **API key**. The key has an
   expiry date shown there; renew it before then and run
   `gh secret set EDGE_API_KEY` again.
4. **Store them:**

   ```sh
   gh secret set EDGE_CLIENT_ID -R KKazuhaK/UBC-MCP
   gh secret set EDGE_API_KEY -R KKazuhaK/UBC-MCP
   gh variable set EDGE_PRODUCT_ID -R KKazuhaK/UBC-MCP --body '<product id>'
   ```

Edge refuses a new submission while the previous one is still in
certification. If the Edge job fails for that reason, re-run only the failed
job once certification is done: `gh run rerun <run id> --failed -R KKazuhaK/UBC-MCP`.

## Firefox Add-ons (AMO)

Needs: a Firefox account signed in to the [Add-on Developer
Hub](https://addons.mozilla.org/developers/), with its developer agreement
accepted.

1. **First listing.** Choose **Submit a New Add-on**, pick **On this site**
   (listed, so Firefox updates installs automatically) and upload the unsigned
   Firefox zip. When asked for source code, upload the source zip. Fill in the
   listing from [store-listing.md](store-listing.md). The add-on id is fixed by
   the zip: `ubc-course-capture@mcp.kazuhahub.com`.
2. **API access.** Open **Tools > Manage API Keys**
   (<https://addons.mozilla.org/developers/addon/api/key/>) and generate
   credentials. Keep the **JWT issuer** and the **JWT secret**.
3. **Store them:**

   ```sh
   gh secret set AMO_JWT_ISSUER -R KKazuhaK/UBC-MCP
   gh secret set AMO_JWT_SECRET -R KKazuhaK/UBC-MCP
   gh variable set FIREFOX_CHANNEL -R KKazuhaK/UBC-MCP --body listed
   gh variable set FIREFOX_ADDON_ID -R KKazuhaK/UBC-MCP --body 'ubc-course-capture@mcp.kazuhahub.com'
   ```

   Without `FIREFOX_CHANNEL=listed` the job signs each version for
   self-distribution (unlisted) and attaches the signed XPI to the release
   instead of updating the public listing.

The job signs and submits with `web-ext` and uploads the source zip for the
reviewers. A listed version goes live when Mozilla's review passes.

## Turning a store off

Delete its variable, and the job skips again:

```sh
gh variable delete EDGE_PRODUCT_ID -R KKazuhaK/UBC-MCP
```

Delete the secrets too (`gh secret delete <name>`) if you revoke the
credentials.
