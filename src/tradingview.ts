// Injected into the tradingview.com tab's isolated world when the AskFutures
// side panel wants a chart snapshot (at panel open, and on refresh requests).
// Reads the chart legend for the timeframe, the last bar's OHLC, and the study
// rows with their last values, then hands them back through the shared
// window.__askfuturesChartScrape entry point the service worker calls.
//
// Unlike GoCharting, TradingView exposes stable semantic hooks — data-qa-id on
// legend rows and data-test-id-value-title on the O/H/L/C cells — so this is
// attribute-based, not text-scraping, and fairly robust to class-name churn
// (the class suffixes like "-YTFIJ62h" DO churn, so we never anchor on them).
//
// Caveat (same as GoCharting): the legend follows the crosshair / visible
// range, so OHLC and study values are the latest bar's only when the chart is
// parked at the latest bar. The service worker fills ticker/last price from
// the tab URL and title regardless. See design/gocharting-chart-context.md.

import type { ChartIndicator, ChartScrape } from './shared';

window.__askfuturesChartScrape = () => {
  try {
    return { ok: true, scrape: scrape() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const MAX_INDICATORS = 24;

function scrape(): ChartScrape {
  // The main price series row carries the OHLC cells; study rows are separate.
  const series = document.querySelector('[data-qa-id="legend-series-item"]');
  return {
    // The ticker comes from the tab URL (?symbol=); the legend only has the
    // human description + exchange, so leave the fallback null.
    ticker: null,
    timeframe: interval(),
    ohlc: series ? ohlcFrom(series) : null,
    indicators: indicators(),
  };
}

// The active interval. The header toolbar renders it as a human label ("1m",
// "4h", "1D"); if the user has pinned favourite intervals its text can be a
// run of them, so guard on length and fall back to the legend's interval badge
// (a resolution code like "1" for 1-minute — less friendly, but unambiguous).
function interval(): string | null {
  const toolbar = document.querySelector('#header-toolbar-intervals');
  const active = toolbar?.querySelector('[aria-pressed="true"],[aria-checked="true"]');
  const label = clean(active?.textContent) ?? clean(toolbar?.textContent);
  if (label && label.length <= 8) return label;
  return clean(
    document.querySelector('[data-qa-id~="legend-source-interval"] [class*="title-"]')
      ?.textContent,
  );
}

// O/H/L/C from the series row's value cells, each tagged with a stable
// data-test-id-value-title so we never depend on their order or on the hashed
// value-class suffix.
function ohlcFrom(series: Element): ChartScrape['ohlc'] {
  const field = (label: string) =>
    parseNum(
      series.querySelector(
        `[data-test-id-value-title="${label}"] [class*="valueValue-"]`,
      )?.textContent,
    );
  const ohlc = {
    open: field('O'),
    high: field('H'),
    low: field('L'),
    close: field('C'),
  };
  return [ohlc.open, ohlc.high, ohlc.low, ohlc.close].some((n) => n !== null)
    ? ohlc
    : null;
}

// Every study/indicator row (data-qa-id="legend-source-item"). Strategies show
// up here too (also class "study-"), and counting a strategy overlay as a
// study is fine. Name from the source-title, params from the source-description
// inputs (e.g. "20", "close"), values from the plotted value cells (∅
// placeholders parse to null and drop out).
function indicators(): ChartIndicator[] {
  const out: ChartIndicator[] = [];
  for (const item of document.querySelectorAll('[data-qa-id="legend-source-item"]')) {
    const name = clean(
      item.querySelector('[data-qa-id~="legend-source-title"] [class*="title-"]')
        ?.textContent,
    );
    if (!name) continue;
    const params =
      [...item.querySelectorAll('[data-qa-id~="legend-source-description"] [class*="title-"]')]
        .map((e) => clean(e.textContent))
        .filter(Boolean)
        .join(', ') || null;
    const values = [...item.querySelectorAll('[class*="valueValue-"]')]
      .map((e) => parseNum(e.textContent))
      .filter((n): n is number => n !== null);
    out.push({ name, params, values });
    if (out.length >= MAX_INDICATORS) break;
  }
  return out;
}

// "7,591.11" → 7591.11, "1.2K" → 1200, "−3.75" → -3.75 (unicode minus),
// "∅"/"n/a"/"" → null. Anchored at the start so a trailing "(+0.36%)" change
// tail is ignored.
function parseNum(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^(-?[\d,]*\.?\d+)\s*([KMB])?/.exec(raw.replace(/−/g, '-').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1);
}

function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t || null;
}
