import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // The browser demo bundles the desk itself; keep the language-model SDK out of it.
  resolve: { alias: [{ find: /^.*\/llm\/client$/, replacement: fileURLToPath(new URL('./web/src/llmStub.ts', import.meta.url)) }] },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': target, '/ws': { target, ws: true } },
  },
});
