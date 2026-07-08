# Publishing guide

How AskFutures Clipper gets to the Chrome Web Store and Edge Add-ons. First
publication is manual (both stores require an existing listing before their
APIs work); every release after that is one git tag.

## One-time setup (human, in order)

### 1. Chrome Web Store

1. Create/choose the publisher Google account, register as a Chrome Web Store
   developer at https://chrome.google.com/webstore/devconsole and pay the
   one-time $5 fee.
2. Build the package: `npm ci && npm run package` → `askfutures-clipper.zip`.
3. Dev console → **New item** → upload the zip.
4. Fill the listing from [`store/listing.md`](listing.md): summary,
   description, category, screenshots (`store/screenshots/`), icon
   (`src/icons/icon128.png`), single-purpose statement, permission
   justifications, privacy-practices disclosures, privacy policy URL.
5. Submit for review (typically hours–3 days).
6. Note the **item ID** from the dashboard URL — that's `CWS_EXTENSION_ID`.

### 2. Chrome Web Store API credentials (for CI releases)

Follow https://developer.chrome.com/docs/webstore/using-api — in short:

1. In a Google Cloud project owned by the publisher account, enable the
   **Chrome Web Store API**.
2. Configure the OAuth consent screen (internal/testing is fine), create an
   **OAuth client ID** of type *Desktop app* → gives `CWS_CLIENT_ID` +
   `CWS_CLIENT_SECRET`.
3. Mint a refresh token for the publisher account with the
   `https://www.googleapis.com/auth/chromewebstore` scope → `CWS_REFRESH_TOKEN`.

### 3. Edge Add-ons

1. Register the publisher on the Microsoft Edge program in Partner Center:
   https://partner.microsoft.com/dashboard/microsoftedge (free).
2. Create the extension listing, upload the same zip, reuse the same copy and
   assets from [`store/listing.md`](listing.md). Submit for review.
3. Note the **Product ID** from the listing page → `EDGE_PRODUCT_ID`.
4. Partner Center → Publish API settings → generate API credentials →
   `EDGE_CLIENT_ID` + `EDGE_API_KEY`.

### 4. Repo secrets

GitHub → repo → Settings → Secrets and variables → Actions → add:

| Secret | From |
|---|---|
| `CWS_EXTENSION_ID` | step 1.6 |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | step 2 |
| `EDGE_PRODUCT_ID` | step 3.3 |
| `EDGE_CLIENT_ID`, `EDGE_API_KEY` | step 3.4 |

These are repo-scoped store-publish keys only — nothing else ever lands in
this public repo.

## Every release after that

1. Bump `version` in `src/manifest.json` **and** `package.json` (keep them
   equal), commit via PR.
2. Tag and push:
   ```sh
   git tag v<version> && git push origin v<version>
   ```
3. The [Release workflow](../.github/workflows/release.yml) builds, verifies
   the tag matches the manifest, uploads to both stores, and submits for
   review. Store review approves → the update goes live automatically.

The zip is also attached to the workflow run as an artifact, and the build is
reproducible (`npm ci && npm run build` is byte-identical), so reviewers can
diff any shipped package against its tag.
