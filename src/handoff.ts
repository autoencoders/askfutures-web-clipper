// Handoff content script, injected only on askfutures.com/analyze (the one
// host permission). Delivers the buffered clip to the page over a
// window.postMessage handshake — origin-checked both ways, nonce echoed —
// and clears the buffer only after the page acks. See SECURITY.md for the
// contract; the /analyze page implements the other half.

import { ASKFUTURES_ORIGIN, Clip, PAGE_MSG, RUNTIME_MSG } from './shared';

let activeNonce: string | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== ASKFUTURES_ORIGIN) {
    return;
  }
  const data = event.data;
  if (data?.type === PAGE_MSG.ready && typeof data.nonce === 'string') {
    void deliver(data.nonce);
  } else if (
    data?.type === PAGE_MSG.clipAck &&
    activeNonce !== null &&
    data.nonce === activeNonce
  ) {
    activeNonce = null;
    void chrome.runtime.sendMessage({ type: RUNTIME_MSG.clipDelivered });
  }
});

// The service worker pings when it focuses an already-open analyze tab with a
// fresh clip buffered.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === RUNTIME_MSG.clipPending) {
    void queryPageIfClipPending();
  }
});

async function deliver(nonce: string): Promise<void> {
  const clip = await getPendingClip();
  if (!clip) {
    return;
  }
  activeNonce = nonce;
  window.postMessage({ type: PAGE_MSG.clip, nonce, clip }, ASKFUTURES_ORIGIN);
}

// Covers the content-script-arrives-last ordering: if the page announced
// readiness before this script loaded, asking it to re-announce restarts the
// handshake. Only sent when a clip is actually buffered, so ordinary /analyze
// visits stay silent.
async function queryPageIfClipPending(): Promise<void> {
  const clip = await getPendingClip();
  if (clip) {
    window.postMessage({ type: PAGE_MSG.clipQuery }, ASKFUTURES_ORIGIN);
  }
}

async function getPendingClip(): Promise<Clip | null> {
  const response = await chrome.runtime.sendMessage({
    type: RUNTIME_MSG.getPendingClip,
  });
  return response?.clip ?? null;
}

void queryPageIfClipPending();
