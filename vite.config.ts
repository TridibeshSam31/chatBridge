import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;

/** Emits manifest.json into dist, stamping the version from package.json. */
function manifest(): Plugin {
  return {
    name: 'chatbridge-manifest',
    generateBundle() {
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      const source = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify({ ...source, version: pkg.version }, null, 2),
      });
    },
  };
}

// Extension pages and the service worker. The content script is built separately
// (vite.content.config.ts) because content scripts cannot be ES modules.
export default defineConfig({
  plugins: [react(), manifest()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: { polyfill: false },
    sourcemap: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(root, 'sidepanel.html'),
        background: resolve(root, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
