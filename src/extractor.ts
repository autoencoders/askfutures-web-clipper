// Injected into the current tab's isolated world on toolbar click. Content
// scripts run in the page's origin, so YouTube transcript fetches
// (InnerTube/timedtext) are same-origin — exactly obsidian-clipper's
// mechanism. The isolated world matters: the page's CSP (e.g. YouTube's
// Trusted Types enforcement) would break defuddle's DOM work in the MAIN
// world. This bundle only defines window.__askfuturesExtract; the service
// worker calls it with a second, func-based injection into the same world and
// awaits the returned promise.

// defuddle/full: the core entry has no Markdown conversion (markdown option
// is silently ignored there).
import Defuddle from 'defuddle/full';
import type { Clip } from './shared';

const EXTRACT_TIMEOUT_MS = 45_000;

// executeScript does not propagate in-page exceptions to the caller (the
// result is just null), so the promise always resolves to this envelope and
// the service worker unwraps it.
export type ExtractOutcome =
  | { ok: true; clip: Clip }
  | { ok: false; error: string };

declare global {
  interface Window {
    __askfuturesExtract: () => Promise<ExtractOutcome>;
  }
}

window.__askfuturesExtract = async () => {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error('Timed out extracting this page.')),
      EXTRACT_TIMEOUT_MS,
    );
  });
  try {
    const clip = await Promise.race([extract(), timeout]);
    return { ok: true, clip };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Hostname decides the kind: defuddle/full is minified, which mangles the
// constructor names its extractorType field is derived from.
const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be)$/;

async function extract(): Promise<Clip> {
  const result = await new Defuddle(document, {
    url: location.href,
    markdown: true,
  }).parseAsync();

  const kind = YOUTUBE_HOSTS.test(location.hostname) ? 'youtube' : 'article';
  // defuddle's YouTube extractor returns the transcript as a variable; its
  // content field is just the embed + video description.
  const content =
    kind === 'youtube'
      ? (result.variables?.transcript ?? '').trim()
      : (result.content ?? '').trim();
  if (!content) {
    throw new Error(
      kind === 'youtube'
        ? 'No transcript found — the video may not have captions.'
        : 'Nothing readable to clip on this page.',
    );
  }

  return {
    v: 1,
    source_url: canonicalUrl(),
    title: result.title || null,
    author: result.author || null,
    published_at: result.published || null,
    clipped_at: new Date().toISOString(),
    kind,
    content_markdown: content,
  };
}

function canonicalUrl(): string {
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute('href');
  if (canonical) {
    return new URL(canonical, location.href).href;
  }
  return location.href;
}
