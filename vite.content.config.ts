import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content scripts are injected as classic scripts, so this build produces one
// self-contained IIFE with every dependency inlined. Runs after the main build.
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/chatgpt/index.ts'),
      formats: ['iife'],
      name: 'ChatBridgeContent',
      fileName: () => 'content/chatgpt.js',
    },
  },
});
