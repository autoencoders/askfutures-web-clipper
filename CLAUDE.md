# askfutures-web-clipper

MV3 browser extension: clips the current page (articles, YouTube transcripts)
into askfutures.com/analyze via a postMessage handshake. Extraction is
defuddle, bundled and pinned — never forked. See README.md and SECURITY.md.

**This repo is public.** Nothing internal lands here: no secrets or tokens, no
internal hostnames or infra topology, no non-public endpoints, no internal
ticket text. The extension talks only to public askfutures.com pages via
postMessage.

## Ticket pipeline config

- **Verify:** `npm run verify` (typecheck + build)
- **Local bring-up:** `npm run build`, then load `dist/` as an unpacked
  extension at `chrome://extensions` (Developer mode → Load unpacked)
- **Post-branch setup:** `npm ci`
