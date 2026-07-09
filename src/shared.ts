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
} as const;

// v1 clip payload — the contract both repos share (plan doc § "Clip payload").
// site_name/favicon/theme_color are additive optional v1 fields: pure UI
// enrichment for the /analyze preview, always nullable, safe for an older page
// to ignore. Do not bump `v` for them — a page that validates `v === 1` must
// keep accepting these. See SECURITY.md.
export interface Clip {
  v: 1;
  source_url: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  clipped_at: string;
  kind: 'youtube' | 'article';
  content_markdown: string;
  // Site chrome, for coloring the preview UI. Never required.
  site_name: string | null;
  favicon: string | null;
  theme_color: string | null;
}
