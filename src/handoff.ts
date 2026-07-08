// Handoff content script, injected only on askfutures.com/analyze (the one
// host permission). Delivers the buffered clip to the page over the
// window.postMessage handshake — origin-checked both ways, with an
// extension-generated nonce binding each ack to a message we actually sent —
// and clears the buffer only after the page acks. See SECURITY.md for the
// contract; session-ui's lib/clip/protocol.ts implements the other half.
//
// The page announces readiness every second until a clip lands, so delivery
// needs no kick-off from this side: whenever an announcement arrives and a
// clip is buffered, send it. Once the ack clears the buffer, later
// announcements find nothing and stop resending.

import { ASKFUTURES_ORIGIN, Clip, PAGE_MSG, RUNTIME_MSG } from './shared';

const sentNonces = new Set<string>();

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== ASKFUTURES_ORIGIN) {
    return;
  }
  const data = event.data;
  if (data?.type === PAGE_MSG.ready) {
    void deliver();
  } else if (
    data?.type === PAGE_MSG.clipAck &&
    typeof data.nonce === 'string' &&
    sentNonces.has(data.nonce)
  ) {
    sentNonces.clear();
    void chrome.runtime.sendMessage({ type: RUNTIME_MSG.clipDelivered });
  }
});

// The service worker pings when it focuses an already-open analyze tab with a
// fresh clip buffered. The page stops announcing once it holds a clip, so
// deliver directly instead of waiting for an announcement that may never come;
// its message listener stays live for the page's lifetime.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === RUNTIME_MSG.clipPending) {
    void deliver();
  }
});

async function deliver(): Promise<void> {
  const clip = await getPendingClip();
  if (!clip) {
    return;
  }
  const nonce = crypto.randomUUID();
  sentNonces.add(nonce);
  window.postMessage(
    { type: PAGE_MSG.clip, nonce, payload: clip },
    ASKFUTURES_ORIGIN,
  );
}

async function getPendingClip(): Promise<Clip | null> {
  const response = await chrome.runtime.sendMessage({
    type: RUNTIME_MSG.getPendingClip,
  });
  return response?.clip ?? null;
}
