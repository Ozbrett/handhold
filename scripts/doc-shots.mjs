/**
 * Takes the pictures used in the README and docs, with no window opened.
 *
 *   npm run build && node scripts/doc-shots.mjs
 *
 * Writes docs/screenshot.png (a grip on the sample hand) and docs/animations.png
 * (the Animations tab with a pose, an animation and a look on the sample player).
 */
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4181, strictPort: true, host: '127.0.0.1' } });
const base = 'http://127.0.0.1:4181/';
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const H = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, ms = 180000) => page.waitForFunction(fn, null, { timeout: ms, polling: 100 });

  // 1. the sample hand on a hammer, with the grips listed
  await page.goto(`${base}?demo=hammer`);
  await until(() => (window.__handhold?.grasps?.length ?? 0) > 0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'docs/screenshot.png' });
  console.log('docs/screenshot.png');

  // 2. the sample player with one of each kind saved, looking up
  await page.goto(base);
  await page.waitForSelector('[role=tab]');
  await page.getByRole('tab', { name: 'Character' }).click();
  await page.getByRole('button', { name: 'Use the sample player' }).click();
  await until(() => !window.__handhold.ui.handBusy);
  await page.locator('.tab-page .seg button', { hasText: 'Right' }).click();
  await until(() => !window.__handhold.ui.handBusy && !!window.__handhold.hand);
  await page.getByRole('tab', { name: 'Grip' }).click();
  await H(() => window.__handhold.actions.objectSample('hammer'));
  await H(() => window.__handhold.solve());
  await until(() => (window.__handhold.grasps?.length ?? 0) > 0);
  await page.getByRole('tab', { name: 'Animations' }).click();
  await page.locator('[data-key="add-pose"]').click();
  await page.locator('[data-key="item-style-tool"]').click();
  await page.locator('[data-key="motion-use"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-key="clip-play"]').click();
  await page.locator('[data-key="add-look"]').click();
  await page.waitForTimeout(300);
  await H(() => window.__handhold.actions.lookAim(0, 35, true));
  await page.locator('.tab-page h2').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'docs/animations.png' });
  console.log('docs/animations.png');
} finally {
  await browser.close();
  await server.close();
}
