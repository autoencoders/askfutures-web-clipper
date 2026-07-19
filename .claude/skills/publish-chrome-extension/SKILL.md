---
name: publish-chrome-extension
description: Bump the AskFutures Clipper's version and publish it to the Chrome Web Store. Bumps src/manifest.json + package.json + package-lock.json (kept equal), verifies + packages the build, and uploads/publishes to the Chrome Web Store via store/publish-chrome.sh with credentials from Doppler (eng/dev). Guards against re-uploading an already-published version. Triggers on "publish the clipper/extension", "/publish-chrome-extension", "bump version and publish", "ship a clipper release to the Chrome store". Chrome only — Edge is out of scope.
argument-hint: "[patch|minor|major|X.Y.Z]  (default: patch)"
user-invocable: true
---

# Publish Chrome Extension (bump + publish)

Cuts a release of the **AskFutures Clipper** MV3 extension: bumps the version,
verifies and packages the build, and publishes it to the Chrome Web Store. This
is the by-hand path from [`store/PUBLISHING.md`](../../../store/PUBLISHING.md) —
it uses the exact `store/publish-chrome.sh` script CI would run, with the store
credentials pulled from Doppler at run time. Nothing store-related is ever
committed to the (public) repo. **Chrome only** — Edge is deliberately out of
scope.

## Usage

```
/publish-chrome-extension [patch|minor|major|X.Y.Z]
```

The argument selects the version bump; **default is `patch`**. Pass an explicit
`X.Y.Z` to set an exact version.

## Two publish paths — pick by checking `DOPPLER_TOKEN`

There are two ways the publish itself can run; the version-bump steps are the
same for both:

- **By-hand (default, this skill's main path):** `doppler run … bash
  store/publish-chrome.sh` from this machine. Needs only the `CWS_*` secrets in
  Doppler `eng/dev` plus local `doppler` auth.
- **Tag-driven CI:** pushing a `vX.Y.Z` tag triggers
  `.github/workflows/release.yml`, which builds, checks the tag matches the
  manifest version, and publishes under `doppler run`. This needs the GitHub
  repo secret **`DOPPLER_TOKEN`** (a Doppler service token scoped to `eng/dev`).

Check `gh secret list` early. If `DOPPLER_TOKEN` is **absent** (the usual state
— see the caveat in step 8), the tag path will fail at the publish step, so use
the by-hand path and only push a tag if the user wants the marker. If it **is**
set, the canonical release is just the bump + merge + tag, and CI does the
packaging + publish; the by-hand path stays as the fallback.

## Preconditions (check first; stop on any failure)

1. **Right repo.** The working directory must be the extension repo — it must
   contain `src/manifest.json`, `package.json`, and `store/publish-chrome.sh`.
   If not, stop and tell the user to run this from the clipper repo.
2. **Clean tree, current with `main`.** Run `git fetch`. Require a clean working
   tree (`git status --porcelain` empty). The release build should come from
   `origin/main`'s state — the release branch is cut from `origin/main` in
   step 5, so local drift mostly doesn't matter, but if the working tree has
   unmerged feature work the user expected in the release, surface that before
   continuing.
3. **Doppler creds reachable.** Confirm the store credentials exist:
   ```bash
   doppler secrets --project eng --config dev --json | jq -e '.CWS_EXTENSION_ID and .CWS_CLIENT_ID and .CWS_CLIENT_SECRET and .CWS_REFRESH_TOKEN' >/dev/null
   ```
   If this fails, stop — the machine's Doppler CLI isn't authorized for the
   `eng/dev` config; the user must fix Doppler access (do not hunt for the
   secrets elsewhere or paste them anywhere). Minting the OAuth credentials in
   the first place is a human-only, one-time setup — see `store/PUBLISHING.md`
   Part 3.

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

3. **Branch off `origin/main`.** Cut the release branch from the remote default
   branch, not local state:
   ```bash
   git fetch origin -q && git checkout -b release/v<new> origin/main
   ```

4. **Bump all three files, kept equal** (`release.yml` fails the release if the
   tag ≠ manifest version):
   - `npm version <new> --no-git-tag-version` — updates `package.json` **and**
     `package-lock.json` together.
   - Edit `src/manifest.json` `"version"` to the same value.

5. **Verify.** Run `npm ci` if `node_modules/` is missing, then `npm run verify`
   (typecheck + build). If it fails, stop — do not publish a broken build.

6. **Commit the bump.** Invoke the **/commit** skill to commit the three changed
   files on `release/v<new>`. Push the branch (`git push -u origin
   release/v<new>`) and open a PR to `main` with `gh pr create --base main`
   (title `Release v<new>`), then enable squash auto-merge
   (`gh pr merge --squash --auto`). This records the bump; the store submission
   below doesn't wait on the merge. Two push gotchas:
   - A version bump doesn't touch `.github/`, so HTTPS is fine — but if a push
     is ever rejected for lacking `workflow` scope, switch the remote to SSH:
     `git remote set-url origin git@github.com:autoencoders/askfutures-web-clipper.git`.
   - Don't use `gh pr merge --delete-branch` from a Conductor worktree — its
     local switch-to-main step fails because `main` is checked out elsewhere.
     If the remote branch needs cleaning up after merge, use
     `git push origin --delete release/v<new>` instead.

7. **Package.** Run `npm run package` → `askfutures-clipper.zip` at the repo
   root. Sanity-check the manifest inside the zip matches the new version:
   ```bash
   unzip -p askfutures-clipper.zip manifest.json | grep '"version"'
   ```

8. **Publish to the Chrome Web Store.** This is the outward-facing, hard-to-
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

9. **Tag (optional).** After the release PR merges, mark the release on the
   merged commit:
   ```bash
   git fetch origin main -q
   git tag v<new> $(git rev-parse origin/main) && git push origin v<new>
   ```
   **Caveat:** pushing the tag triggers `.github/workflows/release.yml`, whose
   publish step needs the `DOPPLER_TOKEN` repo secret. If that secret isn't set
   (`gh secret list` is empty), the tag's CI run will **fail at the publish
   step** even though the by-hand publish above already succeeded. Only push the
   tag if the user wants the marker and accepts the red CI run, or once
   `DOPPLER_TOKEN` is configured. Ask before pushing the tag. (If
   `DOPPLER_TOKEN` *is* set and you're using the tag as the publish mechanism,
   watch the run with `gh run watch --exit-status` and report the outcome
   instead of running step 8 by hand.)

## Report

Tell the user: the version shipped (old → new), that it's **submitted for
review** on the Chrome Web Store (item `fnodahfcecappofoiphcdfcabbpaahla`) and
goes live automatically on approval (review turnaround is typically hours to
~3 days), the release PR link, and whether a tag was pushed. Note that **Edge
Add-ons** is a separate, still-unlisted store (see `store/PUBLISHING.md`
Part 2) — this skill only does Chrome.

## Notes

- **Never** print, commit, or echo the CWS credentials. They live only in
  Doppler; `doppler run` injects them for the one command and nothing else.
  CI sees them only through the `DOPPLER_TOKEN` service token.
- The build is reproducible (`npm ci && npm run build` is byte-identical), so
  the published zip can be diffed against the tagged source by reviewers.
- The extension ID is public: `fnodahfcecappofoiphcdfcabbpaahla`.
- For refreshing a locally-loaded unpacked dev build instead of shipping to the
  store, use `/publish-local-extension`.
