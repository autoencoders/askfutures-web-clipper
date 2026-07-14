// Reproducible build: `npm ci && npm run build` produces an identical dist/
// from the committed sources and lockfile. No minification — reviewers (and
// Firefox AMO later) can read the output.

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const common = {
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  outdir: 'dist',
  sourcemap: false,
  legalComments: 'inline',
};

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');

// gocharting.js is injected via chrome.scripting like the extractor below; it
// only defines window.__askfuturesChartScrape (no dependencies, so no banner).
await esbuild.build({
  ...common,
  entryPoints: [
    'src/background.ts',
    'src/handoff.ts',
    'src/sidepanel.ts',
    'src/gocharting.ts',
  ],
});

// The extractor runs in the page's MAIN world via chrome.scripting. It only
// defines window.__askfuturesExtract; the service worker invokes it with a
// second, func-based injection.
await esbuild.build({
  ...common,
  entryPoints: ['src/extractor.ts'],
  banner: {
    js: '/*! askfutures-clipper extractor — bundles defuddle (MIT, https://github.com/kepano/defuddle) */',
  },
});

// The PDF extractor runs in an offscreen document (Chrome blocks injection
// into its PDF viewer, and the service worker can't lazily import pdf.js).
// ESM, not iife: pdf.js uses top-level await; offscreen.html loads the bundle
// with <script type="module">. The worker file is upstream's own artifact,
// copied verbatim so it stays byte-verifiable against the pinned npm package.
await esbuild.build({
  ...common,
  format: 'esm',
  entryPoints: ['src/offscreen.ts'],
  banner: {
    js: '/*! askfutures-clipper pdf extractor — bundles pdf.js (Apache-2.0, https://github.com/mozilla/pdf.js) */',
  },
});

cpSync('src/manifest.json', 'dist/manifest.json');
cpSync('src/sidepanel.html', 'dist/sidepanel.html');
cpSync('src/offscreen.html', 'dist/offscreen.html');
cpSync(
  'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  'dist/pdf.worker.min.mjs',
);
cpSync('src/icons', 'dist/icons', { recursive: true });
