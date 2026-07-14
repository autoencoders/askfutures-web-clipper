// PDF extraction, in an offscreen document. Chrome blocks script injection
// into its PDF viewer and service workers can't lazily import pdf.js, so the
// service worker creates this document per PDF clip (background.ts,
// extractPdfClip), sends the PDF's URL, and closes the document when the
// envelope comes back. The document fetches the bytes itself: MV3 runtime
// messages are JSON — no ArrayBuffer transfer — and the activeTab grant from
// the user's click covers the origin here just as it does in the worker. The
// URL is fetched verbatim so signed URLs (SSRN-style X-Amz-* params) keep
// working; credentials ride along for cookie-gated PDFs.
//
// Scope: text-layer PDFs only. A scanned (image-only) PDF fails with a clear
// message — no OCR.

import {
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
} from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Clip, PdfExtractOutcome, RUNTIME_MSG } from './shared';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

// The whole file is parsed in memory, so bound the download. The 2 MB clip
// limit (MAX_CLIP_BYTES) applies to the extracted text, which is far smaller
// than the file — the service worker enforces it after extraction.
const MAX_PDF_BYTES = 50 * 1024 * 1024;

const FETCH_ERROR =
  "Couldn't download this PDF — try reloading the page and clipping again.";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return;
  }
  if (message?.type !== RUNTIME_MSG.extractPdf || message.target !== 'offscreen') {
    return;
  }
  void extract(String(message.url))
    .then((clip): PdfExtractOutcome => ({ ok: true, clip }))
    .catch(
      (err): PdfExtractOutcome => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .then(sendResponse);
  return true; // async sendResponse above
});

async function extract(url: string): Promise<Clip> {
  const bytes = await download(url);
  const task = getDocument({ data: bytes });
  try {
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (err) {
      if (err instanceof PasswordException) {
        throw new Error("This PDF is password-protected — it can't be clipped.");
      }
      if (err instanceof InvalidPDFException) {
        throw new Error("This file isn't a readable PDF.");
      }
      throw err;
    }
    const [text, meta] = await Promise.all([
      textOf(doc),
      doc.getMetadata().catch(() => null),
    ]);
    if (!text) {
      throw new Error(
        "This PDF has no selectable text — scanned documents aren't supported.",
      );
    }
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    return {
      v: 1,
      source_url: cleanSourceUrl(url),
      title: stringField(info.Title) ?? xmpTitle(meta?.metadata) ?? filenameTitle(url),
      author: stringField(info.Author),
      published_at: pdfDateToIso(info.CreationDate),
      clipped_at: new Date().toISOString(),
      kind: 'pdf',
      content_markdown: text,
      site_name: hostnameOf(url),
      // A PDF tab has no page chrome: no favicon links, theme-color, or
      // og:image to forward.
      favicon: null,
      theme_color: null,
      thumbnail_url: null,
    };
  } finally {
    // Tears down the document and its worker; on the task, not the document
    // proxy, so a parse failure above still cleans up.
    await task.destroy();
  }
}

async function download(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error(FETCH_ERROR);
  }
  if (!res.ok || !res.body) {
    throw new Error(FETCH_ERROR);
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_PDF_BYTES) {
    throw oversizeError(declared);
  }
  // content-length can lie (or be absent), so count while streaming too.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PDF_BYTES) {
      void reader.cancel().catch(() => {});
      throw oversizeError(total);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function oversizeError(bytes: number): Error {
  const mb = (bytes / (1024 * 1024)).toFixed(0);
  return new Error(`This PDF is ${mb} MB — over the 50 MB limit.`);
}

// The text layer, page by page in document order. hasEOL marks line breaks; a
// blank line separates pages. pdf.js only emits the space glyphs a PDF
// actually encodes, so words positioned by kerning/offset (common in
// typeset papers) arrive as adjacent items with no space between them — a
// same-line horizontal gap bridges those with a space so words don't merge.
// Plain text is fine as content_markdown; layout fidelity (tables, equations)
// is explicitly not a goal.
async function textOf(doc: PDFDocumentProxy): Promise<string> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    let prevEndX: number | null = null;
    let prevY: number | null = null;
    for (const item of content.items) {
      if (!('str' in item)) continue; // TextMarkedContent carries no text
      const x = item.transform[4];
      const y = item.transform[5];
      const sameLine = prevY !== null && Math.abs(y - prevY) <= item.height * 0.5;
      if (
        text &&
        !/\s$/.test(text) &&
        !/^\s/.test(item.str) &&
        sameLine &&
        prevEndX !== null &&
        x - prevEndX > item.height * 0.25
      ) {
        text += ' ';
      }
      text += item.str;
      if (item.hasEOL) text += '\n';
      prevEndX = x + item.width;
      prevY = y;
    }
    page.cleanup();
    const cleaned = text.replace(/[ \t]+\n/g, '\n').trim();
    if (cleaned) pages.push(cleaned);
  }
  return pages.join('\n\n').trim();
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// XMP dc:title, the fallback when the Info dictionary has no Title. The
// metadata object is pdf.js's Metadata wrapper; get() returns unknown shapes
// for other keys, but dc:title is a string when present.
function xmpTitle(metadata: unknown): string | null {
  if (!metadata || typeof (metadata as { get?: unknown }).get !== 'function') {
    return null;
  }
  try {
    return stringField((metadata as { get(name: string): unknown }).get('dc:title'));
  } catch {
    return null;
  }
}

function filenameTitle(url: string): string | null {
  try {
    const name = decodeURIComponent(
      new URL(url).pathname.split('/').pop() ?? '',
    );
    return stringField(name.replace(/\.pdf$/i, ''));
  } catch {
    return null;
  }
}

// A PDF date ("D:20030213131500+01'00'") → ISO-8601, or null when the field
// is missing or malformed. Everything after the year is optional in the spec.
function pdfDateToIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Z])(?:(\d{2})'?(\d{2})?'?)?)?/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tzSign, tzH, tzM = '00'] = m;
  const tz =
    !tzSign || tzSign === 'Z' || !tzH ? 'Z' : `${tzSign}${tzH}:${tzM}`;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// The clip's permanent source reference. Volatile signing params (SSRN-style
// S3 X-Amz-* and response-content-disposition) expire in minutes and bloat
// the URL, so they are stripped; anything else (e.g. abstractId) is kept.
function cleanSourceUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^x-amz-/i.test(key) || key.toLowerCase() === 'response-content-disposition') {
        u.searchParams.delete(key);
      }
    }
    return u.href;
  } catch {
    return url;
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
