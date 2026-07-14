# Security

## The postMessage contract

The extension hands clips to `https://askfutures.com/analyze` over
`window.postMessage` in the page's window. This is the complete contract; the
`/analyze` page implements the other half.

Message flow (all messages posted to the same window):

```
page       → { type: "askfutures-analyze-ready" }
extension  → { type: "askfutures-clip", nonce: "<uuid>", payload: { … } }
page       → { type: "askfutures-clip-ack", nonce: "<echoed>" }
```

Rules:

- **Origin-checked both ways.** Each side ignores any message where
  `event.origin` is not `https://askfutures.com` or `event.source` is not the
  page's own `window`.
- **Announce and re-announce.** The page posts `askfutures-analyze-ready` when
  its listener is ready and repeats it every second until a clip lands. The
  extension delivers whenever an announcement arrives while a clip is
  buffered, so whichever side loads last, the handshake still completes.
- **Nonce.** The extension generates a fresh nonce for every clip message. The
  page acks every clip it accepts by echoing that nonce, and the extension
  clears its buffer only on an ack whose nonce it actually sent — a forged or
  stale ack cannot discard an undelivered clip.
- **Validation.** The page validates every payload field strictly and ignores
  anything malformed (it never throws at the sender).
- **Buffering.** The clip lives in `chrome.storage.session` (memory-backed,
  never written to disk, cleared on browser exit) until a valid ack arrives.
  A sign-in redirect or slow load on the askfutures side just restarts the
  handshake; the user never has to re-clip.
- **Nothing in URLs.** The payload never touches a URL, query string, browser
  history, or any third party.

### Clip payload (v1)

```jsonc
{
  "v": 1,
  "source_url": "https://www.youtube.com/watch?v=…",  // canonical page URL
  "title": "…",                       // nullable
  "author": "…",                      // nullable
  "published_at": "…",                // nullable, as found on the page
  "clipped_at": "2026-07-08T14:05:00Z", // ISO-8601 UTC, extension clock
  "kind": "youtube" | "article",
  "content_markdown": "…",            // extracted content; transcripts as text
  // Additive optional v1 fields — preview enrichment for the /analyze page.
  // All nullable; a page that predates them simply ignores them.
  "site_name": "YouTube",             // nullable; og:site_name or hostname
  "favicon": "https://…/favicon.ico", // nullable; absolute URL of the site icon
  "theme_color": "#ff0000",           // nullable; validated CSS color from the page
  "thumbnail_url": "https://…/hqdefault.jpg" // nullable; lead image — an article's og:image, or the YouTube thumbnail derived from the video id; absolute URL
}
```

`site_name`, `favicon`, `theme_color`, and `thumbnail_url` are **additive
optional** fields on the same `v: 1` payload — pure UI enrichment. The `v`
number does **not** bump for them: a page that validates `v === 1` and ignores
unknown/null fields keeps working unchanged, and the extension always tolerates
their absence. They carry only public page chrome, never clip content, and
`favicon`/`thumbnail_url` are plain image URLs the page may choose to load from
its own origin. For YouTube the server can also derive the thumbnail from the
video id, so `thumbnail_url` matters mainly for articles.

The extension refuses payloads over 2 MB.

## The chart-context messages (side panel)

On charting sites the toolbar click opens askfutures.com in the extension's
side panel instead of clipping. There, the panel page scrapes a snapshot of
the chart next to it — ticker, timeframe, indicators with their last values,
last price — and posts it into the askfutures.com iframe:

```
panel → iframe   { type: "askfutures-chart-context", payload: { … } }
iframe → panel   { type: "askfutures-chart-context-request" }
```

Rules:

- **Origin-checked both ways.** The panel posts only to
  `https://askfutures.com` (the iframe's origin) and accepts a request only
  when `event.origin` is `https://askfutures.com` and `event.source` is the
  iframe's window. The page inside the iframe should likewise check that the
  context message comes from its parent extension page.
- **Snapshots, fire-and-forget.** No ack or nonce: chart context is
  re-derivable at any time, so a lost message costs nothing — the page just
  posts `askfutures-chart-context-request` and gets a fresh snapshot. There is
  no live observation of the chart; every snapshot is an explicit scrape.
- **Scoped scraping.** The scrape runs only in the tab the panel was opened
  against, only on `gocharting.com` today, and only under the `activeTab`
  grant the opening click produced. The service worker refuses requests for
  any other tab or site, and only extension pages (never content scripts) may
  request a scrape.
- **Validation.** The page treats the payload as untrusted input, like a clip.

### Chart-context payload (v1)

```jsonc
{
  "v": 1,
  "source": "gocharting",
  "source_url": "https://gocharting.com/terminal?ticker=CME:ES1%21",
  "ticker": "CME:ES1!",                // nullable; from the tab URL, legend fallback
  "timeframe": "30m",                  // nullable; from the chart legend
  "last_close": 7586.25,               // nullable; C of the current bar, tab-title fallback
  "ohlc": {                            // nullable; the legend's current bar
    "open": 7586.75, "high": 7590.0, "low": 7584.75, "close": 7586.25
  },
  "indicators": [                      // possibly empty; the study legend rows
    { "name": "EMA", "params": "20", "values": [7581.25] },
    { "name": "MACD", "params": "12, 26, 9", "values": [-3.2, 1.1, -4.3] }
  ],
  "scraped_at": "2026-07-13T14:05:00Z" // ISO-8601 UTC, extension clock
}
```

Every scraped field is nullable and the snapshot degrades per field: the DOM
scrape is regex-over-legend-text with no stable contract from GoCharting, so a
redesign silently empties fields rather than erroring.

## Trust model

- **The page trusts nothing.** Anything on the web can postMessage at
  `/analyze`; origin checks raise the bar but are not the gate. The page treats
  every received payload as untrusted user input, renders a preview (title,
  source URL, kind, size, excerpt), and analyzes only after the user explicitly
  confirms. It never silently injects clip content anywhere.
- **The extension holds no secrets.** It never authenticates — the
  askfutures.com session in the browser is the only auth. There are no tokens,
  keys, or accounts in the extension or this repository.
- **Minimal reach.** `activeTab` means the extension can read a page only
  after the user's click on that page; there are no broad host permissions and
  no background browsing access. The grant persists for the clicked tab until
  it navigates elsewhere — that is what lets the side panel refresh a chart
  snapshot on request — but it never extends to other tabs or sites. Chart
  context is read only on charting sites the user opened the panel on, and is
  sent only to askfutures.com. The one host permission
  (`https://*.askfutures.com/*`) exists to inject the handoff content script
  above and to let the askfutures.com session work inside the extension's side
  panel (auth cookies live on `clerk.askfutures.com`, so the pattern covers
  subdomains).
- **No remote code.** All code, including the bundled defuddle library, ships
  in the package. The extension fetches no code at runtime and sends no
  telemetry.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or email
security@askfutures.com. Please do not file public issues for vulnerabilities.
