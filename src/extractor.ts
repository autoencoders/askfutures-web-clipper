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
    site_name: siteName(),
    favicon: faviconUrl(),
    theme_color: themeColor(),
    thumbnail_url: thumbnailUrl(),
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

// Human-readable site name for the "Captured from …" label; falls back to the
// bare hostname (minus a leading www.).
function siteName(): string | null {
  const meta =
    metaContent('meta[property="og:site_name"]') ??
    metaContent('meta[name="application-name"]');
  if (meta) {
    return meta;
  }
  return location.hostname.replace(/^www\./, '') || null;
}

// Best site icon for coloring the preview. Prefer the largest declared
// <link rel="icon"|"apple-touch-icon"> (SVG and Apple touch icons tend to be
// the richest), then fall back to the well-known /favicon.ico. Always an
// absolute URL, or null if none resolves.
function faviconUrl(): string | null {
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>(
      'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
    ),
  );
  let best: { href: string; score: number } | null = null;
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    let abs: string;
    try {
      abs = new URL(href, location.href).href;
    } catch {
      continue;
    }
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const type = (link.getAttribute('type') ?? '').toLowerCase();
    let score = maxIconSize(link.getAttribute('sizes'));
    if (type.includes('svg') || abs.toLowerCase().endsWith('.svg')) score = 1024;
    if (rel.includes('apple-touch-icon')) score += 32; // usually opaque + colorful
    if (!best || score > best.score) best = { href: abs, score };
  }
  if (best) {
    return best.href;
  }
  try {
    return new URL('/favicon.ico', location.origin).href;
  } catch {
    return null;
  }
}

// "32x32", "any", "16x16 32x32" → the largest edge, or 16 when unparseable.
function maxIconSize(sizes: string | null): number {
  if (!sizes) return 16;
  if (/\bany\b/i.test(sizes)) return 512;
  let max = 0;
  for (const token of sizes.split(/\s+/)) {
    const dim = /^(\d+)x(\d+)$/i.exec(token);
    if (dim) max = Math.max(max, Number(dim[1]), Number(dim[2]));
  }
  return max || 16;
}

// The page's declared brand color (<meta name="theme-color">), validated as a
// real CSS color so we never forward junk. Honors a media-scoped tag matching
// the current color scheme when several are present.
function themeColor(): string | null {
  const tags = Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  );
  let fallback: string | null = null;
  for (const tag of tags) {
    const value = tag.getAttribute('content')?.trim();
    if (!value || !isColor(value)) continue;
    const media = tag.getAttribute('media');
    if (!media) {
      fallback ??= value;
    } else if (window.matchMedia(media).matches) {
      return value;
    }
  }
  return fallback;
}

function isColor(value: string): boolean {
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', value);
  }
  return /^#[0-9a-f]{3,8}$|^(rgb|hsl)a?\(/i.test(value);
}

// The page's lead image for the /analyze preview: og:image (or a twitter:image
// fallback), resolved to an absolute URL. For an article this is the only image
// the server gets; a YouTube thumbnail is also derivable server-side from the
// video id. Null if the page declares none or the URL won't resolve.
function thumbnailUrl(): string | null {
  const src =
    metaContent('meta[property="og:image"]') ??
    metaContent('meta[property="og:image:url"]') ??
    metaContent('meta[name="twitter:image"]') ??
    metaContent('meta[name="twitter:image:src"]');
  if (!src) return null;
  try {
    return new URL(src, location.href).href;
  } catch {
    return null;
  }
}

function metaContent(selector: string): string | null {
  const value = document
    .querySelector<HTMLMetaElement>(selector)
    ?.getAttribute('content')
    ?.trim();
  return value || null;
}
