# GoCharting chart context → AskFutures side panel

How the extension pulls chart data from **gocharting.com** and passes it into
the **askfutures.com** page embedded in the side panel.

On charting sites the toolbar click opens the AskFutures side panel next to the
chart (see `SIDE_PANEL_DOMAINS` in `src/background.ts`). On gocharting.com the
panel additionally scrapes a **snapshot** of the chart and hands it to
askfutures.com. Snapshots only — there is no live streaming; each snapshot is
one explicit scrape.

## Data flow

```
 gocharting.com tab            service worker              side panel page            askfutures.com iframe
 (src/gocharting.ts)           (src/background.ts)         (src/sidepanel.ts)         (web app — separate repo)
        │                             │                          │                            │
        │                             │   panel opens / toolbar   │                            │
        │                             │   click re-scrapes        │                            │
        │   ◄── executeScript ────────┤ ◄── getChartContext ──────┤                            │
        │   __askfuturesChartScrape() │                          │                            │
        │   ──── ChartScrape ────────►│                          │                            │
        │                             │  merge URL + title,      │                            │
        │                             │  stamp envelope          │                            │
        │                             ├──── { ok, context } ────►│                            │
        │                             │                          ├─ postMessage ─────────────►│
        │                             │                          │  askfutures-chart-context  │
        │                             │                          │ ◄─ postMessage ────────────┤
        │                             │                          │  ...-request (refresh)      │
```

1. **Trigger.** The toolbar click opens the panel (`chrome.sidePanel.open`,
   synchronous with the user gesture). The panel's script captures its tab id
   and asks the service worker for a snapshot. Clicking the toolbar icon again
   while the panel is open re-scrapes (the icon doubles as a refresh); the
   embedded page can also request a fresh snapshot at any time.

2. **Scrape.** The service worker injects `gocharting.js` into the chart tab
   under the existing `activeTab` grant (same two-step `chrome.scripting.executeScript`
   pattern as the clip extractor) and calls `window.__askfuturesChartScrape()`.

3. **Merge + stamp.** The worker combines the DOM scrape with data it derives
   itself — the ticker from the tab URL and the last price from the tab title —
   and stamps the envelope fields (`v`, `source`, `scraped_at`).

4. **Deliver.** The worker returns the `ChartContext` to the panel, which posts
   it into the askfutures.com iframe via `window.postMessage`, origin-locked to
   `https://askfutures.com`.

## Where each field comes from

| Field | Source | Reliability |
|---|---|---|
| `ticker` | Tab URL `?ticker=` (legend fallback) | Solid — no page scrape needed |
| `timeframe` | Chart legend text, `\((\d+[smhDWM])\)` | Solid — text-anchored |
| `last_close` | Legend `C:` (tab-title price fallback) | Solid at latest bar (see limitation) |
| `ohlc` | Legend `O:/H:/L:/C:` of the current bar | Solid at latest bar |
| `indicators[]` | Study legend rows (name, params, values) | Most brittle — no stable DOM contract |

The scraper is **deliberately selector-free**: GoCharting's class names are
minified and churn, so it anchors on the legend *text* — e.g.
`CME:ES1! (30m) O: 7,586.75 H: 7,590.00 L: 7,584.75 C: 7,586.25 V: 7.92K` — and
study rows like `Exponential Moving Average (close,10) 7,565.16`. It **fails
soft per field**: a broken legend selector empties that field rather than
erroring, and ticker/last price still come through from the URL and title.

## Payload format — `ChartContext` (v1)

Defined in `src/shared.ts`; the contract is documented in `SECURITY.md`.

```jsonc
{
  "v": 1,
  "source": "gocharting",
  "source_url": "https://gocharting.com/terminal?ticker=CME:ES1%21",
  "ticker": "CME:ES1!",                // nullable
  "timeframe": "30m",                  // nullable — "30m", "4h", "1D", …
  "last_close": 7586.25,               // nullable — C of the current bar
  "ohlc": {                            // nullable — the legend's current bar
    "open":  7586.75,
    "high":  7590.00,
    "low":   7584.75,
    "close": 7586.25
  },
  "indicators": [                      // possibly empty
    { "name": "VOLUME", "params": null, "values": [6400] },
    { "name": "Smoothed Moving Average", "params": "Derived from VOLUME_BAR-7", "values": [52246.02] },
    { "name": "Exponential Moving Average", "params": "close,10", "values": [7565.16] }
  ],
  "scraped_at": "2026-07-14T00:34:35Z" // ISO-8601 UTC, extension clock
}
```

**Every scraped field is nullable** and the snapshot degrades per field. Numbers
are parsed to plain JS numbers: commas are stripped and `K`/`M`/`B` suffixes are
expanded (`7.92K` → `7920`, `52,246.02` → `52246.02`). Multi-output studies
(e.g. MACD) carry several entries in `values`. The colored legend swatch and the
icon-button labels (`Add Indicators`, `Hide`, `Settings`, `Delete`, `Remove`)
are stripped from indicator names.

### Indicator shape — `ChartIndicator`

```jsonc
{
  "name":   "Exponential Moving Average", // study name, control-label prefixes stripped
  "params": "close,10",                   // display parameters as shown, or null
  "values": [7565.16]                     // last rendered value(s); [] if none shown
}
```

## Message contract

### Panel ⇆ askfutures.com iframe (`window.postMessage`)

```
panel → iframe   { type: "askfutures-chart-context", payload: { …ChartContext } }
iframe → panel   { type: "askfutures-chart-context-request" }
```

- Origin-locked both ways to `https://askfutures.com`.
- **Fire-and-forget, no ack/nonce** — chart context is re-derivable, so a lost
  message just prompts another `...-request`.
- **askfutures.com must implement the counterpart listener** (a web-app change,
  outside this repo) to consume `askfutures-chart-context` and, optionally, send
  `askfutures-chart-context-request` to refresh.

### Panel ⇆ service worker (`chrome.runtime`)

```
panel → worker   { type: "get-chart-context", tabId }   → { ok: true, context } | { ok: false, error }
worker → panel   { type: "chart-context-ping", tabId }  (toolbar re-click = refresh)
```

Only extension pages (never content scripts) may request a scrape, and only for
a gocharting.com tab under a live `activeTab` grant — the worker refuses anything
else.

## Known limitation — the legend follows the viewport

The legend shows the bar under the crosshair, or the last *visible* bar when the
chart is scrolled back in time — **not necessarily the most recent bar**. So
`last_close`, `ohlc`, and each indicator's `values` are the latest bar's values
only when the chart is parked at the latest bar (the normal case). When the
newest bar is scrolled off-screen its values live only on the canvas and are not
in the DOM to read.

Confirmed on a live session that there is no clean workaround: dispatching
`mouseleave` on the chart does not reset the legend, and GoCharting exposes no
scroll-to-realtime control that leaves the zoom untouched. The robust future
path is GoCharting's in-page data model or its persisted
`GochartingInitialState.RootStore` layout rather than the legend — see
`design/gocharting-chart-context.md`.

## Permissions

No new permissions. The scrape reuses `activeTab` + `scripting` already in the
manifest — the same reach the clip extractor has. Chart context is read only on
gocharting.com tabs the user opened the panel on, and is sent only to
askfutures.com.
