// Client bundling only. Bun serves the HTML and the API; Vite owns the browser
// modules under client/ so dev gets HMR while production ships static files
// from public/dist/ (served at /static/dist/).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const entry = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// The page is served from 127.0.0.1:<4711+>, so dev modules are cross-origin.
// Allow loopback origins only — never a wildcard.
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export const DEV_PORT = 5173;

export default defineConfig({
  root,
  // No index.html: Bun renders the page, Vite only serves/builds modules.
  appType: 'custom',
  base: '/static/dist/',
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    cors: { origin: LOOPBACK_ORIGIN },
    origin: `http://127.0.0.1:${DEV_PORT}`,
  },
  build: {
    outDir: 'public/dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        review: entry('client/review.ts'),
        comments: entry('client/comments.ts'),
      },
      output: {
        // Stable entry names so the page can reference them without a manifest.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
