import { defineConfig } from '@playwright/test';

// Extensions need a persistent context, which each test creates itself
// (see tests/integration/extension.spec.ts). Run `npm run build` first.
export default defineConfig({
  testDir: 'tests/integration',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
