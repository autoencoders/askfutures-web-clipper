// Constants and types shared by the service worker, the extractor, and the
// handoff content script. The window.postMessage message types are the public
// contract with askfutures.com/analyze — documented in SECURITY.md; change
// them there first.

export const ASKFUTURES_ORIGIN = 'https://askfutures.com';
export const ANALYZE_URL = `${ASKFUTURES_ORIGIN}/analyze`;
export const ANALYZE_URL_PATTERN = `${ASKFUTURES_ORIGIN}/analyze*`;

export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

export const STORAGE_KEY_PENDING_CLIP = 'pendingClip';

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
} as const;

// v1 clip payload — the contract both repos share (plan doc § "Clip payload").
export interface Clip {
  v: 1;
  source_url: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  clipped_at: string;
  kind: 'youtube' | 'article';
  content_markdown: string;
}
