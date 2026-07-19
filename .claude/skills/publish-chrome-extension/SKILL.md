---
name: publish-chrome-extension
description: Bump the AskFutures Clipper's version and publish it to the Chrome Web Store. Bumps src/manifest.json + package.json (kept equal), verifies + packages the build, and uploads/publishes to the Chrome Web Store via store/publish-chrome.sh with credentials from Doppler (eng/dev). Guards against re-uploading an already-published version. Triggers on "publish the clipper/extension", "/publish-chrome-extension", "bump version and publish", "ship a clipper release to the Chrome store".
user-invocable: true
---

# Publish Chrome Extension (bump + publish)

Cuts a release of the **AskFutures Clipper** MV3 extension: bumps the version,
verifies and packages the build, and publishes it to the Chrome Web Store. This
is the by-hand path from [`store/PUBLISHING.md`](../../PUBLISHING.md) — it uses
the exact `store/publish-chrome.sh` script CI would run, with the store
credentials pulled from Doppler at run time. Nothing store-related is ever
committed to the (public) repo.

## Usage

```
/publish-chrome-extension [patch|minor|major|X.Y.Z]
```

The argument selects the version bump; **default is `patch`**. Pass an explicit
`X.Y.Z` to set an exact version.

## Preconditions (check first; stop on any failure)

1. **Right repo.** The working directory must be the extension repo — it must
   contain `src/manifest.json`, `package.json`, and `store/publish-chrome.sh`.
   If not, stop and tell the user to run this from the clipper repo.
2. **Clean tree, current with `main`.** Run `git fetch`. Require a clean working
   tree (`git status --porcelain` empty). The release build should come from
   `origin/main`'s state — if `HEAD` isn't on/at `origin/main`, warn the user
   and confirm before continuing (the reproducible build only means something
   against a committed state).
3. **Doppler creds reachable.** Confirm the store credentials exist:
   ```bash
   doppler secrets --project eng --config dev --json | jq -e '.CWS_EXTENSION_ID and .CWS_CLIENT_ID and .CWS_CLIENT_SECRET and .CWS_REFRESH_TOKEN' >/dev/null
   ```
   If this fails, stop — the machine's Doppler CLI isn't authorized for the
   `eng/dev` config; the user must fix Doppler access (do not hunt for the
   secrets elsewhere or paste them anywhere).

## Procedure (run in order)

1. **Parse the bump.** Read the current version from `src/manifest.json`.
   Cross-check `package.json` has the **same** version — if they differ, stop
   and report the mismatch (they must always move together). Compute the new
   version from the argument (`patch`/`minor`/`major` bump of the current
   version, or the explicit `X.Y.Z`).

2. **Check the store floor.** The store rejects any upload whose version isn't
   strictly greater than what's already published (`PKG_INVALID_VERSION_NUMBER`).
   Fetch the currently published version and make sure the new one clears it:
   ```bash
   doppler run --project eng --config dev -- bash -c '
     TOKEN=$(curl -sf -X POST https://oauth2.googleapis.com/token \
       -d client_id="$CWS_CLIENT_ID" -d client_secret="$CWS_CLIENT_SECRET" \
       -d refresh_token="$CWS_REFRESH_TOKEN" -d grant_type=refresh_token | jq -re .access_token)
     curl -sf -H "Authorization: Bearer $TOKEN" -H "x-goog-api-version: 2" \
       "https://www.googleapis.com/chromewebstore/v1.1/items/$CWS_EXTENSION_ID?projection=DRAFT" \
       | jq -r .crxVersion'
   ```
   If the new version is **not** strictly greater than both the current source
   version and this published `crxVersion`, stop and tell the user what floor
   they need to clear (e.g. "0.4.1 is already published — bump to at least
   0.4.2"). Do **not** bump higher on your own to force it past.

3. **Bump both files.** Set `version` to the new value in **both**
   `src/manifest.json` and `package.json`. Keep them identical.

4. **Verify.** Run `npm ci` if `node_modules/` is missing, then `npm run verify`
   (typecheck + build). If it fails, stop — do not publish a broken build.

5. **Commit the bump.** Create a branch `release/v<new>` off the current commit,
   then invoke the **/commit** skill to commit the two changed files. Push the
   branch and open a PR to `main` with `gh pr create --base main` (title
   `Release v<new>`), and enable squash auto-merge
   (`gh pr merge --squash --auto`). This records the bump; the store submission
   below doesn't wait on the merge.

6. **Package.** Run `npm run package` → `askfutures-clipper.zip` at the repo
   root. Sanity-check the manifest inside the zip matches the new version:
   ```bash
   unzip -p askfutures-clipper.zip manifest.json | grep '"version"'
   ```

7. **Publish to the Chrome Web Store.** This is the outward-facing, hard-to-
   reverse step — it uploads and submits for review:
   ```bash
   doppler run --project eng --config dev -- bash store/publish-chrome.sh
   ```
   The script prints two JSON blobs. Confirm `"uploadState": "SUCCESS"` on the
   upload and a status containing `"OK"` on the publish. Known failure modes:
   - **Upload `FAILURE` with `PKG_INVALID_VERSION_NUMBER`** → step 2's floor
     check was stale; re-check the published version and bump higher.
   - **Script exits non-zero after `uploadState: SUCCESS` (e.g. curl exit 56)**
     → the upload landed but the *publish* POST hit a transient network error
     (the script's `set -e` aborts before printing it). The draft is already
     updated; just retry the publish POST alone:
     ```bash
     doppler run --project eng --config dev -- bash -c '
       TOKEN=$(curl -sf -X POST https://oauth2.googleapis.com/token \
         -d client_id="$CWS_CLIENT_ID" -d client_secret="$CWS_CLIENT_SECRET" \
         -d refresh_token="$CWS_REFRESH_TOKEN" -d grant_type=refresh_token | jq -re .access_token)
       curl -s --retry 3 --retry-all-errors -X POST -H "Authorization: Bearer $TOKEN" \
         -H "x-goog-api-version: 2" -H "Content-Length: 0" \
         "https://www.googleapis.com/chromewebstore/v1.1/items/$CWS_EXTENSION_ID/publish"'
     ```
   - **Publish returns HTTP 400 "Publish condition not met: ... Privacy
     practices tab"** → the listing's mandatory privacy disclosures aren't
     filled in. This is a **manual, dashboard-only** step (no API): the user
     must open https://chrome.google.com/webstore/devconsole → the item →
     **Privacy practices** tab and complete the single-purpose description,
     per-permission justifications, and data-usage disclosures (copy lives in
     `store/listing.md`), then click Publish (or re-run the publish POST above).
     **Stop and hand this to the user** — you cannot complete it. The new
     version is already uploaded to the draft, so nothing is lost; it publishes
     the moment the tab is completed.

8. **Tag (optional).** After the release PR merges, mark the release:
   ```bash
   git tag v<new> && git push origin v<new>
   ```
   **Caveat:** pushing the tag triggers `.github/workflows/release.yml`, whose
   publish step needs the `DOPPLER_TOKEN` repo secret. If that secret isn't set
   (`gh secret list` is empty), the tag's CI run will **fail at the publish
   step** even though the by-hand publish above already succeeded. Only push the
   tag if the user wants the marker and accepts the red CI run, or once
   `DOPPLER_TOKEN` is configured. Ask before pushing the tag.

## Report

Tell the user: the version shipped (old → new), that it's **submitted for
review** on the Chrome Web Store (item `fnodahfcecappofoiphcdfcabbpaahla`) and
goes live automatically on approval, the release PR link, and whether a tag was
pushed. Note that **Edge Add-ons** is a separate, still-unlisted store (see
`store/PUBLISHING.md` Part 2) — this skill only does Chrome.

## Notes

- **Never** print, commit, or echo the CWS credentials. They live only in
  Doppler; `doppler run` injects them for the one command and nothing else.
- The build is reproducible (`npm ci && npm run build` is byte-identical), so
  the published zip can be diffed against the tagged source by reviewers.
- If the tag-driven CI path is ever wired up (`DOPPLER_TOKEN` set as a repo
  secret), the canonical release is just steps 1–5 + push the tag, and CI does
  the packaging + publish — this by-hand path stays as the fallback.
