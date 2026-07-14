// Side panel page script. The panel itself is just an iframe on
// askfutures.com; this script adds the chart-context bridge: on load it asks
// the service worker to scrape the chart in the tab the panel sits next to,
// and posts the snapshot into the iframe. The embedded page can ask for a
// fresh snapshot with askfutures-chart-context-request (e.g. right before the
// user submits a trading idea). Snapshots only — there is no live observation
// of the chart. See SECURITY.md for the message contract.

import { ASKFUTURES_ORIGIN, ChartContext, PAGE_MSG, RUNTIME_MSG } from './shared';

const iframe = document.querySelector('iframe')!;

// The tab this panel was opened against. Captured once at load: the panel is
// tab-scoped (sidePanel.open({ tabId })), so the active tab at load time is
// the chart tab, and it stays the right target even if the user later focuses
// another tab in the window. No "tabs" permission needed — only the id is
// read here, never url/title.
let chartTabId: number | null = null;
let iframeReady = false;
let latest: ChartContext | null = null;

iframe.addEventListener('load', () => {
  iframeReady = true;
  post();
});

// The service worker pings when the toolbar is clicked on a chart tab. That
// click is the authoritative "scrape this tab" signal, so re-bind to it and
// refresh — Chrome reuses one panel across tab switches without reloading it,
// so the tab captured at load (init) can otherwise go stale (e.g. the panel
// was first opened next to a different tab).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === RUNTIME_MSG.chartContextPing && typeof message.tabId === 'number') {
    chartTabId = message.tabId;
    void refresh();
  }
});

// The askfutures page inside the iframe can request a fresh snapshot.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.origin !== ASKFUTURES_ORIGIN || event.source !== iframe.contentWindow) {
    return;
  }
  if (event.data?.type === PAGE_MSG.chartContextRequest) {
    void refresh();
  }
});

void init();

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  chartTabId = tab.id;
  await refresh();
}

async function refresh(): Promise<void> {
  if (chartTabId === null) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: RUNTIME_MSG.getChartContext,
      tabId: chartTabId,
    });
    if (response?.ok && response.context) {
      latest = response.context as ChartContext;
      // Visible in the panel's DevTools — the askfutures.com counterpart may
      // not exist yet, so this is the one place a human can see the snapshot.
      console.info('[askfutures-clipper] chart context', latest);
      post();
    } else if (response?.error) {
      console.info('[askfutures-clipper] chart context unavailable:', response.error);
    }
  } catch {
    // Scrape failed or the worker refused (not a supported chart tab); the
    // panel still works as a plain askfutures.com view.
  }
}

function post(): void {
  if (!iframeReady || !latest || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage(
    { type: PAGE_MSG.chartContext, payload: latest },
    ASKFUTURES_ORIGIN,
  );
}
