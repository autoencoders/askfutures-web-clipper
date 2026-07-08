# Security

## The postMessage contract

The extension hands clips to `https://askfutures.com/analyze` over
`window.postMessage` in the page's window. This is the complete contract; the
`/analyze` page implements the other half.

Message flow (all messages posted to the same window):

```
page       → { type: "askfutures-analyze-ready", nonce: "<uuid>" }
extension  → { type: "askfutures-clip", nonce: "<echoed>", clip: { …payload } }
page       → { type: "askfutures-clip-ack", nonce: "<echoed>" }
```

Plus one optional kick-off message:

```
extension  → { type: "askfutures-clip-query" }
```

Rules:

- **Origin-checked both ways.** Each side ignores any message where
  `event.origin` is not `https://askfutures.com` or `event.source` is not the
  page's own `window`.
- **Nonce.** The page generates a fresh nonce in every
  `askfutures-analyze-ready` announcement. The extension echoes it in
  `askfutures-clip`, and only accepts an `askfutures-clip-ack` carrying the
  same nonce. The page ignores clips whose nonce it did not issue.
- **Announce and re-announce.** The page posts `askfutures-analyze-ready` when
  it is ready to receive, and re-announces (with a fresh nonce) whenever it
  receives `askfutures-clip-query`. The extension sends that query only when it
  actually has a clip buffered, covering whichever side loads last.
- **Buffering.** The clip lives in `chrome.storage.session` (memory-backed,
  never written to disk, cleared on browser exit) until a valid ack arrives.
  A sign-in redirect or slow load on the askfutures side just restarts the
  handshake; the user never has to re-clip.
- **Nothing in URLs.** The payload never touches a URL, query string, browser
  history, or any third party.

### Clip payload (v1)

```jsonc
{
  "v": 1,
  "source_url": "https://www.youtube.com/watch?v=…",  // canonical page URL
  "title": "…",                       // nullable
  "author": "…",                      // nullable
  "published_at": "…",                // nullable, as found on the page
  "clipped_at": "2026-07-08T14:05:00Z", // ISO-8601 UTC, extension clock
  "kind": "youtube" | "article",
  "content_markdown": "…"             // extracted content; transcripts as text
}
```

The extension refuses payloads over 2 MB.

## Trust model

- **The page trusts nothing.** Anything on the web can postMessage at
  `/analyze`; origin checks raise the bar but are not the gate. The page treats
  every received payload as untrusted user input, renders a preview (title,
  source URL, kind, size, excerpt), and analyzes only after the user explicitly
  confirms. It never silently injects clip content anywhere.
- **The extension holds no secrets.** It never authenticates — the
  askfutures.com session in the browser is the only auth. There are no tokens,
  keys, or accounts in the extension or this repository.
- **Minimal reach.** `activeTab` means the extension can read a page only in
  direct response to the user's click on that page; there are no broad host
  permissions and no background browsing access. The one host permission
  (`https://askfutures.com/*`) exists solely to inject the handoff content
  script above.
- **No remote code.** All code, including the bundled defuddle library, ships
  in the package. The extension fetches no code at runtime and sends no
  telemetry.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or email
security@askfutures.com. Please do not file public issues for vulnerabilities.
