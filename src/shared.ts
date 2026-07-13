// Constants and types shared by the service worker, the extractor, and the
// handoff content script. The window.postMessage message types are the public
// contract with askfutures.com/analyze — documented in SECURITY.md; change
// them there first.

export const ASKFUTURES_ORIGIN = 'https://askfutures.com';
export const ANALYZE_URL = `${ASKFUTURES_ORIGIN}/analyze`;
export const ANALYZE_URL_PATTERN = `${ASKFUTURES_ORIGIN}/analyze*`;

export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

export const STORAGE_KEY_PENDING_CLIP = 'pendingClip';
// Identity of the currently-buffered clip. Each clip gets a fresh token; the
// preview card carries it so a Send/dismiss from a stale card (a second tab was
// clipped after) can be matched against the buffer and refused instead of
// acting on the wrong clip. Handoff delivery never reads it.
export const STORAGE_KEY_PENDING_TOKEN = 'pendingClipToken';

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
  source: 'gocharting';
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
