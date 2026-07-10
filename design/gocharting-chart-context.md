# GoCharting chart context in the side panel

Status: design / feasibility — not implemented.

On charting sites (`SIDE_PANEL_DOMAINS` in `src/background.ts`) the toolbar
click opens the AskFutures side panel instead of clipping. Today the panel
knows nothing about the chart next to it. This document assesses how much
chart context we can scrape from gocharting.com — symbol, timeframe,
indicators — and how the panel can be notified live when they change.

## What we can scrape, by reliability

### Symbol — essentially free, no scraping needed

The ticker is in the tab URL: `gocharting.com/terminal?ticker=CME:ES1%21`
→ `CME:ES1!`. We already have `tab.url` at the moment of the toolbar click
(that is how `isSidePanelUrl` works), so the symbol can be parsed without
touching the page.

The tab title is a bonus source — `7515.5 (-0.48%) @ CME:ES1!` carries last
price and % change — and `activeTab` grants title access on the click.

### Timeframe — easy, one DOM read

Not in the URL, but present in two places in the DOM: the interval selector
in the toolbar ("30m") and, more usefully, the chart legend text:

    CME:ES1! (30m) O: 7,586.75 H: 7,590.00 L: 7,584.75 C: 7,586.25 V: 7.92K OI: 0

The legend is plain text in the DOM, so a regex like `\(([0-9]+[mhDWM])\)`
against it is fairly robust even if GoCharting's (minified) class names
churn. As a side effect the legend also yields the last bar's OHLCV and open
interest, and the bottom bar exposes the ETH/RTH session toggle state.

### Indicators — doable, most brittle

Added studies render as additional legend rows under the main one (e.g.
"EMA (20)", "VWAP"). Indicator names and display parameters can be scraped
from those rows. Caveat: there is no stable public DOM contract, so this is
selector-guesswork that can break when GoCharting ships a redesign.

A potentially richer source is GoCharting's own persisted layout in
`localStorage` — SPAs like this usually store the full chart config (symbol,
interval, every study with its parameters) as JSON. If that pans out (needs
a devtools check on a real session), it is more structured and more stable
than DOM scraping. Verify before committing to the DOM approach.

### Out of scope — not realistically available

- **The candle series itself.** The chart is canvas-rendered; historical
  OHLC bars are not in the DOM. Getting them would mean tapping
  GoCharting's private data feed — fragile and ToS-questionable.
- **Drawings/annotations.** Canvas-only (though they may also live in the
  localStorage layout).

## Live change notifications

Yes — the panel can be notified when the user changes symbol, timeframe, or
indicators. All three are DOM reads, and the pattern slots into the existing
architecture.

### Detection (in the gocharting tab)

One injected observer script sets up a `MutationObserver` on the
legend/toolbar region. All three signals funnel through it:

- **Symbol** — legend text changes; the URL query (`?ticker=...`) and tab
  title change too, so there are redundant signals.
- **Timeframe** — the `(30m)` in the legend re-renders on interval change.
- **Indicators** — study legend rows get added/removed.

The legend mutates *constantly* — the O/H/L/C/V values tick with live
prices — so the observer must not fire on any mutation. It re-extracts only
the fields we care about (symbol, interval, indicator list), compares
against the last snapshot, debounces (~200 ms), and emits only when the
tuple actually changed. That keeps it cheap despite the churn. If selectors
break, the extractor fails soft: the panel just stops getting updates rather
than erroring.

### Delivery (to the panel)

The observer calls `chrome.runtime.sendMessage` with the new state. The
side panel is an extension page, so a small `sidepanel.js` (the panel
currently has no script) listens with `chrome.runtime.onMessage` directly —
no service-worker relay needed, and content-script messages wake extension
contexts fine under MV3. The panel forwards into the askfutures.com iframe
via `postMessage`, mirroring the existing handoff handshake. Messages carry
`sender.tab.id` so a panel only reacts to its own tab's chart.

**askfutures.com needs a counterpart.** The page in the iframe has to listen
for the new message type and update the session context — a change in the
web app, not this extension.

### Injection lifetime — the one real caveat

With only `activeTab` (what we ship today), the observer injected at
panel-open keeps working across everything GoCharting does in-SPA — symbol
switches via `history.pushState` do not revoke the grant. But a **page
reload destroys the injected script**. The grant itself survives
same-origin reloads, so the background can re-inject on `tabs.onUpdated`
for the tabId it is tracking — workable, but the fiddly edge of the design.

The durable version is a `https://*.gocharting.com/*` host permission —
ideally as an `optional_host_permissions` entry requested on first use, so
the install prompt stays clean — with a declared content script. Then
observation survives reloads and new gocharting tabs with zero ceremony.

## Permissions and security posture

- **One-shot scrape at panel open: no new permissions.** `activeTab` +
  `scripting` (already in the manifest) allow `executeScript` into
  gocharting.com on the toolbar click — the same pattern `extractClip`
  uses. `sidePanel.open()` must stay synchronous with the gesture, but the
  scrape can fire right after it in the same handler.
- **Durable live sync: optional host permission** for gocharting.com, as
  above.
- **This repo is public and SECURITY.md promises the extension only talks
  to askfutures.com pages.** That promise must be updated either way, e.g.:
  "reads chart context (symbol, timeframe, indicators) on charting sites
  you open the panel on, and sends it only to askfutures.com." Expect a
  somewhat heavier Chrome Web Store review with the added host.

## Rollout recommendation

1. **First cut:** parse the symbol from the URL + one-shot `executeScript`
   at panel open for timeframe/indicators; seed the panel's "Type your
   trading idea" context with it. No new permissions.
2. **Live updates:** add the observer with activeTab injection +
   re-inject-on-reload. Ships without manifest changes.
3. **If reload gaps annoy users:** move to the optional
   `gocharting.com` host permission + declared content script.

The same approach generalizes to the other `SIDE_PANEL_DOMAINS`
(TradingView also puts the ticker in the URL and the interval in its
legend), but each site needs its own selectors.
