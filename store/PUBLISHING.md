# Publishing guide

How AskFutures Clipper gets to the Chrome Web Store and Edge Add-ons. First
publication is manual (both stores require an existing listing before their
APIs work); every release after that is one git tag.

Total active time for first publication is roughly 45–60 minutes, then you
wait on store reviews (hours to ~3 days). Do Part 1 and Part 2 in one
sitting; Part 3 can wait until the listings are approved.

**Before you start:** build the upload file with `npm ci && npm run package`
→ `askfutures-clipper.zip` at the repo root. The screenshots you'll upload
are in [`store/screenshots/`](screenshots/), and all the text you'll paste is
in [`store/listing.md`](listing.md) — keep that file open in a second window
the whole time.

> **Status (2026-07-08):** the Chrome Web Store listing exists and is
> submitted for review — item ID `fnodahfcecappofoiphcdfcabbpaahla`
> (that's `CWS_EXTENSION_ID`). Publisher declared as **trader**; payments
> verification was pending at submission. Edge listing: not yet created.

## Part 1 — Chrome Web Store (~30 min, one-time $5)

1. Go to https://chrome.google.com/webstore/devconsole and sign in with the
   Google account that should *own* the listing long-term (the publisher
   email becomes public on the listing — a company account is better than a
   personal one).
2. First visit walks you through developer registration: accept the
   agreement and pay the **one-time $5 fee** (card required).
3. In **Settings**, complete the **trader declaration**: this is a company
   publishing in connection with its business, so declare **trader** (EU DSA
   requirement). Trader accounts must verify contact details through a
   Google payments profile and display them publicly on EEA listings — use
   the company address. Verification runs in the background; it can hold the
   final publish but not the listing work.
4. Click **"+ New item"** → upload `askfutures-clipper.zip`.
5. You land on the item's edit pages. Work through the tabs, pasting from
   [`store/listing.md`](listing.md):
   - **Store listing tab:** description (the "Detailed description"
     section), category → **Tools**, language → English. Upload the store
     icon (`src/icons/icon128.png`) and the three screenshots from
     `store/screenshots/` (already 1280×800; upload in the order listed at
     the bottom of listing.md).
   - **Privacy tab** — the important one for review:
     - *Single purpose description* → paste the "Single-purpose statement".
     - *Permission justifications* → one text box per permission
       (`activeTab`, `scripting`, `storage`, host permission) — paste each
       from the "Permission justifications" section.
     - *Data usage* → check only **"Website content"**; leave every other
       category unchecked. Then check the three certification boxes (no
       sale, no unrelated use, no creditworthiness use) — our answers in
       listing.md match those certifications.
     - *Privacy policy URL* →
       `https://github.com/autoencoders/askfutures-web-clipper/blob/main/PRIVACY.md`
     - *"Are you using remote code?"* → **No**.
   - **Distribution tab:** visibility **Public**, all regions is fine.
6. Click **Submit for review** (top right). If it complains about anything
   unfilled, it links you straight to the field.
7. **Write down the item ID** — the 32-character string in the dashboard URL
   for your item. That's `CWS_EXTENSION_ID` for Part 3.

## Part 2 — Edge Add-ons (~15 min, free)

1. Go to https://partner.microsoft.com/dashboard/microsoftedge/public/login
   and sign in with a Microsoft account (create one if needed — again,
   prefer a company identity).
2. Register for the Microsoft Edge program (free, just a form).
3. **Create new extension** → upload the same `askfutures-clipper.zip`.
4. Fill the forms — same content, slightly different labels:
   - **Properties:** category → **Productivity**, privacy policy URL → the
     same GitHub PRIVACY.md link, support URL → this GitHub repo.
   - **Store listings (English):** description, the same three screenshots,
     the store logo (`src/icons/icon128.png`).
5. **Publish/Submit.** Note the **Product ID** shown on the extension's
   overview page — that's `EDGE_PRODUCT_ID`.

Edge has no per-permission justification forms, so this half is quicker.

## Part 3 — API credentials + repo secrets (after the listings are approved)

This only enables the automated tag-driven releases — nothing blocks on it
on day one, and it's the fiddliest part (especially Google's OAuth refresh
token).

### Chrome Web Store API

Two options:

- **Service account (preferred, newer):** in a Google Cloud project owned by
  the publisher account, create a service account; then in the dev console →
  Settings → **Service account**, add its email. This grants it API access
  to the publisher's items with no refresh-token dance. Note: the
  [Release workflow](../.github/workflows/release.yml) currently implements
  the refresh-token flow below — switching to a service account means
  updating that workflow to authenticate with the service-account key.
- **OAuth refresh token (what release.yml implements):** follow
  https://developer.chrome.com/docs/webstore/using-api — enable the
  **Chrome Web Store API** in a Cloud project, configure the OAuth consent
  screen, create a *Desktop app* OAuth client (→ `CWS_CLIENT_ID` +
  `CWS_CLIENT_SECRET`), and mint a refresh token for the publisher account
  with the `https://www.googleapis.com/auth/chromewebstore` scope
  (→ `CWS_REFRESH_TOKEN`).

### Edge Add-ons API

Partner Center → Publish API settings → generate API credentials →
`EDGE_CLIENT_ID` + `EDGE_API_KEY`.

### Repo secrets

GitHub → repo → Settings → Secrets and variables → Actions → add:

| Secret | From |
|---|---|
| `CWS_EXTENSION_ID` | Part 1, step 7 |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | Chrome API setup above |
| `EDGE_PRODUCT_ID` | Part 2, step 5 |
| `EDGE_CLIENT_ID`, `EDGE_API_KEY` | Edge API setup above |

These are repo-scoped store-publish keys only — nothing else ever lands in
this public repo.

## After the reviews come back

1. You'll get approval emails (Chrome usually within a day, Edge similar).
   Spot checks are rare, but if a reviewer asks a question, the answers are
   all in [listing.md](listing.md) / [PRIVACY.md](../PRIVACY.md).
2. **Verify:** install from the public Chrome Web Store listing (not an
   unpacked dev copy — keep both if you like, but disable the unpacked one
   to avoid confusion), then clip a YouTube video end-to-end into
   askfutures.com/analyze.
3. Once Part 3's secrets are in, push a test tag and watch the Release
   workflow publish an update automatically.

Common first-timer snags: the $5 payment page sometimes needs a billing
address before it activates; and Chrome's Privacy tab won't let you submit
until *every* permission has a justification filled in. Everything else is
copy-paste.

## Every release after the first

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
