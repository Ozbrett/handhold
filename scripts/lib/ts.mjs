/**
 * Loads one of Handhold's TypeScript modules into a plain Node script through Vite's module runner, so the command-line checks
 * run the same code as the site and the tests without a build step.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

export const root = resolve(fileURLToPath(import.meta.url), '../../..');

export async function importTs(path) {
  const { module } = await runnerImport(resolve(root, path), { root, configFile: false, logLevel: 'error' });
  return module;
}
