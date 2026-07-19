---
name: publish-local-extension
description: Build the AskFutures Clipper's unpacked dist/ folder in the local checkout at /Users/julianmulla/conductor/repos/askfutures-web-clipper, ready to load at chrome://extensions. Just a local dev build — no versioning, no packaging, no store upload. Triggers on "/publish-local-extension", "build the local extension", "build dist for the clipper", "rebuild the unpacked extension".
user-invocable: true
---

# Publish Local Extension (build dist/ in the main checkout)

Builds the extension into `dist/` in the local repo at
**`/Users/julianmulla/conductor/repos/askfutures-web-clipper`** so it can be
loaded as an unpacked extension for local testing. This is a plain dev build —
it does **not** bump the version, package a zip, or touch the Chrome Web Store
(for that, use `/publish-chrome-extension`).

## Procedure

1. **Confirm the repo exists.** The directory
   `/Users/julianmulla/conductor/repos/askfutures-web-clipper` must contain
   `package.json` and `build.mjs`. If it doesn't, stop and tell the user the
   checkout is missing.

2. **Check freshness against `origin/main`.** This is the *main* checkout and
   can lag behind — a stale build silently ships old code. Fetch and compare:
   ```bash
   cd /Users/julianmulla/conductor/repos/askfutures-web-clipper && git fetch origin --quiet && \
     echo "branch=$(git branch --show-current) behind=$(git rev-list --count HEAD..origin/main) dirty=$(git status --porcelain | wc -l | tr -d ' ')"
   ```
   - If `behind` > 0 and the tree is clean and on `main`, fast-forward it
     (`git pull --ff-only origin main`) so the build reflects current code, then
     tell the user you updated it.
   - If the tree is dirty or on another branch, **don't** pull — warn the user
     it's `N` commits behind and build what's there (or ask), so you never
     discard their local work.

3. **Install deps if needed.** Run `npm ci` if `node_modules/` is absent **or**
   if you just pulled (dependencies may have changed):
   ```bash
   cd /Users/julianmulla/conductor/repos/askfutures-web-clipper && npm ci
   ```

4. **Build `dist/`.** Run the build in that directory:
   ```bash
   cd /Users/julianmulla/conductor/repos/askfutures-web-clipper && npm run build
   ```
   If it fails, report the error and stop.

5. **Confirm the output.** Verify `dist/manifest.json` exists and report the
   built version:
   ```bash
   cd /Users/julianmulla/conductor/repos/askfutures-web-clipper && ls dist && grep '"version"' dist/manifest.json
   ```

## Report

Tell the user the build succeeded, the version in `dist/manifest.json`, and the
path to load:

> Built `dist/` at `/Users/julianmulla/conductor/repos/askfutures-web-clipper/dist`.
> Load it at `chrome://extensions` → enable **Developer mode** → **Load
> unpacked** → select that `dist/` folder. If it's already loaded, click the
> **reload** ↻ icon on the extension card to pick up the rebuild.

## Notes

- This always builds the **main checkout**, not whatever workspace the session
  happens to be in — that's the point of the hardcoded path.
- The build is a no-op on version/state: `dist/` is gitignored and nothing is
  committed, tagged, or uploaded.
