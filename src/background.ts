// MV3 service worker. Toolbar click → extract in the current tab → buffer the
// clip in chrome.storage.session → render a preview card overlay in the tab.
// The user confirms with "Send to AskFutures", which messages this worker to
// open/focus askfutures.com/analyze, where the handoff content script delivers
// the buffered clip. The buffer is cleared only when the page acks (see
// SECURITY.md), so the clip survives a slow load or a sign-in redirect on the
// askfutures side; dismissing the card drops it.

import {
  ANALYZE_URL,
  ANALYZE_URL_PATTERN,
  ASKFUTURES_ORIGIN,
  Clip,
  MAX_CLIP_BYTES,
  RUNTIME_MSG,
  STORAGE_KEY_PENDING_CLIP,
  STORAGE_KEY_PENDING_TOKEN,
} from './shared';

chrome.action.onClicked.addListener((tab) => {
  void handleClick(tab);
});

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url || !/^https?:/.test(tab.url)) {
    // chrome:// pages, the Web Store, etc. — nothing can be injected there.
    return;
  }
  const tabId = tab.id;
  await chrome.action.setBadgeText({ tabId, text: '…' });
  await renderCard(tabId, { state: 'working', message: 'Clipping this page…' });
  try {
    const clip = await extractClip(tabId);
    const bytes = new TextEncoder().encode(JSON.stringify(clip)).length;
    if (bytes > MAX_CLIP_BYTES) {
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      throw new Error(
        `This clip is ${mb} MB — over the 2 MB limit. Try clipping a shorter page.`,
      );
    }
    // Buffer now, before the user confirms: the service worker may be torn down
    // between the preview and the "Send" click, and the analyze handoff reads
    // the clip from session storage regardless. The token stamps this clip as
    // the buffer's current occupant so a Send/dismiss from an older card (a
    // second tab clipped after this one) is refused rather than acting on the
    // wrong clip. Dismiss of the matching card clears it.
    const token = crypto.randomUUID();
    await chrome.storage.session.set({
      [STORAGE_KEY_PENDING_CLIP]: clip,
      [STORAGE_KEY_PENDING_TOKEN]: token,
    });
    await chrome.action.setBadgeText({ tabId, text: '' });
    await renderCard(tabId, previewCard(clip, token));
  } catch (err) {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    console.error('[askfutures-clipper]', err);
    await renderCard(tabId, {
      state: 'error',
      message: err instanceof Error ? err.message : 'Clipping failed.',
    });
  }
}

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
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['extractor.js'],
  });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__askfuturesExtract(),
  });
  const outcome = injection.result;
  if (!outcome) {
    throw new Error('Extraction returned nothing — is this a regular web page?');
  }
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.clip;
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

// Source identity + colors for the badge. YouTube gets its brand red and glyph;
// an article gets its favicon plus a background tinted from the page's declared
// theme color (falling back to a neutral slate). Badge text stays a readable
// light color for arbitrary sites — the color comes from the icon and tint.
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
      fg: '#f87171',
      bg: 'rgba(239,68,68,.16)',
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

  const STAR =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="#3b82f6" d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.9l6.5-.9z"/></svg>';
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
    `${STAR}<span class="nm">AskFutures Clipper</span>` +
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
