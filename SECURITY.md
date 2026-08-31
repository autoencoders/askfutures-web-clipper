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
  "kind": "youtube" | "article" | "pdf",
  "content_markdown": "…",            // extracted content; transcripts and PDF text layers as text
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
  against, only on sites with a scraper (`gocharting.com`, `tradingview.com`
  and `tradovate.com` today), and only under the `activeTab` grant the opening
  click produced. The service worker refuses requests for any other tab or
  site, and only extension pages (never content scripts) may request a scrape.
- **Read-only, always.** No scraper writes to the page, dispatches an event or
  synthesises input. This is worth stating for `tradovate.com` in particular,
  which is a live brokerage: the scraper reads the chart panel's header and
  its value box and nothing else. It never touches the order ticket, the
  positions panel or the account switcher, and the account number, balances,
  orders and positions on that screen are never read and never leave the tab.
  What the snapshot carries is what the chart is showing — symbol, interval,
  the hovered bar's OHLC, and the studies' rendered values.
- **Validation.** The page treats the payload as untrusted input, like a clip.

### Chart-context payload (v1)

```jsonc
{
  "v": 1,
  "source": "gocharting",              // or "tradingview", "tradovate"
  "source_url": "https://gocharting.com/terminal?ticker=CME:ES1%21",
  "ticker": "CME:ES1!",                // nullable; from the tab URL, legend fallback
  "contract": null,                    // nullable; the dated contract, when the site charts one
  "timeframe": "30m",                  // nullable; from the chart legend
  "last_close": 7586.25,               // nullable; C of the current bar, tab-title fallback
  "ohlc": {                            // nullable; the legend's current bar
    "open": 7586.75, "high": 7590.0, "low": 7584.75, "close": 7586.25
  },
  "indicators": [                      // possibly empty; the study legend rows
    { "name": "EMA", "params": "20", "values": [7581.25] },
    { "name": "MACD", "params": "12, 26, 9", "values": [-3.2, 1.1, -4.3] }
  ],
  "bar_time": null,                    // nullable; which bar the values are from
  "theme": null,                       // nullable; the site's own design tokens
  "scraped_at": "2026-07-13T14:05:00Z" // ISO-8601 UTC, extension clock
}
```

`theme`, where a scraper reports it, carries the charting site's own design
tokens so the panel can match rather than clash — colours, its UI font stack,
and metrics for a tab strip and a data grid, each a CSS value taken verbatim
from the page:

```jsonc
"theme": {
  "scheme": "dark",                    // from the page background's luminance
  "fontFamily": "Roboto, sans-serif",
  "color": {
    "background": "rgb(0, 0, 0)", "surface": "#202228", "surfaceRaised": "#323840",
    "border": "#323840", "divider": "#363940",
    "text": "#fff", "textMuted": "rgb(126, 131, 140)", "textDim": "rgb(76, 81, 89)",
    "accent": "#056dff", "up": "#35a24a", "down": "#e52545",
    "rowStripe": "#323840", "rowHover": "#ffffff14"
  },
  "tab":  { "height": "30px", "paddingInline": "5px", "borderRadius": "2px 2px 0px 0px",
            "activeBackground": "rgb(32, 34, 40)", "activeText": "rgb(255, 255, 255)",
            "idleText": "rgb(76, 81, 89)" },
  "grid": { "rowHeight": "20px", "cellPaddingInline": "10px", "headerFontSize": "10px",
            "headerFontWeight": "500", "headerTextTransform": "uppercase",
            "headerText": "rgb(126, 131, 140)" }
}
```

It is read, never guessed — the site may be on a light theme — and it is read
from the same custom properties and elements the site renders from, so a
retheme on their side carries over without an extension release. Two notes for
a consumer: these are strings from someone else's stylesheet, so treat them as
untrusted input like the rest of the payload (interpolate them into CSS custom
properties, never into markup), and every field is nullable — style what is
present and keep your own value for what is not.

Every scraped field is nullable and the snapshot degrades per field: the DOM
scrape has no stable contract from any of these sites, so a redesign silently
empties fields rather than erroring.

`ticker` is always a continuous symbol. Tradovate charts *dated* contracts
("ESU6" is the September 2026 E-mini), which askfutures.com does not accept, so
the service worker converts a bare dated symbol to its front-month continuous
form ("ES1!") and puts the dated one in `contract`. A symbol that is not a bare
dated contract — an exchange-qualified "CME:ES1!", an equity, another site's
dialect — is passed through untouched and leaves `contract` null. A handful of
roots are also translated to the CME root askfutures.com speaks, where the
listing exchange names the same market differently (Coinbase's nano bitcoin
"BIT" → "BTC", Eurex's "FESX" → "STOX"); roots outside that table are not
remapped, so a genuinely unsupported market still reads as one. The
conversion is to the *front* month by definition of "1!", so a chart of a back
month still yields `ES1!`; `contract` is what distinguishes them.

`contract` and `bar_time` are both additive to v1 — a reader that ignores them
sees exactly the snapshot it saw before, so `v` stays `1` and is reserved for
changes that break existing readers. `bar_time` names the bar the values describe, as the site renders it
("08/28/2026 15:00", exchange-local, no timezone), and is null where the site
does not say. It matters most on Tradovate, whose value box shows the bar the
user last hovered rather than the latest one, so the values there can be older
than `scraped_at` by any amount. Treat a null `bar_time` alongside a null
`ohlc` as "this chart's values were not readable", not as an error.

## The research-tour messages

The guided research tour runs `https://askfutures.com/research-tour`, opened in
a tab alongside an open side panel (the panel is no longer a view onto it, but
the worker still refuses a capture unless a panel document exists — see below).
That page owns every API call and all tour state — the extension never holds
tokens. The extension's tour content script (injected only on
`/research-tour`) shares the page's window and speaks the same kind of
handshake as the clip contract, extended with candidate tags:

```
page       → { type: "askfutures-tour-ready" }
page       → { type: "askfutures-tour-capture", pipeline_id, candidate_id, url }
extension  → { type: "askfutures-tour-clip", nonce: "<uuid>",
               tags: { pipeline_id, candidate_id }, payload: { … } }
page       → { type: "askfutures-tour-clip-ack", nonce: "<echoed>" }
extension  → { type: "askfutures-tour-capture-error",
               tags: { pipeline_id, candidate_id }, reason: "…" }   // additive
```

Rules:

- **Origin-checked both ways**, exactly as for clips: each side ignores any
  message whose `event.origin` is not `https://askfutures.com` or whose
  `event.source` is not the page's own `window`.
- **A capture is fulfilled by a user click, not by the message.** On
  `askfutures-tour-capture` the extension navigates the tab the panel sits
  next to (`chrome.tabs.update` — no new permissions) to the candidate URL and
  flags its toolbar action. Extraction runs only when the user then clicks the
  toolbar button on that tab: the click is the approval, and its `activeTab`
  grant is the only page access the capture ever gets. There are still no
  broad host permissions; a candidate the user never approves is never read.
- **Pending captures are narrow and expire.** A capture claims the toolbar
  click only on the specific tab it navigated, only while the side panel is
  still open, only for 15 minutes, and only while that tab still plausibly
  shows the candidate — on the candidate's origin, or within the candidate's
  own initial load (redirects included). Navigating the tab somewhere else
  entirely voids the pending capture, so an abandoned tour can't repurpose a
  later ordinary clip click and an ordinary clip on a wandered-off tab stays
  an ordinary clip.
- **Payload = the clip payload.** `payload` is the same v1 clip payload as the
  `/analyze` contract, same validation, same 2 MB cap. `tags` carry two opaque
  ids minted by askfutures.com and echoed back verbatim; nothing else crosses
  the boundary (this repo is public).
- **Nonce + buffer-clear-on-ack**, as for clips: the tagged clip is buffered in
  `chrome.storage.session`, delivered with a fresh nonce (re-posted until the
  ack, since the tour page announces readiness only once), and the buffer is
  cleared only on an ack whose nonce the extension actually sent.
- **Failures are delivered, never silent.** A candidate that can't be captured
  (no caption track, unreadable page, over the cap) produces a one-shot
  `askfutures-tour-capture-error` with the reason, and the same reason is shown
  to the user in the extension UI. The error message type is **additive**: it
  is documented here first, and a page that predates it simply ignores the
  type and falls back to its own capture timeout. It carries no nonce and needs
  no ack.

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
  sent only to askfutures.com. Clipping a PDF fetches that tab's own URL once
  (Chrome's PDF viewer accepts no injection, so the service worker re-fetches
  the bytes — under the same click-scoped `activeTab` grant — and a short-lived
  offscreen document parses them) — still only the page the user asked to clip.
  Because the PDF viewer can't host the preview card, a PDF clip skips it: the
  click is the confirmation and `/analyze` opens directly, where the page's own
  preview-and-confirm step still applies before anything is analyzed. The one
  host permission
  (`https://*.askfutures.com/*`) exists to inject the handoff and research-tour
  content scripts above and to let the askfutures.com session work inside the
  extension's side panel (auth cookies live on `clerk.askfutures.com`, so the pattern covers
  subdomains).
- **No remote code.** All code, including the bundled defuddle and pdf.js
  libraries, ships in the package. The extension fetches no code at runtime
  and sends no telemetry.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or email
security@askfutures.com. Please do not file public issues for vulnerabilities.
