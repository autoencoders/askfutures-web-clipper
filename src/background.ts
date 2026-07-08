// MV3 service worker. Toolbar click → extract in the current tab → buffer the
// clip in chrome.storage.session → open/focus askfutures.com/analyze, where the
// handoff content script delivers it. The buffer is cleared only when the page
// acks (see SECURITY.md), so the clip survives a slow load or a sign-in
// redirect on the askfutures side.

import {
  ANALYZE_URL,
  ANALYZE_URL_PATTERN,
  ASKFUTURES_ORIGIN,
  Clip,
  MAX_CLIP_BYTES,
  RUNTIME_MSG,
  STORAGE_KEY_PENDING_CLIP,
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
  await showStatus(tabId, 'working', 'Clipping this page…');
  try {
    const clip = await extractClip(tabId);
    const bytes = new TextEncoder().encode(JSON.stringify(clip)).length;
    if (bytes > MAX_CLIP_BYTES) {
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      throw new Error(
        `This clip is ${mb} MB — over the 2 MB limit. Try clipping a shorter page.`,
      );
    }
    await chrome.storage.session.set({ [STORAGE_KEY_PENDING_CLIP]: clip });
    await showStatus(tabId, 'done', 'Clipped — opening AskFutures…');
    await openOrFocusAnalyzeTab();
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (err) {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    console.error('[askfutures-clipper]', err);
    await showStatus(
      tabId,
      'error',
      err instanceof Error ? err.message : 'Clipping failed.',
    );
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
  if (sender.id !== chrome.runtime.id || senderOrigin(sender) !== ASKFUTURES_ORIGIN) {
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
      .remove(STORAGE_KEY_PENDING_CLIP)
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  return sender.url ? new URL(sender.url).origin : null;
}

async function showStatus(
  tabId: number,
  state: 'working' | 'done' | 'error',
  message: string,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderStatusWidget,
      args: [state, message],
    });
  } catch {
    // Tab is gone or not injectable; the badge and console already carry the error.
  }
}

// Serialized and executed in the tab (isolated world) — must be self-contained.
// A small overlay card (shadow DOM, so page styles can't touch it) with a
// spinning compass mark while extraction runs, then a success/error state that
// removes itself. Re-invocations update the existing widget in place.
function renderStatusWidget(
  state: 'working' | 'done' | 'error',
  message: string,
): void {
  const HOST_ID = 'askfutures-clipper-status';
  const w = window as Window & { __askfuturesStatusTimers?: number[] };
  for (const t of w.__askfuturesStatusTimers ?? []) clearTimeout(t);
  w.__askfuturesStatusTimers = [];
  const setTimer = (fn: () => void, ms: number) =>
    w.__askfuturesStatusTimers!.push(window.setTimeout(fn, ms));

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:2147483647';
    host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
  }
  const shadow = host.shadowRoot!;
  // The compass mark from the extension icon, as inline SVG.
  const mark =
    '<svg viewBox="0 0 100 100" class="mark" part="mark">' +
    '<path fill="#3b82f6" d="M50 2 58 42 50 50 42 42Z M98 50 58 58 50 50 58 42Z M50 98 42 58 50 50 58 58Z M2 50 42 42 50 50 42 58Z"/>' +
    '<circle cx="50" cy="50" r="9" fill="none" stroke="#0d1b2a" stroke-width="5"/>' +
    '</svg>';
  const icon =
    state === 'working' ? mark : state === 'done' ? '✓' : '✕';
  shadow.innerHTML =
    '<style>' +
    '.card{display:flex;align-items:center;gap:10px;max-width:360px;padding:12px 16px;' +
    'background:#0d1b2a;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;' +
    'border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08)}' +
    '.icon{flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-weight:700}' +
    '.icon.done{color:#34d399}.icon.error{color:#f87171}' +
    '.mark{width:20px;height:20px;animation:spin 1.6s linear infinite}' +
    '@keyframes spin{to{transform:rotate(360deg)}}' +
    '.text b{display:block;font-weight:600}.text small{color:#9ca3af}' +
    '</style>' +
    `<div class="card"><span class="icon ${state}">${icon}</span>` +
    `<span class="text"><b></b><small hidden></small></span></div>`;
  shadow.querySelector('b')!.textContent =
    state === 'error' ? `AskFutures Clipper: ${message}` : message;

  if (state === 'working') {
    // Long extractions (YouTube transcript fetches) deserve a hint that
    // nothing is stuck.
    setTimer(() => {
      const small = shadow.querySelector('small');
      if (small) {
        small.hidden = false;
        small.textContent = 'Still working — transcripts can take a few seconds…';
      }
    }, 5000);
  } else {
    setTimer(() => host.remove(), state === 'done' ? 2500 : 8000);
  }
}
