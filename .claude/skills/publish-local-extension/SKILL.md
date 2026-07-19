---
name: publish-local-extension
description: Build/refresh the AskFutures Clipper's unpacked dist/ folder in the stable local checkout so a Reload in chrome://extensions picks up the latest code, with a stamped dev version as visible proof the reload took. No packaging, no store upload. Triggers on "/publish-local-extension", "build the local extension", "update the unpacked extension", "refresh my local extension build", "update the dev extension in Chrome".
argument-hint: "[path-to-checkout]  (default: ~/conductor/repos/askfutures-web-clipper)"
user-invocable: true
---

# Publish Local Extension (refresh the unpacked Chrome dev build)

Rebuilds the `dist/` folder that a locally-loaded (unpacked) AskFutures Clipper
extension is loaded from, so hitting **Reload** in `chrome://extensions` shows
the latest code. This does **not** bump the release version, package a zip, or
touch the Chrome Web Store (for that, use `/publish-chrome-extension`).

## Which folder Chrome loads

An unpacked extension is loaded from a `dist/` directory on disk and does
**not** auto-update. The stable checkout for local dev is the Conductor "repos"
copy — **not** an ephemeral workspace/worktree, whose path changes and whose
extension would get a different unpacked ID. Resolve the target directory `D`
in this order (no hardcoded usernames — this must work on any machine):

1. The argument, if given.
2. `$HOME/conductor/repos/askfutures-web-clipper`, if it exists.
3. The current repo, if it *is* the clipper repo (has `src/manifest.json` and
   `build.mjs`) and isn't an ephemeral worktree — warn that the unpacked ID is
   path-dependent.
4. Otherwise stop and ask where the unpacked extension is loaded from (the
   card in `chrome://extensions` shows the path under expanded details).

Sanity-check `D` contains `package.json`, `src/manifest.json`, and `build.mjs`
before doing anything.

## Procedure

1. **Sync to latest `origin/main` — only when safe (never clobber):**
   - `git -C "$D" status --porcelain` — if **dirty**, do NOT pull; skip to the
     build and warn that you're building the working tree as-is.
   - `git -C "$D" fetch origin main -q`.
   - Only if the checkout is on `main`
     (`git -C "$D" branch --show-current` = `main`) **and** it fast-forwards
     (`git -C "$D" merge-base --is-ancestor HEAD origin/main`):
     `git -C "$D" merge --ff-only origin/main`, then tell the user you updated
     it.
   - If on another branch or diverged, leave it alone and build the current
     state — the user may be testing a branch on purpose; say so, noting how
     many commits behind `origin/main` it is.

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

5. **Confirm the output.** Verify `dist/manifest.json` exists and report the
   stamped `version` (and `version_name`).

## Report

Tell the user the build succeeded, the stamped dev version, and the path to
load:

> Built `dist/` at `<D>/dist` (dev version `X.Y.Z.N`).
> Load it at `chrome://extensions` → enable **Developer mode** → **Load
> unpacked** → select that `dist/` folder. If it's already loaded, click the
> **↻ reload** icon on the extension card — its **Version** should flip to
> `X.Y.Z.N`; the trailing number climbs by one every run, so if it didn't
> change, the Reload didn't take.

## Notes

- The unpacked build and the Web Store build are separate installs with
  separate IDs — this touches only the unpacked dev copy.
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
