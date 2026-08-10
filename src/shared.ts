// Constants and types shared by the service worker, the extractor, and the
// handoff content script. The window.postMessage message types are the public
// contract with askfutures.com/analyze — documented in SECURITY.md; change
// them there first.

export const ASKFUTURES_ORIGIN = 'https://askfutures.com';
export const ANALYZE_URL = `${ASKFUTURES_ORIGIN}/analyze`;
export const ANALYZE_URL_PATTERN = `${ASKFUTURES_ORIGIN}/analyze*`;
export const RESEARCH_TOUR_URL = `${ASKFUTURES_ORIGIN}/research-tour`;
export const SESSIONS_URL = `${ASKFUTURES_ORIGIN}/sessions`;

export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

export const STORAGE_KEY_PENDING_CLIP = 'pendingClip';
// Identity of the currently-buffered clip. Each clip gets a fresh token; the
// preview card carries it so a Send/dismiss from a stale card (a second tab was
// clipped after) can be matched against the buffer and refused instead of
// acting on the wrong clip. Handoff delivery never reads it.
export const STORAGE_KEY_PENDING_TOKEN = 'pendingClipToken';

// Research-tour state (see SECURITY.md § "The research-tour messages"). All
// three live in chrome.storage.session — trusted contexts only, cleared on
// browser exit, survives service-worker teardown mid-tour.
//
// The tab id the side panel sits next to. The panel registers it on load and
// whenever the toolbar click re-binds it; tour captures navigate this tab.
export const STORAGE_KEY_PANEL_TAB = 'panelTabId';
// The capture the tour page asked for and the extension is waiting on the
// user's toolbar click to fulfill. One at a time; a new request replaces it.
export const STORAGE_KEY_TOUR_CAPTURE = 'pendingTourCapture';
// The finished capture (tagged clip or failure reason) waiting for the tour
// content script to deliver into the tour page. Cleared on the page's ack.
export const STORAGE_KEY_TOUR_RESULT = 'pendingTourResult';

// window.postMessage types (page <-> content script), see SECURITY.md. These
// mirror session-ui's lib/clip/protocol.ts — change them there first.
export const PAGE_MSG = {
  ready: 'askfutures-analyze-ready',
  clip: 'askfutures-clip',
  clipAck: 'askfutures-clip-ack',
  // Side-panel chart-context bridge (panel page <-> the askfutures.com iframe
  // inside it): the panel posts a ChartContext snapshot into the iframe; the
  // page may post a request back for a fresh one. See SECURITY.md.
  chartContext: 'askfutures-chart-context',
  chartContextRequest: 'askfutures-chart-context-request',
  // Guided research tour (tour page <-> the tour content script sharing its
  // window). Mirrors session-ui's lib/clip/protocol.ts tour constants; the
  // contract is documented in SECURITY.md § "The research-tour messages".
  tourReady: 'askfutures-tour-ready',
  tourCapture: 'askfutures-tour-capture',
  tourClip: 'askfutures-tour-clip',
  tourClipAck: 'askfutures-tour-clip-ack',
  // Additive, extension → page: a capture failed, with the reason. Documented
  // here first per SECURITY.md; a page that predates it ignores the type and
  // falls back to its own capture timeout.
  tourCaptureError: 'askfutures-tour-capture-error',
} as const;

// chrome.runtime message types (content script <-> service worker).
export const RUNTIME_MSG = {
  getPendingClip: 'get-pending-clip',
  clipDelivered: 'clip-delivered',
  clipPending: 'clip-pending',
  // Preview-card actions: the overlay injected into the clipped tab messages
  // the service worker to open AskFutures (send) or drop the buffered clip
  // (dismiss). These come from an arbitrary page origin, so they are gated on
  // sender.id only — see background.ts.
  sendClip: 'send-clip',
  dismissClip: 'dismiss-clip',
  // Side panel → service worker: scrape the chart tab the panel sits next to
  // and respond with a ChartContext snapshot. Extension pages only.
  getChartContext: 'get-chart-context',
  // Service worker → side panel: the toolbar was clicked on this tab while a
  // panel may already be open for it — re-scrape. Makes the toolbar icon
  // double as a refresh button.
  chartContextPing: 'chart-context-ping',
  // Service worker -> offscreen document: extract a PDF's text layer.
  // chrome.runtime.sendMessage broadcasts to every extension context, so the
  // request carries target: 'offscreen' and other listeners ignore it.
  extractPdf: 'extract-pdf',
  // Research tour (tour content script <-> service worker; askfutures.com
  // senders only, like the clip-buffer messages). The tour page asked for a
  // candidate capture; the worker navigates the panel's tab and waits for the
  // user's toolbar click to extract.
  tourCaptureRequest: 'tour-capture-request',
  // The tour content script polls for the finished capture while one is in
  // flight, and reports delivery once the page acks so the worker clears it.
  getPendingTourResult: 'get-pending-tour-result',
  tourClipDelivered: 'tour-clip-delivered',
} as const;

// The offscreen extractor's reply to an extractPdf message. Same envelope
// shape as extractor.ts's ExtractOutcome: the offscreen document never
// rejects, it always resolves to this.
export type PdfExtractOutcome =
  | { ok: true; clip: Clip }
  | { ok: false; error: string };

// v1 clip payload — the contract both repos share (plan doc § "Clip payload").
// site_name/favicon/theme_color/thumbnail_url are additive optional v1 fields:
// pure UI enrichment for the /analyze preview, always nullable, safe for an
// older page to ignore. Do not bump `v` for them — a page that validates
// `v === 1` must keep accepting these. See SECURITY.md.
export interface Clip {
  v: 1;
  source_url: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  clipped_at: string;
  kind: 'youtube' | 'article' | 'pdf';
  content_markdown: string;
  // Site chrome, for coloring the preview UI. Never required.
  site_name: string | null;
  favicon: string | null;
  theme_color: string | null;
  // The page's lead image (og:image/twitter:image), for the /analyze preview.
  // For an article this is the only image source; for YouTube the server can
  // also derive it from the video id. Absolute URL or null. Never required.
  thumbnail_url: string | null;
}

// The pipeline + candidate a tour capture belongs to — opaque ids minted by
// askfutures.com, echoed back verbatim on the tagged clip. Mirrors session-ui's
// TourTags; this repo is public, so nothing internal ever crosses in them.
export interface TourTags {
  pipeline_id: string;
  candidate_id: string;
}

// The capture the tour page requested, buffered until the user's toolbar click
// on the navigated tab fulfills it (the click is the approval — it grants the
// activeTab access extraction needs). requested_at bounds staleness: an
// abandoned tour must not turn a later ordinary click into a tour capture.
export interface TourCapture {
  tags: TourTags;
  url: string;
  tabId: number;
  requested_at: number; // Date.now() in the service worker
}

// The finished capture waiting for delivery into the tour page: the tagged
// clip, or the reason it failed (surfaced to the page as a tourCaptureError
// and already shown to the user by the worker — never silently dropped).
export type TourResult =
  | { ok: true; tags: TourTags; clip: Clip }
  | { ok: false; tags: TourTags; reason: string };

// v1 chart-context snapshot — what the side panel scrapes from the charting
// site it sits next to and hands to askfutures.com (see
// design/gocharting-chart-context.md and SECURITY.md). Every field the DOM
// scrape feeds is nullable: legend selectors can break silently, and the
// snapshot degrades per field (the ticker comes from the tab URL and the last
// price from the tab title, so those usually survive).
export interface ChartIndicator {
  name: string; // "EMA", "VWAP", "MACD"
  params: string | null; // display parameters as shown, e.g. "20" or "12, 26, 9"
  values: number[]; // last rendered value(s); multi-output studies have several
}

export interface ChartContext {
  v: 1;
  source: 'gocharting' | 'tradingview';
  source_url: string;
  ticker: string | null; // "CME:ES1!"
  timeframe: string | null; // "30m", "4h", "1D", …
  last_close: number | null; // C of the in-progress bar = live last price
  ohlc: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
  } | null;
  indicators: ChartIndicator[];
  scraped_at: string; // ISO-8601 UTC, extension clock
}

// The partial context a per-site scraper reads from the page (isolated world)
// and hands back to the service worker, which merges in the ticker (from the
// tab URL) and last price (from the tab title) and stamps the envelope. Shared
// by src/gocharting.ts and src/tradingview.ts; each defines the same
// window.__askfuturesChartScrape entry point, so the worker calls it uniformly.
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

// executeScript swallows in-page exceptions (the result becomes null), so the
// scraper always returns this envelope and the worker unwraps it.
export type ChartScrapeOutcome =
  | { ok: true; scrape: ChartScrape }
  | { ok: false; error: string };

declare global {
  interface Window {
    __askfuturesChartScrape: () => ChartScrapeOutcome;
  }
}
