// Injected into the trader.tradovate.com tab's isolated world when the
// AskFutures side panel wants a chart snapshot (at panel open, and on refresh
// requests). Reads the active chart's symbol and interval from its panel
// header, and the last bar's OHLCV plus every indicator's rendered value from
// the "data box" widget, through the shared window.__askfuturesChartScrape
// entry point the service worker calls.
//
// Tradovate differs from the other two chart sites in three ways that shape
// this file (the reasoning is in design/tradovate-chart-context.md):
//
//  1. Nothing is in the URL or the tab title. gocharting and tradingview both
//     put the ticker in the query string and the last price in the title, so
//     their scrapers can fail soft and still yield a useful snapshot. Here the
//     URL is a bare trader.tradovate.com and the title is the *workspace*
//     name, so everything below is the only source there is.
//
//  2. It is a multi-chart workspace — but golden-layout mounts only the active
//     tab, so exactly one .chart-wrapper and one .databox exist at a time and
//     "which chart" needs no disambiguation. This asserts that rather than
//     assuming it.
//
//  3. The data box is crosshair-driven, and there is no way to drive it. It
//     shows the bar the pointer last visited; a chart the user has not hovered
//     since it was mounted renders "--/--/----" with no rows at all. It is
//     sticky, though — once hovered it keeps that bar after the pointer leaves
//     the chart entirely — so in practice a user who has been reading their
//     chart has a populated box by the time they click the toolbar.
//
//     Synthesising the hover is not an option, and the reason is worth writing
//     down so nobody retries it: Tradovate ignores dispatched mousemove, and
//     while a dispatched pointermove *does* move the crosshair, it does so
//     only while the real pointer is inside the chart. Probed directly — with
//     the mouse resting on the plot, synthetic moves retarget the box freely;
//     with the mouse anywhere else, they do nothing, from a cold box or a
//     populated one. The toolbar click always happens with the pointer up in
//     the browser chrome, so the one moment a scrape runs is the one moment
//     synthetic input cannot reach the chart. This file therefore only reads.
//
// Deliberately isolated-world. Tradovate's live chart config also hangs off a
// React fiber on the wrapper (symbol, interval, and indicator parameters, all
// structured), but reaching it means MAIN-world injection into a *broker* page,
// and it keys on a component name that the app's own build already mangles for
// the components around it. The DOM below carries everything except indicator
// parameters, and those are recovered from the persisted workspace instead —
// only when the live DOM corroborates it (see indicatorConfig).

import type { ChartIndicator, ChartScrape, ChartTheme } from './shared';

window.__askfuturesChartScrape = () => {
  try {
    return { ok: true, scrape: scrape() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// The data box's own row labels for the price series, in ChartScrape order.
// Everything else in the box is an indicator plot.
const OHLC_LABELS = ['open', 'high', 'low', 'close'] as const;

const MAX_INDICATORS = 24;

function scrape(): ChartScrape {
  const wrapper = document.querySelector('.module.chart.chart-wrapper');
  if (!wrapper) {
    // No chart panel is active (the user has the workspace on a DOM ladder or
    // a quote board). Not an error — there is simply no chart to describe.
    return {
      ticker: null,
      timeframe: null,
      ohlc: null,
      indicators: [],
      barTime: null,
      theme: readTheme(),
    };
  }
  const ticker = symbolOf(wrapper);
  const timeframe = timeframeOf(wrapper, ticker);
  const rows = readDataBox();
  return {
    ticker,
    timeframe,
    ohlc: ohlcFrom(rows),
    indicators: groupIndicators(rows, ticker, timeframe),
    // Load-bearing, not a nicety: the values above are the last bar the user
    // hovered, which on a chart they walked back through can be hours old.
    // Without this the consumer cannot tell a live bar from a stale one.
    barTime: rows?.barTime ?? null,
    theme: readTheme(),
  };
}

// "ESU6", from the panel header's own symbol cell. The cell also carries the
// contract description ("E-Mini S&P 500") as a sibling, so read the symbol
// element rather than the cell's text.
function symbolOf(wrapper: Element): string | null {
  return clean(wrapper.querySelector('.info-column-symbol .contract-symbol')?.textContent);
}

// "5m", "15m", "D" — the tail of the active chart tab's label, which reads
// "<symbol> <interval>". The tab lives in this chart's own golden-layout
// stack; scoping to it matters because the DOM ladder, quote board and order
// panel all render li.lm_tab.lm_active too.
function timeframeOf(wrapper: Element, ticker: string | null): string | null {
  const label = clean(
    wrapper.closest('.lm_stack')?.querySelector('.lm_header li.lm_tab.lm_active')
      ?.textContent,
  );
  if (!label) return null;
  if (ticker && label.startsWith(ticker)) {
    return clean(label.slice(ticker.length)) || null;
  }
  // Symbol unreadable, or the label is shaped differently than expected —
  // take the last token, which is the interval in every form observed.
  const parts = label.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

interface DataBoxRows {
  barTime: string | null;
  values: Map<string, number>;
  order: string[];
}

// The data box: a header carrying the bar's timestamp, then one row per value
// as a .label / .desc pair. Class names here are semantic and unminified, so
// unlike the GoCharting legend this needs no text parsing.
//
// Returns whatever bar the user last hovered, or null if they have not hovered
// this chart since it was mounted. Nothing can be done about the null case
// (see the header), so the snapshot degrades to symbol-and-interval rather
// than pretending: ohlc stays null, indicators empty, barTime null.
function readDataBox(): DataBoxRows | null {
  const boxes = document.querySelectorAll('.databox');
  // Exactly one chart is mounted, so a second box means the assumption in the
  // header comment no longer holds; report nothing rather than the wrong chart.
  if (boxes.length !== 1) return null;
  const box = boxes[0];
  const values = new Map<string, number>();
  const order: string[] = [];
  for (const row of box.querySelectorAll('.entries li')) {
    // Labels carry a trailing colour-swatch glyph — drop non-ASCII.
    const label = clean(row.querySelector('.label')?.textContent?.replace(/[^\x20-\x7E]/g, ' '))
      ?.replace(/[:.]$/, '')
      .toLowerCase();
    const value = parseNum(row.querySelector('.desc')?.textContent ?? '');
    if (!label || value === null || values.has(label)) continue;
    values.set(label, value);
    order.push(label);
  }
  if (values.size === 0) return null;
  // "08/28/2026 15:00×" — the × is the box's close button, not part of the time.
  const header = clean(box.querySelector('.header')?.textContent?.replace(/×/g, ''));
  return { barTime: header && !/^-+\/?/.test(header) ? header : null, values, order };
}

function ohlcFrom(rows: DataBoxRows | null): ChartScrape['ohlc'] {
  if (!rows) return null;
  const ohlc = {
    open: rows.values.get('open') ?? null,
    high: rows.values.get('high') ?? null,
    low: rows.values.get('low') ?? null,
    close: rows.values.get('close') ?? null,
  };
  return Object.values(ohlc).some((n) => n !== null) ? ohlc : null;
}

// Tradovate's data box lists every plot of every study as a flat row keyed by
// the plot's name — "upper"/"lower" for Bollinger bands, "rsi"/"middle"/
// "overbought"/"oversold" for RSI. Reported flat, that reads as seven
// indicators, three of which are RSI's guide lines. The persisted workspace
// says which plots belong to which study and with what parameters, so use it
// to fold them back together; rows it does not account for are still reported
// individually, so a stale or missing config loses nothing but the grouping.
//
// The study id is all the DOM has — the display name is drawn on the canvas —
// and Tradovate writes those ids lowercase ("sma", "rsi", "bband"), where
// askfutures.com speaks TA-Lib's uppercase vocabulary (SMA, RSI, BBANDS). Sent
// raw, an RSI on the chart reads to the app as an unsupported study, so
// studyName() canonicalises: uppercase, which is already the right answer for
// every id that is a TA-Lib name spelled in lower case, plus a table for the
// few Tradovate spells differently.
function groupIndicators(
  rows: DataBoxRows | null,
  ticker: string | null,
  timeframe: string | null,
): ChartIndicator[] {
  if (!rows) return [];
  const claimed = new Set<string>(OHLC_LABELS);
  const out: ChartIndicator[] = [];
  for (const cfg of indicatorConfig(ticker, timeframe)) {
    if (out.length >= MAX_INDICATORS) break;
    // A study's sole default plot renders under the study's own name.
    const labels = new Set(cfg.plots.map((p) => (p === '_' ? cfg.name : p).toLowerCase()));
    // Walk the box's rows, not the config's plot keys: the config is a JSON
    // object whose key order is arbitrary, and taking it verbatim buries the
    // reading among its own reference lines — RSI came out [30, 70, 50, 48.9],
    // oversold first and the actual RSI last. The box renders the study's
    // primary plot first, so its order is the one worth preserving.
    const values: number[] = [];
    for (const label of rows.order) {
      if (!labels.has(label) || claimed.has(label)) continue;
      claimed.add(label);
      values.push(rows.values.get(label)!);
    }
    if (values.length === 0) continue;
    out.push({ name: studyName(cfg.name), params: cfg.params, values });
  }
  // Volume is a row on the price series, not a study; drop it only once the
  // configured studies have had their chance to claim a plot of that name.
  claimed.add('volume');
  for (const label of rows.order) {
    if (out.length >= MAX_INDICATORS) break;
    if (claimed.has(label)) continue;
    out.push({ name: studyName(label), params: null, values: [rows.values.get(label)!] });
  }
  return out;
}

// Tradovate ids that are not simply the TA-Lib name in lower case. Only the
// observed ones: an id absent here is uppercased and, if that is not a name
// askfutures.com knows, it arrives as an unrecognised study — which is the
// honest outcome, and better than guessing a mapping for a study nobody has
// looked at. "cmf" (Chaikin Money Flow) is deliberately absent: TA-Lib has no
// CMF, so there is nothing correct to map it to.
const STUDY_NAMES: Record<string, string> = {
  bband: 'BBANDS', // Bollinger Bands
  psar: 'SAR', // Parabolic SAR
};

function studyName(id: string): string {
  return STUDY_NAMES[id] ?? id.toUpperCase();
}

interface IndicatorConfig {
  name: string;
  params: string | null;
  plots: string[];
}

// Tradovate persists each workspace's layout — every chart panel with its
// symbol, interval and studies — under localStorage "workspaces:<accountId>".
// The isolated world shares the page's origin, so this is readable without
// MAIN-world injection.
//
// It is written lazily, though: observed 8.5 hours stale on a live session, so
// it can easily describe a chart the user has since changed. That makes it
// unusable as a source of truth for symbol or interval (both of which the DOM
// gives live) — but usable for grouping, *provided* the panel it describes is
// the one on screen. Hence the corroboration: only a stored chart whose symbol
// AND interval match what the DOM just reported is trusted, and the account is
// never guessed — every stored workspace is searched for that match.
function indicatorConfig(ticker: string | null, timeframe: string | null): IndicatorConfig[] {
  if (!ticker || !timeframe) return [];
  for (const key of workspaceKeys()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(localStorage.getItem(key) ?? '');
    } catch {
      continue;
    }
    for (const chart of chartStates(parsed)) {
      const stream = asArray(prop(chart, 'inputStreamData'))[0];
      if (asString(prop(stream, 'symbol')) !== ticker) continue;
      if (intervalOf(prop(stream, 'chartDescription')) !== timeframe) continue;
      return asArray(prop(chart, 'indicators')).flatMap((ind) => {
        const name = asString(prop(ind, 'name'));
        const plots = prop(ind, 'plots');
        if (!name || !isRecord(plots)) return [];
        return [{ name, params: formatParams(prop(ind, 'params')), plots: Object.keys(plots) }];
      });
    }
  }
  return [];
}

// The "workspaces:*" keys, the signed-in account's first.
//
// The account matters: a profile holds one stored workspace per account, and
// they routinely contain charts of the same symbol and interval — the probed
// profile had an "ESU6 5m" under both of its accounts. Searching in an
// arbitrary order would silently attribute one account's study parameters to
// the other's chart. The keys are named "workspaces:<accountId>", and the
// account switcher names the active one, so prefer that key and fall back to
// the rest only if the DOM does not say (a single-account profile, or a
// selector that has moved).
//
// The residual risk is narrow but worth knowing: if the fallback picks the
// wrong account's chart, a study both charts run — say sma — is reported with
// the wrong period. Names cannot drift, because a study is only reported when
// the data box actually renders a row under its plot's name (see
// groupIndicators); it is the parameters that would be wrong.
function workspaceKeys(): string[] {
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    // localStorage access throws outright when the browser blocks site data.
    return [];
  }
  keys = keys.filter((k) => k.startsWith('workspaces:'));
  const account = activeAccountId();
  if (!account) return keys;
  const preferred = `workspaces:${account}`;
  return keys.includes(preferred) ? [preferred, ...keys.filter((k) => k !== preferred)] : keys;
}

// "DEMO8943554" in the account switcher → "8943554", matching the storage key.
// The id is the digits; the prefix varies by account type.
function activeAccountId(): string | null {
  const label = document.querySelector('li.selected .account .name .main')?.textContent ?? '';
  return /(\d{4,})/.exec(label)?.[1] ?? null;
}

// Every funCharts component state in a stored workspace's golden-layout tree.
function chartStates(root: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 40 || out.length >= 64) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    const state = prop(node, 'componentState');
    if (asString(prop(node, 'componentName')) === 'funCharts' && isRecord(state)) {
      out.push(state);
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(root, 0);
  return out;
}

// { elementSize: 5, underlyingType: "MinuteBar" } → "5m", to compare against
// the interval the tab label renders. Only the units Tradovate's tab labels
// abbreviate are mapped; anything else returns null and simply fails to match,
// which costs the grouping and nothing else.
const UNDERLYING_SUFFIX: Record<string, string> = {
  MinuteBar: 'm',
  HourBar: 'h',
  DailyBar: 'D',
  WeeklyBar: 'W',
  MonthlyBar: 'M',
  Tick: 't',
};

function intervalOf(desc: unknown): string | null {
  const suffix = UNDERLYING_SUFFIX[asString(prop(desc, 'underlyingType')) ?? ''];
  if (!suffix) return null;
  const size = prop(desc, 'elementSize');
  if (typeof size !== 'number' || !Number.isFinite(size)) return null;
  // Daily and up render as a bare "D"/"W"/"M" at size 1, matching the tab.
  return size === 1 && suffix.length === 1 && /[DWM]/.test(suffix) ? suffix : `${size}${suffix}`;
}

// { period: 20 } → "20"; { step: 0.02, maxStep: 0.2 } → "0.02, 0.2" — the
// values only, matching how the other scrapers render display parameters.
function formatParams(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const values = Object.values(params)
    .filter((v): v is number | string => typeof v === 'number' || typeof v === 'string')
    .map(String);
  return values.length > 0 ? values.join(', ') : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function prop(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// "7,722.75" → 7722.75. Tradovate renders plain decimals here, but volume can
// carry separators and RSI can be negative for other studies.
function parseNum(raw: string): number | null {
  const m = /^\s*(-?[\d,]*\.?\d+)\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function clean(s: string | null | undefined): string | null {
  const out = (s ?? '').replace(/\s+/g, ' ').trim();
  return out || null;
}


// Tradovate's own design tokens, read live so the side panel beside it can
// match instead of clash.
//
// Read rather than hardcoded, for two reasons. Tradovate ships light and dark
// themes and the user picks; a baked-in dark palette would be wrong for half
// of them. And the app's own values move — these are read from the same custom
// properties and elements the app renders from, so a retheme carries over
// without an extension release.
//
// The custom properties must be resolved off document.body, not :root: the
// values declared on :root are the *light* defaults, and the dark theme
// overrides them further down the cascade. Reading the declared :root values
// yields a light palette on a dark screen.
function readTheme(): ChartTheme | null {
  try {
    const body = getComputedStyle(document.body);
    const token = (name: string): string | null => body.getPropertyValue(name).trim() || null;
    const background = body.backgroundColor || null;
    return {
      scheme: isDark(background) ? 'dark' : 'light',
      // The app chrome renders in Roboto; document.body carries a different
      // stack that nothing visible actually uses, so take the font from a tab.
      fontFamily: styleOf('li.lm_tab', 'fontFamily') ?? (body.fontFamily || null),
      color: {
        background,
        surface: token('--bgColor'),
        surfaceRaised: token('--boxBackground'),
        border: token('--boxBorderColor'),
        divider: token('--dividerColor'),
        text: token('--bodyText'),
        // The grid's column headings, which is where "muted" is actually used.
        textMuted: styleOf('[class*="fixedDataTableLayout_header"] .public_fixedDataTableCell_cellContent', 'color')
          ?? token('--caption'),
        textDim: styleOf('li.lm_tab:not(.lm_active)', 'color'),
        accent: token('--primaryColor'),
        // Price direction, deliberately not --successColor/--dangerColor: those
        // are status colours (#00bb83 / #f83838) and Tradovate uses a different
        // pair for rising and falling prices in its grids and charts.
        up: token('--importance-icon-fill-green'),
        down: token('--importance-icon-fill-red'),
        rowStripe: token('--tableStripeColor'),
        rowHover: token('--tableStripeColorHover'),
      },
      tab: {
        height: styleOf('li.lm_tab.lm_active', 'height'),
        paddingInline: styleOf('li.lm_tab.lm_active', 'paddingLeft'),
        borderRadius: styleOf('li.lm_tab.lm_active', 'borderRadius'),
        activeBackground: styleOf('li.lm_tab.lm_active', 'backgroundColor'),
        activeText: styleOf('li.lm_tab.lm_active', 'color'),
        idleText: styleOf('li.lm_tab:not(.lm_active)', 'color'),
      },
      grid: {
        rowHeight: styleOf('.public_fixedDataTableCell_cellContent', 'height'),
        cellPaddingInline: styleOf(HEADER_CELL, 'paddingLeft'),
        headerFontSize: styleOf(HEADER_CELL, 'fontSize'),
        headerFontWeight: styleOf(HEADER_CELL, 'fontWeight'),
        headerTextTransform: styleOf(HEADER_CELL, 'textTransform'),
        headerText: styleOf(HEADER_CELL, 'color'),
      },
    };
  } catch {
    // Theming is a nicety; never let it cost the caller a chart snapshot.
    return null;
  }
}

const HEADER_CELL =
  '[class*="fixedDataTableLayout_header"] .public_fixedDataTableCell_cellContent';

function styleOf(selector: string, property: string): string | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const value = getComputedStyle(el)[property as never] as unknown as string;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Which way to theme, from the page's own background rather than a stored
// preference — the rendered colour is the thing the panel has to sit beside.
// Rec. 601 luma, mid-point split; unparseable colours fall back to dark, which
// is Tradovate's default and the safer miss on a trading screen.
function isDark(color: string | null): boolean {
  const m = /rgba?\(([^)]+)\)/.exec(color ?? '');
  if (!m) return true;
  const [r, g, b] = m[1].split(',').map((n) => Number(n.trim()));
  if (![r, g, b].every((n) => Number.isFinite(n))) return true;
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}
