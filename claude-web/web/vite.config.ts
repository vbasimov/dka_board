import { defineConfig } from 'vite';

/**
 * The SPA lives under `/claude/` and must never emit absolute root-relative
 * URLs: every asset, the manifest link and the API base all derive from `base`.
 *
 * JSX is compiled by esbuild itself (`jsx: automatic` + `preact/jsx-runtime`),
 * so no Preact plugin is needed in the build.
 */
export default defineConfig({
  base: '/claude/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  server: {
    // Local development only; production serves web/dist behind Caddy.
    port: 5173,
    strictPort: true,
  },
});
