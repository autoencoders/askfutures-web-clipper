# AskFutures Clipper

A browser extension that clips the page you're reading — articles, PDF papers,
or YouTube transcripts — into [askfutures.com](https://askfutures.com) to
analyze as a trading strategy. Clip, glance at the preview, send.

## What it does

Click the toolbar button on any page:

1. The extension extracts the page's readable content **in your browser, in the
   page's own origin**, using [defuddle](https://github.com/kepano/defuddle)
   (MIT) — the extraction library behind Obsidian Web Clipper. On YouTube it
   extracts the video transcript using defuddle's YouTube extractor.
2. A small preview card appears on the page — source (tinted with the site's
   own icon and theme color), title, and word count — so you can confirm what
   was captured. Click **Send to AskFutures** to hand it off, or dismiss it.
3. Sending opens (or focuses) `https://askfutures.com/analyze` and delivers the
   clip to the page over an origin-checked `window.postMessage` handshake — see
   [SECURITY.md](SECURITY.md) for the exact contract. The `/analyze` page shows
   its own preview and analyzes the content only when you confirm there.

The clip is buffered in `chrome.storage.session` (memory-backed, cleared when
the browser exits) until the page acknowledges receipt, so it survives a slow
page load or a sign-in redirect. Clips larger than 2 MB are refused with a
clear message.

**PDFs** work a little differently. Chrome's built-in PDF viewer accepts no
script injection, so on a PDF tab the extension extracts the text layer with
[pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0, bundled) in an
offscreen document instead, and — since the preview card can't render there —
the toolbar click itself is the confirmation: the clip goes straight to
`/analyze`. Text-layer PDFs only; scanned (image-only) PDFs aren't supported —
there's no OCR — and fail with a clear message in the button's hover title.

**One exception:** on trading sites — [gocharting.com](https://gocharting.com),
[tradingview.com](https://tradingview.com),
[robinhood.com](https://robinhood.com),
[ninjatrader.com](https://ninjatrader.com), and
[cmegroup.com](https://cmegroup.com) — the toolbar button doesn't clip.
It opens askfutures.com in Chrome's side panel instead, so the chart and
AskFutures sit side by side in the same window. On gocharting.com and
tradingview.com the panel also passes the chart's context into askfutures.com —
ticker, timeframe, the indicators on the chart with their last values, and the
last price — as a snapshot at panel open, refreshable on request (see
[SECURITY.md](SECURITY.md) for the contract).

## Permissions — deliberately minimal

| Permission | Why |
|---|---|
| `activeTab` | read the page you clicked on, only when you click |
| `scripting` | inject the extractor into that page |
| `storage` | buffer the clip until askfutures.com acknowledges it |
| `sidePanel` | show askfutures.com beside the chart on charting sites |
| `offscreen` | parse PDFs with pdf.js in a short-lived offscreen document (created per PDF clip, closed after) |
| `notifications` | clip status on pages that can't host the in-page card (PDF tabs): word count on success, the reason on failure |
| `https://*.askfutures.com/*` | the handoff content script on the `/analyze` page, and first-party cookies for the side panel (sign-in lives on `clerk.askfutures.com`) |

There are no broad host permissions and no background access to your browsing:
the extension can only read a page in direct response to your click
(`activeTab`), and it talks only to askfutures.com. It calls no APIs directly
and holds no accounts, tokens, or secrets.

## Privacy

No telemetry, no analytics, no third parties. Page content is read only when
you click the toolbar button and is sent only to askfutures.com.

## Development

```sh
npm ci
npm run build     # bundles to dist/
```

Then load `dist/` as an unpacked extension: `chrome://extensions` → enable
Developer mode → *Load unpacked* → select `dist/`.

Other scripts:

```sh
npm run typecheck   # tsc --noEmit
npm run verify      # typecheck + build
npm run package     # build + zip for store upload
```

### Reproducible build

Dependencies are exact-pinned and locked; the build is unminified esbuild
output. `npm ci && npm run build` from a clean checkout reproduces `dist/`
byte-for-byte, so reviewers can verify a shipped package against the source.

### Releasing

Store publication (Chrome Web Store + Edge Add-ons) is automated from a
version tag — see [store/PUBLISHING.md](store/PUBLISHING.md). Listing copy
lives in [store/listing.md](store/listing.md); the privacy policy is
[PRIVACY.md](PRIVACY.md).

## Credits

Content extraction is [defuddle](https://github.com/kepano/defuddle) by
[kepano](https://github.com/kepano), MIT-licensed and bundled unmodified. PDF
text extraction is [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla,
Apache-2.0-licensed and bundled unmodified. If
you want general-purpose web clipping into your own notes, use
[Obsidian Web Clipper](https://obsidian.md/clipper) — this extension
deliberately does one thing only.

## License

[MIT](LICENSE)
