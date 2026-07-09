# Privacy Policy — AskFutures Clipper

*Effective 2026-07-08. This policy lives in the extension's open-source
repository; any change to it is visible in the
[commit history](https://github.com/autoencoders/askfutures-web-clipper/commits/main/PRIVACY.md).*

## What the extension does

AskFutures Clipper does one thing: when you click its toolbar button, it reads
the page you are looking at, extracts the readable content (article text, or
the transcript of a YouTube video), and hands that content to
[askfutures.com](https://askfutures.com) so you can analyze it as a trading
strategy.

## What data is processed, and when

- **Page content is read only when you click the toolbar button**, only from
  the tab you clicked on (the `activeTab` permission). The extension has no
  access to your browsing otherwise, on any site, at any time.
- The extracted clip (page text or transcript, title, author, publication
  date, page URL, clip timestamp, and the site's name, icon URL, theme
  color, and lead image for the preview) is held temporarily in the browser's
  session storage — in memory, never written to disk — and delivered to the
  askfutures.com page in your browser. It is deleted from the extension as
  soon as askfutures.com confirms receipt, and in any case when the browser
  exits.
- **The clip is sent only to askfutures.com**, and only inside your browser
  (via `window.postMessage` to the askfutures.com page). The extension itself
  makes no network calls to any server of ours — extraction happens entirely
  in the page.

## What the extension does NOT do

- No analytics, telemetry, or usage tracking of any kind.
- No collection of personal information, browsing history, or credentials.
- No data is sold or shared with any third party.
- No accounts, tokens, or secrets — the extension never authenticates;
  what happens after the clip reaches askfutures.com is governed by the
  askfutures.com terms and privacy policy.
- No remote code: everything the extension runs ships in the reviewed
  package.

## Questions

Open an issue on the
[repository](https://github.com/autoencoders/askfutures-web-clipper) or email
security@askfutures.com.
