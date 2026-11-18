/**
 * Diagnostic: load any model file into the built app as the object and take
 * pictures of it, including close-ups of its extremities. Headless.
 *
 *   node scripts/view-model.mjs <out-name> <model file>
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const [, , outName, file] = process.argv;
const OUT = 'test-output/real';
mkdirSync(OUT, { recursive: true });
const server = await preview({ preview: { port: 4900 + Math.floor(Math.random() * 300), host: '127.0.0.1' } });
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForSelector('.steps');
  await page.locator('.step-head', { hasText: 'Object' }).click();
  await page.locator('#panel .step.is-open input[type=file]').first().setInputFiles(file);
  await page.waitForFunction(() => window.__handhold.object || window.__handhold.ui.objectError, null, { timeout: 300000 });
  const info = await page.evaluate(() => {
    const hh = window.__handhold;
    if (hh.ui.objectError) return { error: hh.ui.objectError };
    const o = hh.object;
    const s = o.box.getSize(o.box.min.clone());
    const meshes = [];
    const bones = [];
    o.source.traverse((n) => {
      if (n.isMesh) meshes.push({ name: n.name, verts: n.geometry.getAttribute('position').count, skinned: !!n.isSkinnedMesh });
      if (n.isBone) bones.push(n.name);
    });
    return { tris: o.grasp.index.length / 3, size: [s.x, s.y, s.z].map((v) => Number(v.toFixed(3))), meshes, boneCount: bones.length, bones: bones.slice(0, 80) };
  });
  console.log(JSON.stringify(info));
  if (!info.error) {
    await page.waitForTimeout(600);
    await page.locator('#viewport').screenshot({ path: `${OUT}/${outName}-whole.png` });
    // close-ups of the two ends along the widest horizontal axis (where a character's hands usually are)
    for (const side of [-1, 1]) {
      await page.evaluate((side) => {
        const hh = window.__handhold;
        const b = hh.object.box;
        const size = b.getSize(b.min.clone());
        const axis = size.x >= size.z ? 'x' : 'z';
        const c = b.getCenter(b.min.clone());
        const tip = c.clone();
        tip[axis] = side > 0 ? b.max[axis] : b.min[axis];
        // height of the vertices nearest that end
        const P = hh.object.grasp.positions;
        const ai = axis === 'x' ? 0 : 2;
        let sum = 0, n = 0;
        const lim = side > 0 ? b.max[axis] - size[axis] * 0.06 : b.min[axis] + size[axis] * 0.06;
        for (let i = 0; i < P.length; i += 3) {
          if (side > 0 ? P[i + ai] > lim : P[i + ai] < lim) {
            sum += P[i + 1];
            n++;
          }
        }
        if (n) tip.y = sum / n;
        tip[axis] -= side * size[axis] * 0.04;
        const v = hh.viewer;
        const r = size[axis] * 0.09;
        v.controls.target.copy(tip);
        v.camera.position.copy(tip).add({ x: axis === 'x' ? 0 : r * 3.2, y: r * 1.6, z: axis === 'x' ? r * 3.2 : 0 });
        v.camera.near = r / 50;
        v.camera.updateProjectionMatrix();
        v.controls.minDistance = 0;
        v.controls.update();
        v.invalidate();
      }, side);
      await page.waitForTimeout(400);
      await page.locator('#viewport').screenshot({ path: `${OUT}/${outName}-end${side > 0 ? 'B' : 'A'}.png` });
    }
  }
} catch (e) {
  console.log('STOPPED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
