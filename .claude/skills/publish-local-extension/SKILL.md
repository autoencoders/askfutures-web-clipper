---
name: publish-local-extension
description: Build/refresh the AskFutures Clipper's unpacked dist/ folder in the stable local checkout so a Reload in chrome://extensions picks up the latest code, with a stamped dev version as visible proof the reload took. No packaging, no store upload. Triggers on "/publish-local-extension", "build the local extension", "update the unpacked extension", "refresh my local extension build", "update the dev extension in Chrome".
argument-hint: "[path-to-checkout]  (default: ~/wt/repos/askfutures-web-clipper)"
user-invocable: true
---

# Publish Local Extension (refresh the unpacked Chrome dev build)

Rebuilds the `dist/` folder that a locally-loaded (unpacked) AskFutures Clipper
extension is loaded from, so hitting **Reload** in `chrome://extensions` shows
the latest code. This does **not** bump the release version, package a zip, or
touch the Chrome Web Store (for that, use `/publish-chrome-extension`).

## Which folder Chrome loads

An unpacked extension is loaded from a `dist/` directory on disk and does
**not** auto-update. Chrome derives an unpacked extension's **ID from its path**,
so the target must be the one checkout whose path never changes: the `repos/`
copy that `wt` clones into — **not** a `workspaces/` worktree, which is
ephemeral, gets a different unpacked ID, and breaks the install the moment it
is removed. One unpacked install off `repos/` serves every branch.

Resolve the target directory `D` in this order (no hardcoded usernames — this
must work on any machine):

1. The argument, if given.
2. `$HOME/wt/repos/askfutures-web-clipper`, if it exists.
3. The current repo, if it *is* the clipper repo (has `src/manifest.json` and
   `build.mjs`) **and** is not a linked worktree — check with
   `git -C "$D" rev-parse --git-common-dir`, which for a worktree points at
   another checkout's `.git` rather than `$D/.git`. Warn that the unpacked ID
   is path-dependent.
4. Otherwise stop and ask where the unpacked extension is loaded from (the
   card in `chrome://extensions` shows the path under expanded details).

Never silently build into a `workspaces/` worktree: a build there loads as a
*second, separate* extension rather than refreshing the one already installed,
which looks like the reload silently failing.

Sanity-check `D` contains `package.json`, `src/manifest.json`, and `build.mjs`
before doing anything.

## Procedure

1. **Always bring `D` up to `origin/main` before building.** Building stale
   code is the failure this skill exists to prevent, and it hides well: step 4
   stamps a *fresh* dev version on every run, so a build of week-old code
   still shows a version that just went up. The user reads that as proof the
   reload took. Never let a sync be skipped quietly.

   - `git -C "$D" fetch origin main -q`.
   - `git -C "$D" status --porcelain` and
     `git -C "$D" branch --show-current`, and record how far behind it is:
     `git -C "$D" rev-list --count HEAD..origin/main`.
   - **Clean, on `main`, and fast-forwards**
     (`git -C "$D" merge-base --is-ancestor HEAD origin/main`):
     `git -C "$D" merge --ff-only origin/main`. Report the before → after
     commit. This is the normal path.
   - **Already up to date:** say so explicitly — "already at `<sha>`" — so a
     no-op sync is never mistaken for a skipped one.
   - **Anything else** — uncommitted changes, on another branch, or diverged:
     do **not** pull (never clobber someone's work or yank them off a branch
     they are testing on purpose) and do **not** build silently either. Say
     which case it is and exactly how many commits behind `origin/main` the
     checkout sits, then **ask** whether to build it as-is or to sort the
     checkout out first. Only build stale when the user says to.
   - If the checkout is behind and the user wants it fixed, the repair
     depends on the case: commit or set aside the local changes, or switch
     back to `main`. Do not invent a recovery — surface the state and let the
     user choose.

2. **Install deps if needed.** Run `( cd "$D" && npm ci )` if `node_modules/`
   is absent **or** if you just pulled (dependencies may have changed).

3. **Rebuild `dist/`.** `( cd "$D" && npm run build )`. `build.mjs` uses
   cwd-relative paths, so `cd` into `D` in a subshell — `npm --prefix` won't
   work. If it fails, report the error and stop.

4. **Stamp a unique dev version** so the extension card visibly changes on
   **every** Reload — even when `main` didn't move — giving the user positive
   proof the reload took. This edits only the freshly-built
   `dist/manifest.json`, which `build.mjs` overwrites from `src/manifest.json`
   on each build (so the stamp never accumulates) and which is gitignored (so
   it never dirties the checkout or the ff-pull in step 1). It **must not**
   touch `src/manifest.json` — that is the real release version
   `/publish-chrome-extension` and `release.yml` depend on.

   The version becomes `<src version, first 3 parts>.<N>` and `version_name`
   becomes `<src version> dev <N>`, where `N` is a monotonic counter persisted
   per-machine in `~/.cache` (deliberately **outside** the repo — it's local
   state, not source), incremented each run so the 4th component strictly
   climbs (`0.4.3.1` → `0.4.3.2` → …):

   ```bash
   STAMP="$HOME/.cache/askfutures-clipper/dev-build-counter"
   mkdir -p "$(dirname "$STAMP")"
   N=$(( $(cat "$STAMP" 2>/dev/null || echo 0) + 1 )); printf '%s\n' "$N" > "$STAMP"
   node -e 'const f=process.argv[1],n=process.argv[2],fs=require("fs");
   const m=JSON.parse(fs.readFileSync(f,"utf8"));
   const base=String(m.version).split(".").slice(0,3).join(".");
   m.version=base+"."+n; m.version_name=base+" dev "+n;
   fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n");
   console.log("dev version →",m.version);' "$D/dist/manifest.json" "$N"
   ```

   (Chrome versions are 1–4 integers each 0–65535, so a numeric 4th component
   is the only reliably card-visible signal — pre-release suffixes like `-dev`
   are invalid. Unpacked **Reload** does not require the version to increase,
   but keeping it monotonic avoids any ambiguity.)

5. **Pin the unpacked ID to the Web Store ID.** Chrome derives an unpacked
   extension's ID from its path, so the dev build would otherwise load under a
   different origin than the published one — and askfutures.com only allows
   framing (`frame-ancestors`) by the *published* extension's origin, so the
   side panel would show "askfutures.com refused to connect" in the dev build
   even though it works in the store build. Adding the store item's **public**
   key to the built manifest gives the unpacked build the store ID:

   ```bash
   node -e 'const f=process.argv[1],k=process.argv[2],fs=require("fs");
   const m=JSON.parse(fs.readFileSync(f,"utf8")); m.key=k;
   fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n");
   console.log("pinned unpacked id \u2192 fnodahfcecappofoiphcdfcabbpaahla");' \
     "$D/dist/manifest.json" \
     "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArqAWmzp9RwVItkRYYAmYyPDGnVJZBcI217LP0o9li+943zSdbhA+ewu0qWPBas/h4TurTLCxR8py7RnBQJ6byVQVsxycC3Vtks5sVCwAoHqVDqWOCiH2dnpMHr8j60d+Nja4BRepZcZys1bvnxLwMao/fi/QLuL80WNdNzulIPTy/IuZwO8/N1tuWAfvSKol3CGBvhE7BVys/MUAv/EbNT+Eo5xdOH67ZoqVKCHgapKcYcjVHa4Du8Y5neJGLo+pgg+WzA0dy//lpr7VOUFc4mIV5h8V0f8PYHuAx1WfX+EIz8J0DINNdRoNOBnHwpfb/HWt7AQ2DeV68lh7QGlD3QIDAQAB"
   ```

   Like the version stamp, this edits only the built `dist/manifest.json` —
   never `src/manifest.json`, so the store zip `/publish-chrome-extension`
   uploads stays exactly as it is today.

6. **Confirm the output.** Verify `dist/manifest.json` exists and report the
   stamped `version` (and `version_name`).

## Report

Tell the user the build succeeded, the stamped dev version, and the path to
load:

> Built `dist/` at `<D>/dist` from `origin/main` at `<sha>` (dev version
> `X.Y.Z.N`).
> Load it at `chrome://extensions` → enable **Developer mode** → **Load
> unpacked** → select that `dist/` folder. If it's already loaded, click the
> **↻ reload** icon on the extension card — its **Version** should flip to
> `X.Y.Z.N`; the trailing number climbs by one every run, so if it didn't
> change, the Reload didn't take.

Always name the commit the build came from. The dev version proves the reload
took; only the commit proves *what* it reloaded.

## Notes

- The unpacked build and the Web Store build are separate installs that now
  share one **ID**, because step 5 pins it (see there for why). Consequences:
  Chrome refuses to load the unpacked build in a profile that already has the
  store build installed — remove one or use a separate profile; and the first
  build after this pin was introduced changes the dev install's ID, so Chrome
  treats it as a new extension: **Remove** the old unpacked card and **Load
  unpacked** the same `dist/` folder again. Reload alone won't do it.
- The `key` is the store item's **public** key, lifted from the published CRX
  (`Cr24` header) — not a signing secret, and safe in a public repo. Re-derive
  it by downloading the item from `clients2.google.com/service/update2/crx` and
  reading the public key out of the CRX3 header; SHA-256 of those bytes,
  first 16 bytes hex-mapped `0-f` → `a-p`, must equal
  `fnodahfcecappofoiphcdfcabbpaahla`.
- The stamped dev version (`X.Y.Z.<N>`) lives **only** in the built
  `dist/manifest.json`; `src/manifest.json` stays at the real release version.
  The `<N>` counter is a per-machine convenience in
  `~/.cache/askfutures-clipper/dev-build-counter` — not tracked in git, no
  bearing on `/publish-chrome-extension` or the tag-vs-manifest check in
  `release.yml`. Delete the file to reset it; the count differing across
  machines is fine.
- Chrome can't reload an unpacked extension from the CLI, so the manual **↻**
  click is required by design — this skill only refreshes the files on disk so
  that click has something new to pick up.
