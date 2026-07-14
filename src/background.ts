// MV3 service worker. Toolbar click → extract in the current tab → buffer the
// clip in chrome.storage.session → render a preview card overlay in the tab.
// The user confirms with "Send to AskFutures", which messages this worker to
// open/focus askfutures.com/analyze, where the handoff content script delivers
// the buffered clip. The buffer is cleared only when the page acks (see
// SECURITY.md), so the clip survives a slow load or a sign-in redirect on the
// askfutures side; dismissing the card drops it.
//
// Two exceptions to that flow:
// - On charting sites (SIDE_PANEL_DOMAINS) the click clips nothing — it opens
//   the AskFutures side panel (sidepanel.html) so the chart and askfutures.com
//   sit side by side.
// - On PDF tabs (Chrome's viewer rejects script injection, so neither the
//   extractor nor the preview card can run there) extraction happens in a
//   short-lived offscreen document and the click itself is the confirmation:
//   the clip is buffered and /analyze opens directly, no card. Errors surface
//   as badge '!' plus the action's hover title.

import {
  ANALYZE_URL,
  ANALYZE_URL_PATTERN,
  ASKFUTURES_ORIGIN,
  ChartContext,
  Clip,
  MAX_CLIP_BYTES,
  PdfExtractOutcome,
  RUNTIME_MSG,
  STORAGE_KEY_PENDING_CLIP,
  STORAGE_KEY_PENDING_TOKEN,
} from './shared';

// Charting sites where the toolbar click opens the AskFutures side panel
// (side by side with the chart) instead of clipping. Matched against the
// hostname, subdomains included.
const SIDE_PANEL_DOMAINS = [
  'gocharting.com',
  'tradingview.com',
  'robinhood.com',
  'ninjatrader.com',
  'cmegroup.com',
];

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open() must run while the click's user gesture is still live —
  // it does not survive an await, so this branch stays synchronous. The
  // chrome.sidePanel guard falls back to the clip flow on Chrome < 114.
  if (tab.id !== undefined && isSidePanelUrl(tab.url) && chrome.sidePanel) {
    void chrome.sidePanel.open({ tabId: tab.id });
    // If a panel is already open for this tab, nudge it to re-scrape the
    // chart — the toolbar click doubles as a refresh. A just-opened panel has
    // no listener yet; its load-time scrape covers that case (hence the
    // swallowed "no receiver" error).
    chrome.runtime
      .sendMessage({ type: RUNTIME_MSG.chartContextPing, tabId: tab.id })
      .catch(() => {});
    return;
  }
  void handleClick(tab);
});

function isSidePanelUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return (
      /^https?:$/.test(protocol) &&
      SIDE_PANEL_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))
    );
  } catch {
    return false;
  }
}

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url || !/^https?:/.test(tab.url)) {
    // chrome:// pages, the Web Store, etc. — nothing can be injected there.
    return;
  }
  const tabId = tab.id;
  const url = tab.url;
  if (isPdfUrl(url)) {
    await handlePdfClip(tabId, url);
    return;
  }
  await chrome.action.setBadgeText({ tabId, text: '…' });
  await renderCard(tabId, { state: 'working', message: 'Clipping this page…' });
  try {
    const clip = await extractClip(tabId);
    const token = await bufferClip(clip);
    await chrome.action.setBadgeText({ tabId, text: '' });
    await renderCard(tabId, previewCard(clip, token));
  } catch (err) {
    // Chrome's PDF viewer rejects injection, so a PDF served from a non-.pdf
    // path (a download endpoint, say) lands here rather than in the fast path
    // above — sniff the response and reroute instead of erroring.
    if (err instanceof InjectionError && (await sniffIsPdf(url))) {
      await handlePdfClip(tabId, url);
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: '!' });
    console.error('[askfutures-clipper]', err);
    await renderCard(tabId, {
      state: 'error',
      message: err instanceof Error ? err.message : 'Clipping failed.',
    });
  }
}

// Size-check and buffer a clip, before the user confirms: the service worker
// may be torn down between the preview and the "Send" click, and the analyze
// handoff reads the clip from session storage regardless. The returned token
// stamps this clip as the buffer's current occupant so a Send/dismiss from an
// older card (a second tab clipped after this one) is refused rather than
// acting on the wrong clip. Dismiss of the matching card clears it.
async function bufferClip(clip: Clip): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(clip)).length;
  if (bytes > MAX_CLIP_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `This clip is ${mb} MB — over the 2 MB limit. Try clipping a shorter page.`,
    );
  }
  const token = crypto.randomUUID();
  await chrome.storage.session.set({
    [STORAGE_KEY_PENDING_CLIP]: clip,
    [STORAGE_KEY_PENDING_TOKEN]: token,
  });
  return token;
}

// executeScript itself failed — the tab won't take injection at all (Chrome's
// PDF viewer, an error page), as opposed to the extractor running and finding
// nothing. handleClick uses this to tell "can't inject" from "nothing to
// clip" before falling back to the PDF sniff.
class InjectionError extends Error {}

async function extractClip(tabId: number): Promise<Clip> {
  // Two steps: load the bundle (defines window.__askfuturesExtract), then call
  // it via a func injection — executeScript awaits a promise returned from
  // func, which is how the async extraction result gets back here. Both run in
  // the default isolated world: same origin as the page (YouTube InnerTube
  // fetches stay same-origin) but exempt from the page's CSP, which on
  // youtube.com enforces Trusted Types that would break defuddle in the MAIN
  // world. The extractor never rejects; it resolves to an
  // { ok, clip | error } envelope because executeScript swallows in-page
  // exceptions.
  let injection: chrome.scripting.InjectionResult<Awaited<ReturnType<Window['__askfuturesExtract']>>>;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['extractor.js'],
    });
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__askfuturesExtract(),
    });
  } catch (err) {
    throw new InjectionError(err instanceof Error ? err.message : String(err));
  }
  const outcome = injection.result;
  if (!outcome) {
    throw new Error('Extraction returned nothing — is this a regular web page?');
  }
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.clip;
}

// ---------------------------------------------------------------------------
// PDF clipping. See the header comment: no injection works on a PDF tab, so
// extraction runs in an offscreen document and there is no preview card — the
// toolbar click is the confirmation and /analyze opens directly. The service
// worker fetches the bytes (the activeTab grant covers the tab's origin here,
// but not the offscreen document's chrome-extension:// origin) and hands them
// to the offscreen document to parse with pdf.js.

// Mirrors extractor.ts's EXTRACT_TIMEOUT_MS; covers the offscreen parse (the
// fetch below fails fast on its own).
const PDF_TIMEOUT_MS = 45_000;

// The whole file is base64'd into a runtime message to the offscreen parser,
// so bound the download. The 2 MB clip limit (MAX_CLIP_BYTES) applies to the
// extracted text — far smaller than the file — and is enforced after
// extraction in bufferClip.
const MAX_PDF_BYTES = 50 * 1024 * 1024;

const PDF_FETCH_ERROR =
  "Couldn't download this PDF — try reloading the page and clipping again.";

const DEFAULT_ACTION_TITLE = 'Clip to AskFutures';

// Fast path: a URL whose path names a .pdf. PDFs served from other paths are
// caught by the injection-failure sniff in handleClick.
function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

// Authoritative check once injection has failed: decide by Content-Type or
// the %PDF- magic bytes. The activeTab grant from the click covers this
// fetch. Ranged so a hit costs a few bytes; servers that ignore Range just
// get their stream cancelled.
async function sniffIsPdf(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { range: 'bytes=0-4' },
      credentials: 'include',
    });
    if (!res.ok || !res.body) {
      return false;
    }
    if (/application\/pdf/i.test(res.headers.get('content-type') ?? '')) {
      void res.body.cancel().catch(() => {});
      return true;
    }
    const reader = res.body.getReader();
    const { value } = await reader.read();
    void reader.cancel().catch(() => {});
    return new TextDecoder().decode((value ?? new Uint8Array()).slice(0, 5)) === '%PDF-';
  } catch {
    return false;
  }
}

async function handlePdfClip(tabId: number, url: string): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: '…' });
  try {
    const clip = await extractPdfClip(url);
    await bufferClip(clip);
    await openOrFocusAnalyzeTab();
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
  } catch (err) {
    console.error('[askfutures-clipper]', err);
    await chrome.action.setBadgeText({ tabId, text: '!' });
    // No card can render on a PDF tab; the hover title carries the message.
    await chrome.action.setTitle({
      tabId,
      title: `Couldn't clip this PDF — ${err instanceof Error ? err.message : 'clipping failed.'}`,
    });
  }
}

// Extractions currently sharing the single offscreen document. Two tabs can be
// clipped in quick succession and reuse the same document; it must be closed
// only when the *last* one finishes, or a completing clip would tear the
// document out from under one still mid-parse. Incremented before ensuring the
// document so a concurrent clip's increment is already visible when this one's
// finally runs (both are synchronous at call entry — no await between).
let pdfClipsInFlight = 0;

async function extractPdfClip(url: string): Promise<Clip> {
  const dataBase64 = bytesToBase64(await downloadPdf(url));
  pdfClipsInFlight++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await ensureOffscreenDocument();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Timed out reading this PDF.')),
        PDF_TIMEOUT_MS,
      );
    });
    const request = chrome.runtime.sendMessage({
      type: RUNTIME_MSG.extractPdf,
      target: 'offscreen',
      url,
      dataBase64,
    }) as Promise<PdfExtractOutcome | undefined>;
    // If the timeout wins the race, this promise is abandoned and later
    // rejects when closing the document severs the port; swallow that so it
    // isn't an unhandled rejection.
    request.catch(() => {});
    const outcome = await Promise.race([request, timeout]);
    if (!outcome) {
      throw new Error('PDF extraction returned nothing.');
    }
    if (!outcome.ok) {
      throw new Error(outcome.error);
    }
    return outcome.clip;
  } finally {
    clearTimeout(timer);
    if (--pdfClipsInFlight === 0) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }
}

// Fetch the PDF here in the service worker, not in the offscreen document: the
// activeTab grant from the click covers the tab's origin from the worker, but
// the offscreen document's chrome-extension:// origin has no such grant, so a
// cross-origin fetch there (e.g. an SSRN signed URL) is CORS-blocked. Verbatim
// URL so signed URLs keep working; credentials for cookie-gated PDFs. Streamed
// with a size cap so a runaway file can't exhaust memory before parsing.
async function downloadPdf(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error(PDF_FETCH_ERROR);
  }
  if (!res.ok || !res.body) {
    throw new Error(PDF_FETCH_ERROR);
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_PDF_BYTES) {
    throw pdfOversizeError(declared);
  }
  // content-length can lie (or be absent), so count while streaming too.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PDF_BYTES) {
      void reader.cancel().catch(() => {});
      throw pdfOversizeError(total);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function pdfOversizeError(bytes: number): Error {
  const mb = (bytes / (1024 * 1024)).toFixed(0);
  return new Error(`This PDF is ${mb} MB — over the 50 MB limit.`);
}

// Uint8Array → base64 for the JSON runtime message to the offscreen parser
// (MV3 messages can't carry a Uint8Array). Chunked so String.fromCharCode
// isn't handed a spread of millions of args (a stack overflow).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// pdf.js needs worker + DOM APIs the service worker lacks, and can't be
// lazily imported here anyway (no dynamic import in service workers), so it
// lives in an offscreen document created per clip and closed again by
// extractPdfClip once the last in-flight clip finishes. createDocument can
// race a concurrent click; losing that race ("only a single offscreen
// document") is fine — one exists.
async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) {
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
      justification:
        'Extract the text of a clipped PDF with pdf.js, which needs worker and DOM APIs unavailable in the service worker.',
    });
  } catch (err) {
    if (!String(err).toLowerCase().includes('single offscreen')) {
      throw err;
    }
  }
}

async function openOrFocusAnalyzeTab(): Promise<void> {
  const [existing] = await chrome.tabs.query({ url: ANALYZE_URL_PATTERN });
  if (existing?.id === undefined) {
    await chrome.tabs.create({ url: ANALYZE_URL });
    return;
  }
  await chrome.tabs.update(existing.id, { active: true });
  await chrome.windows.update(existing.windowId, { focused: true });
  try {
    await chrome.tabs.sendMessage(existing.id, { type: RUNTIME_MSG.clipPending });
  } catch {
    // No handoff content script in that tab (opened before the extension was
    // installed/updated). Reload so the manifest injects it fresh.
    await chrome.tabs.reload(existing.id);
  }
}

// The handoff content script reads and clears the buffered clip through these
// messages; chrome.storage.session itself stays trusted-context-only. Only the
// askfutures.com content script may touch the buffer.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return;
  }

  // Preview-card actions come from the overlay injected into the clipped tab —
  // an arbitrary page origin, so they are gated on sender.id alone. Only our
  // own isolated-world injection can set that; a page's own scripts have no
  // chrome.runtime access. Neither action touches the page or leaks the clip.
  // Both are token-matched against the buffer so a stale card can neither send
  // the wrong clip nor clear a newer tab's pending clip.
  if (message?.type === RUNTIME_MSG.sendClip) {
    void handleSendClip(message.token, sendResponse);
    return true; // async sendResponse below
  }
  if (message?.type === RUNTIME_MSG.dismissClip) {
    void handleDismissClip(message.token);
    return;
  }

  // Chart-context requests come from the side panel — an extension page, so
  // no sender.tab (content scripts always have one). The worker scrapes the
  // chart tab on demand: activeTab was granted by the toolbar click that
  // opened the panel, and the grant outlives the click, so refresh requests
  // keep working until the tab navigates elsewhere.
  if (message?.type === RUNTIME_MSG.getChartContext) {
    if (sender.tab) {
      return;
    }
    void handleGetChartContext(message.tabId, sendResponse);
    return true; // async sendResponse below
  }

  // Buffer access is askfutures.com-only.
  if (senderOrigin(sender) !== ASKFUTURES_ORIGIN) {
    return;
  }
  if (message?.type === RUNTIME_MSG.getPendingClip) {
    void chrome.storage.session
      .get(STORAGE_KEY_PENDING_CLIP)
      .then((items) => sendResponse({ clip: items[STORAGE_KEY_PENDING_CLIP] ?? null }));
    return true;
  }
  if (message?.type === RUNTIME_MSG.clipDelivered) {
    void chrome.storage.session
      .remove([STORAGE_KEY_PENDING_CLIP, STORAGE_KEY_PENDING_TOKEN])
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Confirm from a preview card. Open /analyze only when the card's clip is still
// the buffered one; a stale card (its clip was overwritten by a later clip) is
// told so, and never triggers delivery of the newer clip.
async function handleSendClip(
  token: unknown,
  sendResponse: (response: { ok: boolean; reason?: 'stale' | 'gone' }) => void,
): Promise<void> {
  const items = await chrome.storage.session.get([
    STORAGE_KEY_PENDING_CLIP,
    STORAGE_KEY_PENDING_TOKEN,
  ]);
  if (!items[STORAGE_KEY_PENDING_CLIP]) {
    sendResponse({ ok: false, reason: 'gone' });
    return;
  }
  if (items[STORAGE_KEY_PENDING_TOKEN] !== token) {
    sendResponse({ ok: false, reason: 'stale' });
    return;
  }
  await openOrFocusAnalyzeTab();
  sendResponse({ ok: true });
}

// Dismiss from a preview card. Drop the buffer only if this card owns it, so
// closing a stale card leaves a newer tab's pending clip intact.
async function handleDismissClip(token: unknown): Promise<void> {
  const items = await chrome.storage.session.get(STORAGE_KEY_PENDING_TOKEN);
  if (items[STORAGE_KEY_PENDING_TOKEN] === token) {
    await chrome.storage.session.remove([
      STORAGE_KEY_PENDING_CLIP,
      STORAGE_KEY_PENDING_TOKEN,
    ]);
  }
}

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  return sender.url ? new URL(sender.url).origin : null;
}

// Scrape the chart tab and answer the side panel with a ChartContext snapshot
// (design/gocharting-chart-context.md). Fails as an { ok: false } response —
// never a thrown error — so the panel can degrade to a plain askfutures view.
async function handleGetChartContext(
  tabId: unknown,
  sendResponse: (
    response: { ok: true; context: ChartContext } | { ok: false; error: string },
  ) => void,
): Promise<void> {
  try {
    if (typeof tabId !== 'number') {
      throw new Error('Bad tab id.');
    }
    const tab = await chrome.tabs.get(tabId);
    // Without the activeTab grant tab.url is invisible and this refuses —
    // scraping is only ever attempted where injection is already permitted.
    const site = chartSiteFor(tab.url);
    if (!site) {
      throw new Error('Not a supported chart tab.');
    }
    sendResponse({ ok: true, context: await scrapeChartContext(tabId, tab, site) });
  } catch (err) {
    sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Per-site chart scraping. Each entry owns the parts that differ by site — the
// injected scraper bundle, how the ticker is read from the URL, and how the
// last price is read from the tab title — while the DOM scrape returns a common
// ChartScrape shape through the shared window.__askfuturesChartScrape entry.
// Sites not listed here still get the plain side panel, just no chart context.
interface ChartSite {
  source: ChartContext['source'];
  scraperFile: string;
  matchesHost: (hostname: string) => boolean;
  tickerFromUrl: (url: string) => string | null;
  lastPriceFromTitle: (title: string | undefined) => number | null;
}

const CHART_SITES: ChartSite[] = [
  {
    source: 'gocharting',
    scraperFile: 'gocharting.js',
    matchesHost: (h) => h === 'gocharting.com' || h.endsWith('.gocharting.com'),
    // gocharting.com/terminal?ticker=CME:ES1%21 → "CME:ES1!"
    tickerFromUrl: (url) => urlParam(url, 'ticker'),
    // GoCharting's tab title leads with the live price: "7515.5 (-0.48%) @ …".
    lastPriceFromTitle: (title) => firstNumber(/^\s*(-?[\d,]+(?:\.\d+)?)\s*\(/, title),
  },
  {
    source: 'tradingview',
    scraperFile: 'tradingview.js',
    matchesHost: (h) => h === 'tradingview.com' || h.endsWith('.tradingview.com'),
    // tradingview.com/chart/…/?symbol=CME_MINI%3AES1%21 → "CME_MINI:ES1!"
    tickerFromUrl: (url) => urlParam(url, 'symbol'),
    // TradingView's tab title: "ES1! 7,591.50 ▲ +0.38% …" — the price sits
    // before the up/down arrow (the symbol may contain digits, so anchor on it).
    lastPriceFromTitle: (title) => firstNumber(/([\d,]+(?:\.\d+)?)\s*[▲▼△▽]/, title),
  },
];

function chartSiteFor(url: string | undefined): ChartSite | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    if (!/^https?:$/.test(protocol)) return null;
    return CHART_SITES.find((s) => s.matchesHost(hostname)) ?? null;
  } catch {
    return null;
  }
}

// Same two-step injection as extractClip: load the site's bundle (defines
// window.__askfuturesChartScrape), then call it. The DOM scrape fails soft —
// the tab URL still yields the ticker and the tab title the last price, so a
// broken legend selector degrades the snapshot instead of emptying it.
async function scrapeChartContext(
  tabId: number,
  tab: chrome.tabs.Tab,
  site: ChartSite,
): Promise<ChartContext> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [site.scraperFile],
  });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__askfuturesChartScrape(),
  });
  const outcome = injection.result;
  const scrape = outcome?.ok ? outcome.scrape : null;
  const url = tab.url ?? '';
  return {
    v: 1,
    source: site.source,
    source_url: url,
    ticker: site.tickerFromUrl(url) ?? scrape?.ticker ?? null,
    timeframe: scrape?.timeframe ?? null,
    last_close: scrape?.ohlc?.close ?? site.lastPriceFromTitle(tab.title),
    ohlc: scrape?.ohlc ?? null,
    indicators: scrape?.indicators ?? [],
    scraped_at: new Date().toISOString(),
  };
}

function urlParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name)?.trim() || null;
  } catch {
    return null;
  }
}

function firstNumber(re: RegExp, text: string | undefined): number | null {
  const m = re.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Everything the injected overlay needs, computed here (the service worker can
// use helpers; the injected function must stay self-contained). Passed as a
// single structured-cloneable arg to renderClipCard.
interface CardData {
  state: 'working' | 'error' | 'preview';
  message?: string;
  // Preview fields.
  sourceLabel?: string; // "Captured from YouTube"
  badgeFg?: string; // badge text/tint color
  badgeBg?: string; // badge background
  iconSvg?: string; // inline brand glyph (YouTube); we build it, so it is trusted
  faviconUrl?: string | null; // site favicon, when there is no brand glyph
  badgeInitial?: string; // letter chip shown if the favicon fails to load
  title?: string;
  metaText?: string; // "1,240 words · full transcript"
  sendLabel?: string;
  sendType?: string; // RUNTIME_MSG.sendClip — the confirm button's message
  dismissType?: string; // RUNTIME_MSG.dismissClip — the close button's message
  token?: string; // identifies this card's clip against the shared buffer
}

async function renderCard(tabId: number, data: CardData): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderClipCard,
      args: [data],
    });
  } catch {
    // Tab is gone or not injectable; the badge and console already carry state.
  }
}

// The classic YouTube play-button mark, so the source badge reads as the brand
// (an article uses its favicon instead — see brandFor).
const YOUTUBE_GLYPH =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
  '<path fill="#ff0000" d="M23.5 6.5a3 3 0 0 0-2.1-2.1C19.6 4 12 4 12 4s-7.6 0-9.4.4A3 3 0 0 0 .5 6.5 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.5 3 3 0 0 0 2.1 2.1C4.4 20 12 20 12 20s7.6 0 9.4-.4a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.5z"/>' +
  '<path fill="#fff" d="M9.6 15.6V8.4l6.3 3.6z"/></svg>';

function previewCard(clip: Clip, token: string): CardData {
  const brand = brandFor(clip);
  return {
    state: 'preview',
    sourceLabel: `Captured from ${brand.sourceName}`,
    badgeFg: brand.fg,
    badgeBg: brand.bg,
    iconSvg: brand.iconSvg,
    faviconUrl: brand.faviconUrl,
    badgeInitial: brand.sourceName.slice(0, 1).toUpperCase() || '•',
    title: clip.title?.trim() || 'Untitled page',
    metaText: wordCountLabel(clip),
    sendLabel: 'Send to AskFutures',
    sendType: RUNTIME_MSG.sendClip,
    dismissType: RUNTIME_MSG.dismissClip,
    token,
  };
}

// Source identity + colors for the badge. The badge text and background stay a
// neutral slate for every source so the pill never reads as a warning — the
// color comes only from the icon: YouTube's red glyph, or an article's favicon.
function brandFor(clip: Clip): {
  sourceName: string;
  fg: string;
  bg: string;
  iconSvg: string;
  faviconUrl: string | null;
} {
  if (clip.kind === 'youtube') {
    return {
      sourceName: clip.site_name || 'YouTube',
      fg: '#cbd5e1',
      bg: 'rgba(148,163,184,.14)',
      iconSvg: YOUTUBE_GLYPH,
      faviconUrl: null,
    };
  }
  return {
    sourceName: clip.site_name || hostnameOf(clip.source_url),
    fg: '#cbd5e1',
    bg: translucentBg(clip.theme_color) ?? 'rgba(148,163,184,.14)',
    iconSvg: '',
    faviconUrl: clip.favicon,
  };
}

function wordCountLabel(clip: Clip): string {
  const words = clip.content_markdown.trim().split(/\s+/).filter(Boolean).length;
  const n = new Intl.NumberFormat('en-US').format(words);
  // Only the non-PDF path renders a card (PDF tabs can't host the overlay),
  // so clip.kind is 'youtube' or 'article' here.
  const kind = clip.kind === 'youtube' ? 'full transcript' : 'article';
  return `${n} words · ${kind}`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'this page';
  }
}

// A #hex theme color → a faint translucent fill for the badge background. Only
// hex is converted (rgb()/hsl()/named colors return null → neutral fallback);
// any embedded alpha is ignored in favor of our own.
function translucentBg(color: string | null): string | null {
  if (!color) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length < 6) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},.18)`;
}

// Serialized and executed in the tab (isolated world) — must be self-contained,
// closing over nothing but its `data` arg, `window`, `document`, and
// `chrome.runtime`. Renders a shadow-DOM card (page styles can't reach in) that
// mirrors the AskFutures preview: a spinner while extracting, a self-removing
// error state, or the confirm card (source badge, title, word count, "Send to
// AskFutures"). Its buttons message the service worker; the card drives its own
// removal. Re-invocations update the card in place.
function renderClipCard(data: CardData): void {
  const HOST_ID = 'askfutures-clipper-card';
  const w = window as Window & { __askfuturesCardTimers?: number[] };
  for (const t of w.__askfuturesCardTimers ?? []) clearTimeout(t);
  w.__askfuturesCardTimers = [];
  const timer = (fn: () => void, ms: number) =>
    w.__askfuturesCardTimers!.push(window.setTimeout(fn, ms));

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
    host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
  }
  const shadow = host.shadowRoot!;
  const drop = () => {
    for (const t of w.__askfuturesCardTimers ?? []) clearTimeout(t);
    host.remove();
  };
  const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
    );

  // The AskFutures compass mark (same as the extension icon), static.
  const LOGO =
    '<svg viewBox="0 0 100 100" width="17" height="17" aria-hidden="true">' +
    '<path fill="#3b82f6" d="M50 2 58 42 50 50 42 42Z M98 50 58 58 50 50 58 42Z M50 98 42 58 50 50 58 58Z M2 50 42 42 50 50 42 58Z"/>' +
    '<circle cx="50" cy="50" r="9" fill="none" stroke="#0f1626" stroke-width="5"/></svg>';
  const COMPASS =
    '<svg viewBox="0 0 100 100" class="mark" width="20" height="20">' +
    '<path fill="#3b82f6" d="M50 2 58 42 50 50 42 42Z M98 50 58 58 50 50 58 42Z M50 98 42 58 50 50 58 58Z M2 50 42 42 50 50 42 58Z"/>' +
    '<circle cx="50" cy="50" r="9" fill="none" stroke="#0f1626" stroke-width="5"/></svg>';

  const STYLE =
    '<style>' +
    '*{box-sizing:border-box}' +
    '.card{width:320px;background:#0f1626;color:#e8edf6;' +
    "font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    'border:1px solid rgba(255,255,255,.09);border-radius:16px;overflow:hidden;' +
    'box-shadow:0 14px 40px rgba(0,0,0,.5)}' +
    '.hd{display:flex;align-items:center;gap:9px;padding:13px 15px;' +
    'border-bottom:1px solid rgba(255,255,255,.07)}' +
    '.hd .nm{font-weight:600;flex:1}' +
    '.x{flex:none;border:0;background:none;color:#8a97ad;cursor:pointer;' +
    'font-size:16px;line-height:1;padding:3px 6px;border-radius:6px}' +
    '.x:hover{color:#e8edf6;background:rgba(255,255,255,.08)}' +
    '.bd{padding:14px 15px 15px}' +
    '.badge{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;' +
    'border-radius:8px;font-size:12.5px;font-weight:600;max-width:100%}' +
    '.badge svg,.badge img,.badge .chip{flex:none;width:15px;height:15px;' +
    'border-radius:3px;display:block;object-fit:cover}' +
    '.badge .chip{display:flex;align-items:center;justify-content:center;' +
    'font-size:9px;font-weight:700;background:currentColor}' +
    '.badge .chip span{color:#0f1626}' +
    '.badge .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.title{margin:12px 0 9px;font-size:17px;font-weight:600;line-height:1.3;' +
    'color:#f4f7fc;display:-webkit-box;-webkit-line-clamp:2;' +
    '-webkit-box-orient:vertical;overflow:hidden}' +
    '.meta{display:flex;align-items:center;gap:7px;margin-bottom:14px;' +
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a97ad}' +
    '.meta .dot{width:7px;height:7px;border-radius:50%;background:#34d399;flex:none}' +
    '.send{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;' +
    'padding:11px 14px;border:0;border-radius:11px;cursor:pointer;background:#2563eb;' +
    'color:#fff;font:600 14px system-ui,sans-serif}' +
    '.send:hover{background:#1d4ed8}.send[disabled]{opacity:.7;cursor:default}' +
    '.status{display:flex;align-items:center;gap:11px}' +
    '.status .msg b{display:block;font-weight:600}' +
    '.status .msg small{display:block;color:#8a97ad;margin-top:2px}' +
    '.mark{animation:af-spin 1.4s linear infinite}' +
    '@keyframes af-spin{to{transform:rotate(360deg)}}' +
    '.err{flex:none;width:20px;height:20px;display:flex;align-items:center;' +
    'justify-content:center;color:#f87171;font-weight:700}' +
    '</style>';

  let body: string;
  if (data.state === 'preview') {
    const icon = data.iconSvg
      ? data.iconSvg
      : data.faviconUrl
        ? `<img alt="" src="${esc(data.faviconUrl)}">`
        : `<span class="chip" style="color:${esc(data.badgeFg)}">` +
          `<span>${esc(data.badgeInitial)}</span></span>`;
    body =
      '<div class="bd">' +
      `<span class="badge" style="color:${esc(data.badgeFg)};background:${esc(data.badgeBg)}">` +
      `${icon}<span class="lbl">${esc(data.sourceLabel)}</span></span>` +
      `<div class="title">${esc(data.title)}</div>` +
      `<div class="meta"><span class="dot"></span>${esc(data.metaText)}</div>` +
      `<button class="send" type="button">${esc(data.sendLabel)} <span>→</span></button>` +
      '</div>';
  } else if (data.state === 'error') {
    body =
      '<div class="bd"><div class="status"><span class="err">✕</span>' +
      `<span class="msg"><b>Couldn't clip this page</b><small>${esc(data.message)}</small></span>` +
      '</div></div>';
  } else {
    body =
      '<div class="bd"><div class="status">' +
      `<span>${COMPASS}</span>` +
      `<span class="msg"><b>${esc(data.message)}</b><small hidden></small></span>` +
      '</div></div>';
  }

  shadow.innerHTML =
    STYLE +
    '<div class="card"><div class="hd">' +
    `${LOGO}<span class="nm">AskFutures Clipper</span>` +
    '<button class="x" type="button" aria-label="Dismiss">✕</button></div>' +
    body +
    '</div>';

  shadow.querySelector('.x')?.addEventListener('click', () => {
    if (data.dismissType) {
      try {
        void chrome.runtime.sendMessage({ type: data.dismissType, token: data.token });
      } catch {
        // Extension context gone mid-teardown; removing the card is enough.
      }
    }
    drop();
  });

  if (data.state === 'preview') {
    const send = shadow.querySelector<HTMLButtonElement>('.send');
    if (send) {
      send.addEventListener('click', () => {
        send.disabled = true;
        send.textContent = 'Opening AskFutures…';
        const settle = (ok: boolean) => {
          if (ok) {
            timer(drop, 1400);
            return;
          }
          // The buffer moved on — a newer clip replaced this one (another tab
          // was clipped after), or it was already sent. Say so instead of
          // silently opening AskFutures with the wrong page.
          send.textContent = 'This clip was replaced — re-clip the page';
          send.style.background = '#7f1d1d';
          send.style.cursor = 'default';
          timer(drop, 6000);
        };
        try {
          const pending = data.sendType
            ? chrome.runtime.sendMessage({ type: data.sendType, token: data.token })
            : null;
          if (pending && typeof pending.then === 'function') {
            pending.then((res) => settle(!!(res && res.ok))).catch(() => settle(true));
          } else {
            settle(true);
          }
        } catch {
          // Extension context gone mid-teardown; just clean up.
          settle(true);
        }
      });
    }
    const img = shadow.querySelector<HTMLImageElement>('.badge img');
    if (img) {
      img.addEventListener('error', () => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.color = data.badgeFg ?? '#cbd5e1';
        const letter = document.createElement('span');
        letter.textContent = data.badgeInitial ?? '•';
        chip.appendChild(letter);
        img.replaceWith(chip);
      });
    }
  } else if (data.state === 'working') {
    // Long extractions (YouTube transcript fetches) deserve a hint that
    // nothing is stuck.
    timer(() => {
      const small = shadow.querySelector('small');
      if (small) {
        small.hidden = false;
        small.textContent = 'Still working — transcripts can take a few seconds…';
      }
    }, 5000);
  } else {
    timer(drop, 8000);
  }
}
