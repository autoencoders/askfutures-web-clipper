# Tradovate chart context → AskFutures side panel

Status: **implemented** in `src/tradovate.ts`, verified against a live session
(demo account, 2026-08-30, markets closed) by running the built `dist/`
artifact in the page. This document records what the probe found and why the
scraper is shaped the way it is; it differs from `src/gocharting.ts` and
`src/tradingview.ts` in ways that are not obvious from the code alone.

One conclusion in an earlier draft of this document was **wrong** and is
corrected below: synthetic pointer input looked like it could drive the value
box, and it cannot. The correction is kept rather than deleted, because the
failed approach is the one a reader is most likely to try again.

## Why Tradovate does not fit the existing `ChartSite` shape

The `ChartSite` interface assumes two cheap, DOM-independent sources that act
as the resilient fallback when the scrape breaks. **Tradovate has neither.**

| | gocharting / tradingview | tradovate |
| --- | --- | --- |
| `tickerFromUrl` | `?ticker=CME:ES1!` / `?symbol=CME_MINI:ES1!` | `https://trader.tradovate.com/` — no path, no query. The whole app is one URL. |
| `lastPriceFromTitle` | `7515.5 (-0.48%) @ CME:ES1!` | `Tradovate - Dark Default` — the *workspace layout* name. No symbol, no price. |

So on Tradovate **100% of the context comes from the page**, and both
`tickerFromUrl` and `lastPriceFromTitle` must be `() => null`. The per-field
degradation the other two rely on does not exist here: if the scrape fails, the
snapshot is empty rather than partial.

Second structural difference: Tradovate is a **multi-chart workspace**, not one
chart. The probed layout had four chart panels (`ESU6 5m`, `6EU6 15m`,
`BITU6 5m`, `MSFT D`) plus a DOM ladder, a quote board and an order panel. The
scraper needs a rule for *which* chart it means.

**That rule is free:** golden-layout only mounts the active tab. There is
exactly one `.module.chart.chart-wrapper` and one `.databox` in the DOM at a
time, and they belong to the active chart panel. No disambiguation needed —
just do not assume more than one.

## What the page exposes

### 1. `.databox` — the live values (OHLC, volume, every indicator output)

A draggable panel with semantic, unminified class names:

```
.databox
  .header                 "08/28/2026 15:00×"   ← the bar's timestamp
  ul.entries
    li > .label "open❚"   .desc "7722.75"
    li > .label "high❚"   .desc "7724.00"
    li > .label "low❚"    .desc "7720.75"
    li > .label "close❚"  .desc "7722.25"
    li > .label "volume❚" .desc "17027"
    li > .label "upper❚"  .desc "7727.14"   ← bband
    li > .label "lower❚"  .desc "7715.28"   ← bband
    li > .label "sma❚"    .desc "7722.04"
    li > .label "rsi❚"    .desc "49.4"
    li > .label "middle❚" .desc "50.0"      ← rsi guide lines
    li > .label "overbought❚" .desc "70.0"
    li > .label "oversold❚"   .desc "30.0"
```

The `❚` is a colour swatch glyph; strip non-ASCII as `gocharting.ts` already
does. This is *far* better structured than GoCharting's legend text — a
label/value pair per row, no regex needed to split fields.

**The entry keys are the indicator `plots` keys**, which makes them joinable
against the config in §2: `bband` declares plots `{upper, lower}`, `rsi`
declares `{rsi, middle, overbought, oversold}`, and `sma` declares the default
plot `{_}` which renders under the indicator's own name. So each value can be
attributed to its indicator instead of being a flat list — a real improvement
over the other two scrapers, which guess from row text.

#### The blocker: the databox is crosshair-driven, and empty until hovered

This is the finding that shapes the whole design. Probed:

- On a freshly activated chart panel the databox reads `--/--/----` with
  **zero entries**, and stays that way indefinitely (checked over 6s, and
  again after switching back to the original tab).
- A **real** mouse hover over the plot populates it with the bar under the
  cursor.
- The values are the *hovered* bar's, not the latest bar's.

A cold scrape therefore returns nothing. And the toolbar click — which is what
triggers the scrape — happens with the pointer at the top of the browser
chrome, never over the chart. **On Tradovate the natural moment to scrape is
exactly the moment the databox is guaranteed to be empty.**

#### The non-workaround: synthetic input cannot drive it

Worth reading before trying this, because it half-works in a way that is easy
to mistake for working.

Dispatched `mousemove` is ignored outright. Dispatched `PointerEvent`
`pointermove` **does** move the crosshair and retarget the box — sweeping
`clientX` toward the right edge of `.chart-inner-wrapper` walks it forward in
time and saturates on the last bar (`08/28/2026 15:55`, close `7724.75`, from
~92% of the width rightward). That looked like a clean workaround.

It is not, because it only works **while the real pointer is inside the
chart**. Probed three ways:

| Real pointer | Box state | Synthetic `pointermove` |
| --- | --- | --- |
| resting on the plot | populated | retargets freely ✅ |
| moved off the chart | populated (sticky) | no effect ❌ |
| never on the chart | cold (`--/--/----`) | no effect ❌ |

`pointerover` + `pointerenter` first makes no difference, nor does a second
move with a delta. The dispatched event is not activating the crosshair; it is
only steering one the real pointer is already holding.

**A toolbar click always happens with the pointer up in the browser chrome.**
So the one moment a scrape runs is precisely the moment synthetic input cannot
reach the chart. The scraper therefore only reads, and `primeDataBox()` was
removed. That is the better outcome anyway: no input synthesis on a brokerage
page, and one less thing to defend in review.

#### What saves it: the box is sticky

Once a real hover has populated the box it **keeps that bar after the pointer
leaves the chart entirely** — verified by hovering the plot, then moving the
real mouse down to the market-watch panel and re-reading. It is cleared by
re-mounting the panel (a chart tab switch) or a reload, not by the mouse
leaving.

So in practice a user who has been reading their chart has a populated box when
they click the toolbar. The cold case is real but narrow: they switched chart
tabs, or reloaded, and clicked without hovering. Then the snapshot degrades to
symbol and interval with `ohlc: null`, `indicators: []`, `bar_time: null`.

The values are the bar the user last hovered, which may be far from the latest
— they could have walked back through the chart hours ago. This is why
`bar_time` exists; on Tradovate it is load-bearing rather than informational.

**A user who has closed the value box gets no values at all.** It is a
toggleable widget (`config.databox.enabled`). The probed account had it on in
both the workspace and in `defaultModules` (that user's saved chart default),
but that is one account and proves nothing about a fresh install.

### 2. The config — symbol, interval, indicator names and parameters

Two sources, and the difference between them matters.

**`localStorage['workspaces:<accountId>']`** — the full golden-layout tree,
including per-chart `componentState` with `inputStreamData[0].symbol`,
`chartDescription`, and the `indicators[]` array. Readable from the isolated
world (content scripts share the page origin's storage). **But it was stale by
507 minutes** when probed, and it is keyed by account id (the probed profile
had two: `workspaces:5759788` and `workspaces:8943554`), so picking the right
one needs the active account. Fine as a last-resort fallback; not trustworthy
as the primary source — a symbol change made minutes ago may not be in it.

**The React `ChartModule` `config` prop** — the same shape, but live. Reached
from `.module.chart.chart-wrapper` by walking `__reactFiber$…` up to the fiber
whose `type.name === 'ChartModule'`, then `memoizedProps.config`:

```jsonc
{
  "inputStreamData": [{
    "symbol": "ESU6",
    "chartType": "Candlestick",
    "chartDescription": { "elementSize": 5, "elementSizeUnit": "UnderlyingUnits",
                          "underlyingType": "MinuteBar" }
  }],
  "indicators": [
    { "name": "bband", "params": { "period": 20 }, "plots": { "upper": …, "lower": … } },
    { "name": "sma",   "params": { "period": 14 }, "plots": { "_": … } },
    { "name": "rsi",   "params": { "period": 14 }, "plots": { "rsi": …, "middle": …,
                                                              "overbought": …, "oversold": … } }
  ],
  "databox": { "enabled": true, … }
}
```

Verified live: switching to the `6EU6 15m` tab flipped the prop to
`symbol: "6EU6"`, `elementSize: 15`, `indicators: [cmf(period 14), psar(step
0.02, maxStep 0.2)]` — while localStorage still described the old chart.

`chartDescription` is a structured interval — `{5, UnderlyingUnits, MinuteBar}`
→ `"5m"` — rather than a display string to regex.

**This requires MAIN-world injection.** `__reactFiber$…` is a page-JS expando
and is invisible to an isolated-world content script. There is precedent
(`src/extractor.ts` runs in MAIN), but doing it on a broker page is the main
security decision this feature carries — see §4.

### 3. DOM-only fallbacks (no MAIN world needed)

If MAIN world is ruled out, symbol and timeframe are still readable:

- **Active chart tab label** — `li.lm_tab.lm_active` inside the chart stack
  reads `"ESU6 5m"`, `"6EU6 15m"`, `"MSFT D"`. Format is `SYMBOL INTERVAL`.
  `lm_tab` / `lm_active` are golden-layout's own class names (a third-party
  lib, not minified app CSS), so they are a reasonably stable contract.
  Caveat: `li.lm_tab` also matches the DOM ladder, quote board and order
  panel stacks — scope to the chart stack, or intersect with §3's symbol.
- **`.chart-wrapper .header .info-column.info-column-symbol`** reads
  `"ESU6" + "E-Mini S&P 500"` — symbol *and* contract description. The
  description is a field the other two sites do not offer; `ChartContext`
  has nowhere to put it today.
- **`.info-column.last-price-info`** is where LAST/BID/ASK live. It was empty
  during the probe (Sunday, market closed), so its populated shape is
  **unverified** — this needs a second probe during trading hours before
  anything depends on it. It is the only candidate for `last_close` that does
  not come from the databox.

Not available in the DOM: the on-chart pane labels (the `RSI` tag on the lower
pane) are canvas-drawn. `plotLabels` came back empty. Indicator display names
exist only as the internal ids (`bband`, `sma`, `rsi`, `cmf`, `psar`), so
either the panel maps them to human names or askfutures.com does.

## Decisions taken

**MAIN world: no.** The scraper is isolated-world only. MAIN would buy live
indicator parameters and structured `chartDescription` off the React fiber, but
it means running in a brokerage page's own JS context and keying on
`type.name === 'ChartModule'` — a component name that survives a build which
mangles its siblings to `Re`, `f` and `x`, i.e. one build-config change from
breaking silently. The DOM carries everything except indicator parameters, and
those are recovered from the persisted workspace instead (below).

**Synthetic input: no.** Not on principle — it does not work at the only moment
it would be needed. See above.

**`bar_time`: yes, additive to v1.** `v` is left at `1` and reserved for
changes that break existing readers; a reader that ignores `bar_time` sees the
snapshot it always saw. Bumping to `2` would risk a consumer rejecting the
whole payload for a field it does not need. Documented in SECURITY.md.

## How the pieces fit

- **Symbol** — `.chart-wrapper .info-column-symbol .contract-symbol` → `ESU6`.
  The cell also holds the contract description (`E-Mini S&P 500`) as a sibling,
  which `ChartContext` currently has nowhere to put.
- **Interval** — the active chart tab's label (`ESU6 5m`) minus the symbol.
  Scoped to the chart's own `.lm_stack`, because the DOM ladder, quote board
  and order panel all render `li.lm_tab.lm_active` too. `lm_tab` / `lm_active`
  are golden-layout's class names, not Tradovate's, so they are a third-party
  contract rather than app CSS that churns.
- **OHLC + volume + study values** — `.databox .entries li`, as `.label` /
  `.desc` pairs. No text parsing.
- **Indicator grouping and parameters** — from
  `localStorage["workspaces:<accountId>"]`, but only when corroborated. The
  store is written lazily (observed **507 minutes stale**), so it can describe
  a chart the user has since changed; it is trusted only for a chart whose
  symbol *and* interval match what the DOM just reported, and the active
  account's key is searched first because a profile's accounts routinely hold
  charts of the same symbol and interval (the probed profile had an `ESU6 5m`
  under both). Rows the config does not explain are still reported
  individually, so a stale or missing config costs the grouping and nothing
  else.
- **Value ordering** — by the box's render order, not the config's plot-key
  order. Taking the config verbatim buried the reading among its own reference
  lines: RSI came out `[30, 70, 50, 48.9]`, oversold first and the actual RSI
  last. By box order it is `[48.9, 50, 70, 30]`.

Verified end to end against the built artifact: `ESU6 5m` →
`BBANDS("20", [7726.74, 7715.41])`, `SMA("14", [7721.88])`,
`RSI("14", [38.3, 50, 70, 30])`, OHLC of the hovered bar, `bar_time
"08/28/2026 13:45"`. `MSFT D` → ticker `MSFT`, timeframe `D`, `bar_time
"06/13/2026"` (date only on a daily chart). Cold box → `ESU6` / `5m` with null
values, as designed.

## Dated contracts vs continuous symbols

Tradovate's chart header names a dated contract — `ESU6`, the September 2026
E-mini — where gocharting and tradingview both hand over a continuous symbol
(`CME:ES1!`). askfutures.com accepts only the continuous form, so a Tradovate
snapshot posted verbatim comes back as "that symbol is not supported yet",
which puts the burden on the user to retype a symbol off the chart they are
already looking at.

The service worker therefore converts: `ChartContext.ticker` carries the
front-month continuous form (`ES1!`) and the new `ChartContext.contract` keeps
the dated symbol (`ESU6`). `continuousTicker` in `src/shared.ts` splits on the
trailing month code + year, which is what makes roots that end in a month code
unambiguous (`MNQU6` → `MNQ1!`, never `MN|Q|U6`) and what keeps equities out
(`MSFT` has no year digits, so it does not match and passes through).

The conversion happens in the service worker, **not** in this scraper, and that
placement is load-bearing: `indicatorConfig` matches the scraped symbol string
against the persisted workspace to recover indicator parameters, so the scrape
has to keep saying `ESU6`.

Roots differ across listing exchanges, too. Tradovate names the contract its
exchange lists, so the Coinbase nano bitcoin on the chart is `BITU6` while
askfutures.com knows bitcoin as the CME root `BTC` — the snapshot would be
rejected for a market the app covers fully. `PRODUCT_ALIASES` translates the
few roots where that happens (`BIT` → `BTC`, `FESX` → `STOX`, `FDAX` → `DAX`),
mapping by *market* rather than contract size: nano bitcoin is 0.01 BTC against
CME's 5, so the alias targets the full-size root that names the market and
leaves the size to askfutures.com. Anything not in the table passes through, so
an unsupported market still reports as unsupported instead of being silently
swapped for a neighbour.

Front month is what `1!` means, so charting a back month (`ESZ6` while `ESU6`
is front) still yields `ES1!` — the imprecision is inherent in the continuous
form askfutures.com asks for, and `contract` is what preserves the difference.

## Known limitations

- **Study names come from Tradovate's internal ids** — `bband`, `sma`, `psar`,
  `cmf` — because the display name is drawn on the canvas and is not in the DOM
  to read. `studyName` canonicalises them to the TA-Lib vocabulary
  askfutures.com speaks: uppercase by default (`sma` → `SMA`, `rsi` → `RSI`),
  plus a table for the ids Tradovate spells differently (`bband` → `BBANDS`,
  `psar` → `SAR`). A study neither uppercase-equal to a TA-Lib name nor in that
  table — `cmf`, which TA-Lib has no function for — still arrives unrecognised,
  which is the honest outcome rather than a guessed mapping.
- **`.info-column.last-price-info` is unverified.** It is the only non-box
  candidate for a live last price, and it was empty during the probe (Sunday,
  market closed), so nothing depends on it yet. `last_close` currently comes
  from the hovered bar's close. Worth a second probe during trading hours.
- **Hour charts may not match for grouping.** A 60-minute chart is stored as
  `{elementSize: 60, underlyingType: "MinuteBar"}` → `"60m"`, and if the tab
  label renders that as `1h` the corroboration fails and the grouping is lost
  (symbol and interval still come from the DOM). Not observed either way — the
  profile's only 60m chart was in the other account's workspace.
- **The residual account risk.** If the account selector's markup moves,
  `workspaceKeys()` falls back to scanning every account's workspace, and a
  study that two accounts' same-symbol charts share could be reported with the
  wrong period. Names cannot drift — a study is only reported when the box
  actually renders a row under its plot's name.

## Matching the site's look

The panel sits beside a dense, dark trading terminal, and a panel styled
nothing like it reads as a foreign object bolted onto the screen. The snapshot
therefore carries a `theme` alongside the chart data: Tradovate's own tokens,
read live from the page (`readTheme()` in `src/tradovate.ts`, contract in
SECURITY.md).

**Read, never hardcoded.** Tradovate ships light and dark themes, so a baked-in
dark palette would be wrong for every user on light. Reading also means a
retheme on their side carries over without an extension release.

**The one trap: resolve tokens off `document.body`, not `:root`.** The values
declared on `:root` are the *light* defaults — `--gray1: #f4f4f4`,
`--bgColor: var(--white)` — and the dark theme overrides them further down the
cascade. Reading the declared `:root` values yields a light palette on a black
screen. `getComputedStyle(document.body).getPropertyValue(name)` resolves the
theme actually in force. What that gives on the dark theme:

| Token | Value | Where it comes from |
| --- | --- | --- |
| background | `rgb(0, 0, 0)` | the page behind the panels |
| surface | `#202228` | `--bgColor`, a panel's own ground |
| surfaceRaised | `#323840` | `--boxBackground` |
| divider | `#363940` | `--dividerColor` |
| text / muted / dim | `#fff` / `#7e838c` / `#4c5159` | body, grid heading, inactive tab |
| accent | `#056dff` | `--primaryColor` |
| up / down | `#35a24a` / `#e52545` | `--importance-icon-fill-{green,red}` |

**Price direction is not status colour.** Tradovate's `--successColor`
(`#00bb83`) and `--dangerColor` (`#f83838`) are for status; its grids and
charts render rising and falling prices in `#35a24a` / `#e52545`. Using the
status pair would be subtly but visibly wrong on every quote row.

Tab and grid metrics come from computed styles rather than variables, because
they are not exposed as tokens: a tab is 30px tall, `2px 2px 0 0`, 5px inline
padding, `#202228` when active and `#4c5159` when not; a grid row is 20px, its
column headings 10px/500 uppercase in `#7e838c` with 10px inline padding. The
UI font is Roboto — note that `document.body`'s own stack is Helvetica Neue and
nothing visible uses it, so the font is read from a tab instead.

### What the extension can and cannot restyle

This is the boundary that shapes the feature, and it is not obvious:

- **The panel's chrome** — the nav bar in `sidepanel.html` — is the extension's
  own document, so it restyles itself. `applyTheme()` in `src/sidepanel.ts`
  overwrites the `--af-*` custom properties the stylesheet reads from. Every
  rule in that stylesheet goes through a variable; a literal colour there is a
  colour that can never match the site next door.
- **Everything below the nav is a cross-origin iframe on askfutures.com.** No
  extension API can style it: `insertCSS` needs a tab, and the side panel is
  not one; same-origin DOM access is out by definition. **The look in the
  mockups — the session header, the Parameters/Backtest/Trades tabs, the
  trades grid — all lives inside that iframe, and only askfutures.com can
  style it.**

So the extension's half is to *deliver* the tokens; askfutures.com's half is to
consume them. The page already receives the whole snapshot on
`askfutures-chart-context`; `payload.theme` is the new field, and the natural
shape on that side is to map it onto its own custom properties and let its
existing components follow, with the panel's current styling as the fallback
whenever `theme` is null (every other site, and Tradovate if the tokens move).

Until that lands, the visible change is limited to the panel's nav bar.
