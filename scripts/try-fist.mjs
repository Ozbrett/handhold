/**
 * Diagnostic: load a hand, curl every finger most of the way closed and take
 * pictures from the palm side, the back and the thumb side. Shows at a glance
 * whether the palm side and the joints were found correctly.
 *
 *   node scripts/try-fist.mjs <out-name> <hand file> [curl 0..1] [flip]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const [, , outName, handPath, curlArg, flipArg] = process.argv;
const curl = Number(curlArg ?? 0.6);
const OUT = 'test-output/real';
mkdirSync(OUT, { recursive: true });
const server = await preview({ preview: { port: 4600 + Math.floor(Math.random() * 300), host: '127.0.0.1' } });
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 760 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForSelector('.steps');
  await page.locator('#panel .step.is-open input[type=file]').first().setInputFiles(handPath);
  const ready = () => {
    const hh = window.__handhold;
    return !hh.ui.handBusy && (hh.hand || hh.ui.handError || hh.ui.handChoice);
  };
  await page.waitForFunction(ready, null, { timeout: 300000 });
  if (await page.evaluate(() => !!window.__handhold.ui.handChoice)) {
    const pick = process.env.HAND_PICK ?? '0';
    const byKey = page.locator(`[data-key="pick-${pick}"]`);
    if (await byKey.count()) await byKey.first().click();
    else await page.locator('#panel [data-key^="pick-"]').nth(Number(pick) || 0).click();
    await page.waitForFunction(() => !window.__handhold.ui.handBusy && (window.__handhold.hand || window.__handhold.ui.handError), null, { timeout: 300000 });
  }
  if (flipArg === 'flip') {
    await page.getByRole('button', { name: 'Flip palm side' }).click();
    await page.waitForFunction(() => window.__handhold.hand?.flip === true && !window.__handhold.ui.handBusy, null, { timeout: 300000 });
  }
  const err = await page.evaluate(() => window.__handhold.ui.handError);
  if (err) throw new Error(err);
  const shots = [
    ['palm', 1, 0.15, 0],
    ['back', -1, 0.15, 0],
    ['thumbside', 0, 0.1, 1],
  ];
  for (const pose of ['rest', 'curled']) {
    for (const [name, n, u, s] of shots) {
      await page.evaluate(
        ({ pose, n, u, s, curl }) => {
          const hh = window.__handhold;
          const m = hh.hand.rig.model;
          const angles = new Float32Array(m.dofCount);
          if (pose === 'curled')
            for (const j of m.joints) j.dofs.forEach((d, k) => (angles[j.dofStart + k] = d.kind === 'flex' ? d.open + (d.closed - d.open) * curl : 0));
          const wrist = hh.viewer.currentPose().wrist;
          hh.viewer.setPose({ wrist, angles }, 0);
          const f = m.frame;
          const c = hh.viewer.contentBox().getCenter(f.origin.clone());
          const dir = f.normal.clone().multiplyScalar(n).addScaledVector(f.up, u).addScaledVector(f.side, s).normalize();
          const v = hh.viewer;
          v.camera.up.copy(f.up);
          v.controls.target.copy(c);
          v.camera.position.copy(c).addScaledVector(dir, m.size * 3.4);
          v.camera.near = m.size / 50;
          v.camera.far = m.size * 50;
          v.camera.updateProjectionMatrix();
          v.controls.update();
          v.invalidate();
        },
        { pose, n, u, s, curl },
      );
      await page.waitForTimeout(350);
      await page.locator('#viewport').screenshot({ path: `${OUT}/${outName}-${pose}-${name}.png` });
    }
  }
  const info = await page.evaluate(() => {
    const h = window.__handhold.hand.rig;
    return { handed: h.model.handedness, conf: h.analysis.palmConfidence, warnings: h.analysis.warnings };
  });
  console.log(JSON.stringify(info));
} catch (e) {
  console.log('STOPPED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
