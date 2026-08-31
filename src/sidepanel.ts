// Side panel page script. The panel itself is just an iframe on
// askfutures.com; this script adds the chart-context bridge: on load it asks
// the service worker to scrape the chart in the tab the panel sits next to,
// and posts the snapshot into the iframe. The embedded page can ask for a
// fresh snapshot with askfutures-chart-context-request (e.g. right before the
// user submits a trading idea). Snapshots only — there is no live observation
// of the chart. See SECURITY.md for the message contract.
//
// The snapshot also carries the charting site's own design tokens, which the
// panel applies to its own chrome (applyTheme) before forwarding the whole
// snapshot on. That is as far as the extension can take it: the panel's body
// is a cross-origin iframe on askfutures.com, so nothing here can style it —
// the page has to read theme off the message and style itself. See
// design/tradovate-chart-context.md § "Matching the site's look".
//
// The header's tabs are the panel's only other chrome: they swap the iframe
// between askfutures.com/sessions and the live-trading positions page,
// askfutures.com/trading/reconcile. Both pages own all of their own state and
// API calls — the extension never holds tokens, and there is nothing here
// that knows what a position or a strategy is.

import {
  ASKFUTURES_ORIGIN,
  ChartContext,
  ChartTheme,
  PAGE_MSG,
  RECONCILE_URL,
  RUNTIME_MSG,
  SESSIONS_URL,
  STORAGE_KEY_PANEL_TAB,
} from './shared';

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
    void registerPanelTab();
    void refresh();
  }
});

// Tell the service worker which tab this panel sits next to — the tab tour
// captures navigate. Session storage (trusted contexts only). One global
// slot, so with panels open in several windows at once the most recent to
// bind wins and tour captures target that panel's tab; a message from a
// panel iframe carries no window identity, so the binding can't be
// window-scoped without new plumbing. Known limitation — run one tour at a
// time.
async function registerPanelTab(): Promise<void> {
  if (chartTabId === null) return;
  await chrome.storage.session.set({ [STORAGE_KEY_PANEL_TAB]: chartTabId });
}

// The header tabs swap the iframe between the panel's views. Plain src
// assignment: each view is a fresh document, which is what lets the chart
// bridge below re-post its snapshot on the iframe's load event.
const NAV_VIEWS: Record<string, string> = {
  sessions: SESSIONS_URL,
  reconcile: RECONCILE_URL,
};

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
  button.addEventListener('click', () => {
    const url = NAV_VIEWS[button.dataset.view ?? ''];
    if (!url) return;
    iframeReady = false;
    iframe.src = url;
    for (const other of document.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
      other.classList.toggle('active', other === button);
    }
  });
}

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
  await registerPanelTab();
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
      applyTheme(latest.theme);
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


// Restyle the panel's own chrome — the nav bar, which is all the extension
// renders — to the charting site's tokens, by overwriting the custom
// properties sidepanel.html declares. A missing token leaves that property
// alone, so a site that reports half a theme gets a half-matched panel rather
// than a broken one.
//
// The iframe below the nav is a different origin and cannot be reached from
// here; askfutures.com has to theme itself from the same tokens, which reach
// it in the snapshot this panel forwards.
function applyTheme(theme: ChartTheme | null): void {
  if (!theme) return;
  const root = document.documentElement;
  const set = (property: string, value: string | null | undefined): void => {
    if (value) root.style.setProperty(property, value);
  };
  set('--af-font', theme.fontFamily);
  set('--af-background', theme.color.background);
  // The nav sits on a panel surface, not on the page behind it.
  set('--af-surface', theme.color.surface);
  set('--af-divider', theme.color.divider);
  set('--af-text', theme.color.text);
  set('--af-text-dim', theme.color.textDim ?? theme.color.textMuted);
  set('--af-accent', theme.color.accent);
  set('--af-row-hover', theme.color.rowHover);
  set('--af-tab-height', theme.tab.height);
  set('--af-tab-padding-inline', theme.tab.paddingInline);
  set('--af-tab-radius', theme.tab.borderRadius);
  set('--af-tab-active-bg', theme.tab.activeBackground);
  set('--af-tab-active-text', theme.tab.activeText);
}
