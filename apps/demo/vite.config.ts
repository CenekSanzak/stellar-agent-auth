import { defineConfig } from 'vite';

/**
 * The browser app. In development Vite serves it and passes `/v1` and `/indexer` to the demo server; a build goes to `dist/web`,
 * which the demo server serves itself.
 */
export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: 'dist/web', emptyOutDir: true, target: 'es2022', sourcemap: true },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: Object.fromEntries(['/v1', '/indexer'].map((path) => [path, process.env['DEMO_SERVER_URL'] ?? 'http://127.0.0.1:8790'])),
  },
});
