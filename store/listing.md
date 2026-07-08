# Store listing copy — Chrome Web Store + Edge Add-ons

Copy-paste source for both store listings. Keep this file in sync with what is
actually submitted; it is the reviewed record of our listing content.

## Name

AskFutures Clipper

## Summary (short description, ≤132 chars)

Clip the page you're reading — articles or YouTube transcripts — into
askfutures.com to analyze as a trading strategy.

## Category

- Chrome Web Store: Tools
- Edge Add-ons: Productivity

## Detailed description

Turn what you're reading or watching into a testable trading strategy.

Click the AskFutures button on any article or YouTube video. The extension
extracts the readable content — for videos, the transcript — right in your
browser, and opens askfutures.com/analyze with a preview. One more click and
AskFutures turns it into concrete, backtestable trading strategies.

WHY A BROWSER EXTENSION?
YouTube transcripts and many pages can't be fetched by a server on your
behalf. The clipper reads the page exactly as you see it, in your own
browser, with your own access — nothing more.

PRIVATE BY DESIGN
• Reads a page only when you click the button on that page (activeTab) — no
  background access to your browsing, ever.
• Sends the clip only to askfutures.com, inside your browser. The extension
  calls no other servers and holds no accounts or tokens.
• No analytics, no telemetry, no tracking. Open source (MIT):
  https://github.com/autoencoders/askfutures-web-clipper

WHAT IT EXTRACTS
• Articles: clean readable text (powered by the MIT-licensed defuddle
  library, also used by Obsidian Web Clipper).
• YouTube: the video transcript, with chapters and timestamps.

Requires a free askfutures.com account to run the analysis. Clips over 2 MB
are refused.

## Single-purpose statement

This extension has a single purpose: clipping the content of the page the
user is currently reading (article text or YouTube transcript) into
askfutures.com for trading-strategy analysis, on the user's explicit click.

## Permission justifications

- **activeTab** — read the content of the page the user clicked the toolbar
  button on. Access exists only for that tab, only after the click.
- **scripting** — inject the content extractor into that same tab on click,
  and the small in-page status indicator.
- **storage** — buffer the clip in session storage (memory-only) until
  askfutures.com acknowledges receipt, so it survives a slow page load or a
  sign-in redirect.
- **Host permission `https://askfutures.com/*`** — run the handoff content
  script on askfutures.com/analyze that delivers the clip to the page.
- **Remote code:** none. All code ships in the package.

## Data-use disclosures (Chrome "Privacy practices" tab)

- Collects: **Website content** (the page text the user explicitly clips) —
  transferred only to askfutures.com, in the user's browser, to provide the
  extension's single purpose.
- Does NOT collect: personally identifiable information, health, financial or
  payment information, authentication information, personal communications,
  location, web history, user activity.
- Data is not sold, not used for purposes unrelated to the single purpose,
  not used for creditworthiness or lending.

## Privacy policy URL

https://github.com/autoencoders/askfutures-web-clipper/blob/main/PRIVACY.md

(When the askfutures.com clipper landing page ships — CLP-7 — prefer hosting
the policy there and update both listings.)

## Screenshots (1280×800, in `store/screenshots/`)

1. `clip-youtube.png` — clipping a YouTube video, status widget visible.
2. `analyze-preview.png` — the clip preview card on askfutures.com/analyze.
3. `clip-article.png` — clipping an article, success state.

## Icon

`src/icons/icon128.png` (the AskFutures compass mark).
