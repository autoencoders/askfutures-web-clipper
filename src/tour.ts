// Research-tour content script, injected on askfutures.com/research-tour —
// including inside the extension side panel's iframe (all_frames), which is
// where the tour page actually runs. The bridge mirrors handoff.ts: the page
// and this script share a window, every message is origin-checked both ways,
// and a tagged clip is delivered with an extension-generated nonce and cleared
// only on the page's ack. See SECURITY.md § "The research-tour messages";
// session-ui's lib/clip/protocol.ts implements the other half.
//
// Unlike /analyze, the tour page announces readiness only once, so delivery is
// driven from this side: while a capture is in flight this script polls the
// service worker for the finished result (the poll also survives a worker
// restart — the result lives in chrome.storage.session) and re-posts it until
// the page acks.

import { ASKFUTURES_ORIGIN, PAGE_MSG, RUNTIME_MSG, TourResult } from './shared';

// How long to keep polling after a capture request: the user has to eyeball
// the candidate page and click the toolbar, so this is minutes, not seconds.
// Matches the worker's TOUR_CAPTURE_TTL_MS — a capture approved at the last
// minute must still find a live poller. The tour page applies its own
// (shorter) per-capture timeout and shows the candidate as failed if the user
// never clicks.
const CAPTURE_POLL_WINDOW_MS = 15 * 60 * 1000;
// A short window on load / page-ready, to deliver a result left over from
// before this document (or the service worker) was reloaded mid-capture. The
// worker's capturePending flag extends it (below) whenever a capture from a
// previous document of this page is still awaiting the user's click.
const STARTUP_POLL_WINDOW_MS = 10 * 1000;
// Rolling extension while the worker reports a capture in flight.
const PENDING_KEEPALIVE_MS = 30 * 1000;
const POLL_INTERVAL_MS = 1000;

// nonce → the worker's result token, echoed on tourClipDelivered so the
// worker clears exactly the capture this ack belongs to.
const sentNonces = new Map<string, string>();
let pollDeadline = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== ASKFUTURES_ORIGIN) {
    return;
  }
  const data = event.data;
  if (data?.type === PAGE_MSG.tourCapture) {
    void forwardCaptureRequest(data);
  } else if (data?.type === PAGE_MSG.tourReady) {
    // The page just mounted; deliver any capture finished before it loaded.
    startPolling(STARTUP_POLL_WINDOW_MS);
  } else if (
    data?.type === PAGE_MSG.tourClipAck &&
    typeof data.nonce === 'string' &&
    sentNonces.has(data.nonce)
  ) {
    const token = sentNonces.get(data.nonce)!;
    sentNonces.clear();
    stopPolling();
    void chrome.runtime.sendMessage({
      type: RUNTIME_MSG.tourClipDelivered,
      token,
    });
  }
});

// The page posts { type, pipeline_id, candidate_id, url } (session-ui's
// TourCaptureMessage). Validate the shape here and again in the worker — the
// page side of this window is untrusted input like any other.
async function forwardCaptureRequest(data: {
  pipeline_id?: unknown;
  candidate_id?: unknown;
  url?: unknown;
}): Promise<void> {
  const { pipeline_id, candidate_id, url } = data;
  if (
    typeof pipeline_id !== 'string' ||
    !pipeline_id ||
    typeof candidate_id !== 'string' ||
    !candidate_id ||
    typeof url !== 'string' ||
    !isHttpUrl(url)
  ) {
    return;
  }
  const tags = { pipeline_id, candidate_id };
  let response: { ok: boolean; error?: string } | undefined;
  try {
    response = await chrome.runtime.sendMessage({
      type: RUNTIME_MSG.tourCaptureRequest,
      pipeline_id,
      candidate_id,
      url,
    });
  } catch {
    response = undefined;
  }
  if (!response?.ok) {
    postCaptureError(tags, response?.error ?? "Couldn't reach the extension.");
    return;
  }
  startPolling(CAPTURE_POLL_WINDOW_MS);
}

function startPolling(windowMs: number): void {
  pollDeadline = Math.max(pollDeadline, Date.now() + windowMs);
  if (pollTimer === null) {
    void poll();
  }
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  pollDeadline = 0;
}

async function poll(): Promise<void> {
  pollTimer = null;
  if (Date.now() > pollDeadline) {
    stopPolling();
    return;
  }
  let result: TourResult | null = null;
  let capturePending = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: RUNTIME_MSG.getPendingTourResult,
    });
    result = response?.result ?? null;
    capturePending = response?.capturePending === true;
  } catch {
    // Worker mid-restart; try again next tick.
  }
  if (result) {
    if (result.ok) {
      // Re-posted every poll until the ack lands; the page acks anything it
      // parses, so duplicates are acked and dropped by its candidate matching.
      const nonce = crypto.randomUUID();
      sentNonces.set(nonce, result.token);
      window.postMessage(
        {
          type: PAGE_MSG.tourClip,
          nonce,
          tags: result.tags,
          payload: result.clip,
        },
        ASKFUTURES_ORIGIN,
      );
    } else {
      // Failure is one-shot: the worker cleared it when this poll fetched it,
      // and it was already surfaced to the user via notification/card. But
      // the capture itself may still be claimable — the user can fix the page
      // and click the toolbar again — so keep polling while the worker
      // reports it pending, or the retry's success would sit undelivered.
      postCaptureError(result.tags, result.reason);
      if (!capturePending) {
        stopPolling();
        return;
      }
      pollDeadline = Math.max(pollDeadline, Date.now() + PENDING_KEEPALIVE_MS);
    }
  } else if (capturePending) {
    // The user is still eyeballing the candidate — keep the loop alive past
    // this document's own window (it may have loaded mid-capture, e.g. after
    // a panel view toggle) until the worker's capture expires or resolves.
    pollDeadline = Math.max(pollDeadline, Date.now() + PENDING_KEEPALIVE_MS);
  }
  pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
}

// Additive message the current tour page ignores (it has its own capture
// timeout); a future page version can use it to fail the candidate fast with
// the real reason. Fire-and-forget by design — see SECURITY.md.
function postCaptureError(
  tags: { pipeline_id: string; candidate_id: string },
  reason: string,
): void {
  window.postMessage(
    { type: PAGE_MSG.tourCaptureError, tags, reason },
    ASKFUTURES_ORIGIN,
  );
}

function isHttpUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Deliver a result left over from a reload of this frame mid-capture.
startPolling(STARTUP_POLL_WINDOW_MS);
