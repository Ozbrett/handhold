import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Optional, untracked file listing extra folders the dev server may serve
// models from, so ?hand=/@fs/<path> links work on your own machine:
//   { "allowDirs": ["D:/Models"] }
let allowDirs: string[] = [];
if (existsSync('handhold.local.json')) {
  try {
    allowDirs = JSON.parse(readFileSync('handhold.local.json', 'utf8')).allowDirs ?? [];
  } catch {
    allowDirs = [];
  }
}

// Relative base so the built site works from any GitHub Pages path
// (https://<user>.github.io/<repo>/) without configuration.
export default defineConfig({
  base: './',
  server: {
    fs: { allow: ['.', ...allowDirs] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
});
