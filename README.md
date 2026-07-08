# AskFutures Clipper

A browser extension that clips the page you're reading — articles or YouTube
transcripts — into [askfutures.com](https://askfutures.com) to analyze as a
trading strategy. One click, nothing else.

## What it does

Click the toolbar button on any page:

1. The extension extracts the page's readable content **in your browser, in the
   page's own origin**, using [defuddle](https://github.com/kepano/defuddle)
   (MIT) — the extraction library behind Obsidian Web Clipper. On YouTube it
   extracts the video transcript using defuddle's YouTube extractor.
2. It opens (or focuses) `https://askfutures.com/analyze` and hands the clip to
   the page over an origin-checked `window.postMessage` handshake — see
   [SECURITY.md](SECURITY.md) for the exact contract.
3. The `/analyze` page shows you a preview and analyzes the content only when
   you confirm.

The clip is buffered in `chrome.storage.session` (memory-backed, cleared when
the browser exits) until the page acknowledges receipt, so it survives a slow
page load or a sign-in redirect. Clips larger than 2 MB are refused with a
clear message.

## Permissions — deliberately minimal

| Permission | Why |
|---|---|
| `activeTab` | read the page you clicked on, only when you click |
| `scripting` | inject the extractor into that page |
| `storage` | buffer the clip until askfutures.com acknowledges it |
| `https://askfutures.com/*` | the handoff content script on the `/analyze` page |

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

## Credits

Content extraction is [defuddle](https://github.com/kepano/defuddle) by
[kepano](https://github.com/kepano), MIT-licensed and bundled unmodified. If
you want general-purpose web clipping into your own notes, use
[Obsidian Web Clipper](https://obsidian.md/clipper) — this extension
deliberately does one thing only.

## License

[MIT](LICENSE)
