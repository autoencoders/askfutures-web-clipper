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

await esbuild.build({
  ...common,
  entryPoints: ['src/background.ts', 'src/handoff.ts'],
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

cpSync('src/manifest.json', 'dist/manifest.json');
cpSync('src/icons', 'dist/icons', { recursive: true });
