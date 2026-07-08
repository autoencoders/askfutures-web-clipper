# Security

## The postMessage contract

The extension hands clips to `https://askfutures.com/analyze` over
`window.postMessage` in the page's window. This is the complete contract; the
`/analyze` page implements the other half.

Message flow (all messages posted to the same window):

```
page       → { type: "askfutures-analyze-ready" }
extension  → { type: "askfutures-clip", nonce: "<uuid>", payload: { … } }
page       → { type: "askfutures-clip-ack", nonce: "<echoed>" }
```

Rules:

- **Origin-checked both ways.** Each side ignores any message where
  `event.origin` is not `https://askfutures.com` or `event.source` is not the
  page's own `window`.
- **Announce and re-announce.** The page posts `askfutures-analyze-ready` when
  its listener is ready and repeats it every second until a clip lands. The
  extension delivers whenever an announcement arrives while a clip is
  buffered, so whichever side loads last, the handshake still completes.
- **Nonce.** The extension generates a fresh nonce for every clip message. The
  page acks every clip it accepts by echoing that nonce, and the extension
  clears its buffer only on an ack whose nonce it actually sent — a forged or
  stale ack cannot discard an undelivered clip.
- **Validation.** The page validates every payload field strictly and ignores
  anything malformed (it never throws at the sender).
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
