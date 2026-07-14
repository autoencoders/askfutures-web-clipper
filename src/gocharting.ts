// Injected into the gocharting.com tab's isolated world when the AskFutures
// side panel wants a chart snapshot (at panel open, and again on refresh
// requests). Scrapes the chart legend for the timeframe, the last bar's OHLC,
// and the study rows with their last values. Deliberately selector-free:
// GoCharting's class names are minified and churn, so everything anchors on
// the one shape that is stable — the legend *text*,
//
//     CME:ES1! (30m) O: 7,586.75 H: 7,590.00 L: 7,584.75 C: 7,586.25 V: 7.92K
//
// with study rows like "EMA (20) 7,581.25" rendered near it. Fails soft per
// field; the service worker fills ticker/last price from the tab URL and
// title regardless. See design/gocharting-chart-context.md.
//
// Caveat: the legend follows the crosshair / visible range, so the OHLC and
// study values are the *latest bar's* only when the chart is parked at the
// latest bar (the normal case). Scrolled back in time, they reflect the last
// visible bar; the true latest bar is canvas-only and not readable here. See
// the "Known limitation" note in the design doc — not worked around by design.

import type { ChartIndicator } from './shared';

// Partial context from the DOM; the service worker merges in what the tab URL
// and title provide and stamps the envelope fields.
export interface ChartScrape {
  ticker: string | null;
  timeframe: string | null;
  ohlc: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
  } | null;
  indicators: ChartIndicator[];
}

// executeScript does not propagate in-page exceptions to the caller, so the
// call always returns this envelope and the service worker unwraps it.
export type ChartScrapeOutcome =
  | { ok: true; scrape: ChartScrape }
  | { ok: false; error: string };

declare global {
  interface Window {
    __askfuturesChartScrape: () => ChartScrapeOutcome;
  }
}

window.__askfuturesChartScrape = () => {
  try {
    return { ok: true, scrape: scrape() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// The interval as the legend shows it: "(30m)", "(4h)", "(1D)", "(500 tick)".
const TIMEFRAME = /\((\d+\s?(?:[smhDWM]|tick))\)/;

// "CME:ES1!" — an exchange-qualified symbol in the legend text.
const LEGEND_TICKER = /([A-Z][A-Z0-9_.]*:[A-Z0-9!._&/-]+)/;

// A study row: name, optional "(params)", then the last value(s) —
// "EMA (20) 7,581.25", "VWAP 7,580.10", "MACD (12, 26, 9) -3.20 1.10 -4.30".
const INDICATOR_ROW =
  /^([A-Za-z][A-Za-z0-9 %&+./-]{0,60}?)\s*(?:\(([^()]{1,80})\))?((?:\s*-?\d[\d,]*(?:\.\d+)?[KMB%]?)*)\s*$/;

// Each legend row leads with icon buttons and toolbar controls whose
// accessible labels land in textContent with no separators
// ("Add IndicatorsRemoveExponential Moving Average …") — strip that
// control-word prefix before matching. Multi-word controls come first so the
// alternation prefers the longest match ("add indicators" before "add"); no
// trailing \b because the label is glued to the study name.
const CONTROL_PREFIX =
  /^(?:(?:add\s*indicators?|indicators?|hide|show|settings?|delete|remove|edit|duplicate|clone|copy|visible|hidden|invisible|more)\s*)+/i;

const MAX_INDICATORS = 24;

function scrape(): ChartScrape {
  const legend = findMainLegend();
  if (!legend) {
    // No main legend (chart still loading, or a redesign broke the shape) —
    // study rows are searched document-wide, so still try for those.
    return { ticker: null, timeframe: null, ohlc: null, indicators: findIndicatorRows() };
  }
  const text = collapse(legend.textContent ?? '');
  const tf = TIMEFRAME.exec(text);
  // O/H/L/C only after the interval, so single letters inside the ticker
  // ("CME", "ETH") can never match a field.
  const fields = tf ? text.slice(tf.index + tf[0].length) : text;
  const ohlc = {
    open: legendField(fields, 'O'),
    high: legendField(fields, 'H'),
    low: legendField(fields, 'L'),
    close: legendField(fields, 'C'),
  };
  const hasBar = [ohlc.open, ohlc.high, ohlc.low, ohlc.close].some((n) => n !== null);
  return {
    ticker: LEGEND_TICKER.exec(tf ? text.slice(0, tf.index) : text)?.[1] ?? null,
    timeframe: tf ? tf[1].replace(/\s+/g, '') : null,
    ohlc: hasBar ? ohlc : null,
    indicators: findIndicatorRows(),
  };
}

// The smallest element whose text carries the interval plus the O:/C: fields —
// that is the main legend row (or, if GoCharting renders the whole legend as
// one block, the block; findIndicatorRows handles both). The 400-char cap
// keeps chart-wide containers from ever qualifying.
function findMainLegend(): Element | null {
  let best: Element | null = null;
  let bestLen = Infinity;
  for (const el of document.querySelectorAll('body *')) {
    const text = el.textContent ?? '';
    if (text.length === 0 || text.length > 400 || text.length >= bestLen) continue;
    if (!TIMEFRAME.test(text)) continue;
    if (!/O\s*:?\s*-?[\d,]/.test(text) || !/C\s*:?\s*-?[\d,]/.test(text)) continue;
    best = el;
    bestLen = text.length;
  }
  return best;
}

// One O/H/L/C field. textContent may concatenate spans without whitespace
// ("O:7,586.75H:…"), so nothing here requires separators: a digit may sit
// right before the label (hence the letter-only lookbehind, which still keeps
// the H of "ETH" from matching) and must follow it (which keeps "OI:", open
// interest, from matching "O").
function legendField(text: string, label: string): number | null {
  const m = new RegExp(`(?<![A-Za-z])${label}\\s*:?\\s*(-?\\d[\\d,]*(?:\\.\\d+)?)`).exec(
    text,
  );
  return m ? parseNum(m[1]) : null;
}

// Study rows have no stable markup contract, and each chart pane (price,
// volume, oscillators) carries its own legend container, so walk the whole
// document: any subtree whose text parses as a study row is one, and a
// subtree that doesn't is recursed into (a pane legend's text is its rows
// concatenated, which never parses as a single row). The strict filter in
// parseIndicatorRow is what makes a document-wide walk safe.
function findIndicatorRows(): ChartIndicator[] {
  const rows: ChartIndicator[] = [];
  collectRows(document.body, 0, rows);
  return rows;
}

function collectRows(el: Element, depth: number, out: ChartIndicator[]): void {
  if (out.length >= MAX_INDICATORS || depth > 25) return;
  const row = parseIndicatorRow(el.textContent ?? '');
  if (row) {
    out.push(row); // a parsed row's descendants are its fragments — stop here
    return;
  }
  for (const child of el.children) {
    collectRows(child, depth + 1, out);
  }
}

// Rows describing the price series itself, not a study. Rendered upper-case
// in GoCharting's legend ("CANDLESTICK"), matched case-insensitively anyway.
const SERIES_TYPES = new Set([
  'candlestick',
  'bar',
  'line',
  'area',
  'baseline',
  'heikin ashi',
  'hollow candle',
  'renko',
  'kagi',
  'line break',
  'point & figure',
]);

function parseIndicatorRow(raw: string): ChartIndicator | null {
  if (!raw || raw.length > 400) return null;
  // Legend rows put a colored swatch ("■") between the study name and its
  // value; strip anything non-ASCII, then the icon-button label prefix.
  const text = collapse(raw.replace(/[^\x20-\x7E]/g, ' ')).replace(CONTROL_PREFIX, '');
  if (!text || text.length > 200) return null;
  // The main legend row is not a study; neither is anything with O:/H:/… in it.
  if (TIMEFRAME.test(text) || /\b[OHLCV]I?\s*:/.test(text)) return null;
  const m = INDICATOR_ROW.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (!/[A-Za-z]{2}/.test(name) || SERIES_TYPES.has(name.toLowerCase())) return null;
  const values = (m[3] ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(parseNum)
    .filter((n): n is number => n !== null);
  const params = m[2]?.trim() || null;
  // The document-wide walk needs this to stay noise-free: bare words parse as
  // a name-only row ("UPGRADE", "GoCharting", …), so a study must show
  // parameters or a value to count. Costs no-param/no-value studies, which
  // the legend can't distinguish from chrome text anyway.
  if (!params && values.length === 0) return null;
  return { name, params, values };
}

// "7,586.75" → 7586.75, "7.92K" → 7920, "-0.48%" → -0.48.
function parseNum(raw: string): number | null {
  const m = /^(-?[\d,]*(?:\.\d+)?)\s?([KMB%])?$/.exec(raw.trim());
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
