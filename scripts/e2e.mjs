/**
 * End-to-end check of the built site in a headless browser (no window is opened).
 * Loads the samples, solves grips, clicks a grip point, exports a GLB and
 * validates it, and saves screenshots to test-output/.
 *
 *   npm run build && node scripts/e2e.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const OUT = 'test-output';
mkdirSync(OUT, { recursive: true });
const server = await preview({ preview: { port: 4179, strictPort: true, host: '127.0.0.1' } });
const base = 'http://127.0.0.1:4179/';
const channel = process.env.E2E_CHANNEL ?? 'msedge';
const browser = await chromium.launch({
  channel,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const problems = [];
let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed = true;
};

try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  // --- empty state
  await page.goto(base);
  await page.waitForSelector('.steps');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/01-empty.png` });
  check((await page.locator('.step.is-open .step-title').innerText()) === 'Hand', 'starts on the Hand step');

  // --- sample hand through the real buttons
  await page.getByRole('button', { name: 'Use the sample hand' }).click();
  await page.waitForFunction(() => window.__handhold.hand, null, { timeout: 60000 });
  const handInfo = await page.evaluate(() => {
    const h = window.__handhold.hand.rig;
    return { fingers: h.model.fingers.map((f) => f.name), handed: h.model.handedness, bones: h.bones.length, warnings: h.analysis.warnings };
  });
  check(handInfo.fingers.length === 5 && handInfo.handed === 'right', 'sample hand is auto-rigged', JSON.stringify(handInfo));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/02-hand.png` });

  // --- bone editing: move a joint, see the skin refitted, put it back
  await page.locator('.step-head', { hasText: 'Hand' }).click();
  await page.locator('[data-key="edit-bones"]').click();
  await page.waitForTimeout(500);
  const dotAt = await page.evaluate(() => {
    const hh = window.__handhold, m = hh.hand.rig.model;
    const j = m.fingers[1].joints[1];
    return { ...hh.viewer.toScreen(m.joints[j].position), j };
  });
  await page.mouse.click(dotAt.x, dotAt.y);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/02b-edit-bones.png` });
  const edit = await page.evaluate((j) => {
    const hh = window.__handhold, m = hh.hand.rig.model;
    const before = m.joints[j].position.clone();
    hh.moveJoint(j, before.clone().addScaledVector(m.frame.up, 0.05 * m.size));
    const after = hh.hand.rig.model.joints[j].position;
    return { moved: after.distanceTo(before) / m.size, edited: hh.ui.edited, error: hh.ui.handError };
  }, dotAt.j);
  check(edit.moved > 0.04 && edit.edited && !edit.error, 'a joint can be moved and the rig is fitted again', JSON.stringify(edit));
  await page.evaluate(() => window.__handhold.actions.setCurl(0.8));
  await page.locator('#view-toggles [data-view="weights"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/02c-curl-weights.png` });
  await page.locator('#view-toggles [data-view="weights"]').click();
  await page.evaluate(() => window.__handhold.actions.setCurl(0));
  await page.locator('[data-key="bones-reset"]').click();
  check(await page.evaluate(() => window.__handhold.ui.edited === false), 'bone edits can be undone');
  await page.locator('[data-key="bones-done"]').click();
  await page.locator('#view-toggles [data-view="bones"]').click();
  await page.locator('.step-head', { hasText: 'Object' }).click();

  // bones + fit overlays
  await page.getByRole('button', { name: 'Bones' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/03-bones.png` });
  await page.getByRole('button', { name: 'Bones' }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/04-fit.png` });
  await page.getByRole('button', { name: 'Fit', exact: true }).click();

  // --- sample object, then find grips with the real button
  await page.getByRole('button', { name: 'Stick' }).click();
  await page.waitForFunction(() => window.__handhold.object);
  check((await page.locator('.step.is-open .step-title').innerText()) === 'Find grips', 'sample object comes with a grip point and opens Find grips');
  await page.screenshot({ path: `${OUT}/05-object.png` });
  const t0 = Date.now();
  await page.locator('[data-key="find"]').click();
  await page.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
  const solveMs = Date.now() - t0;
  const grips = await page.evaluate(() =>
    window.__handhold.grasps.map((g) => ({
      stable: g.stable,
      effort: g.effort,
      fingers: g.fingersTouching,
      contacts: g.contacts.length,
      segments: g.segmentsTouching,
      of: g.segmentsTotal,
    })),
  );
  check(grips.length > 0 && grips[0].stable, `stick: found ${grips.length} grips in ${solveMs} ms`, JSON.stringify(grips[0]));
  check(grips[0].segments >= 0.7 * grips[0].of, 'the fingers lie along the stick, not just on their tips', `${grips[0].segments} of ${grips[0].of} finger segments touching`);
  check((await page.locator('.grip').first().innerText()).includes('finger segments'), 'each grip says how much of the fingers is touching');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/06-stick-grip.png` });

  // second grip from the list
  if (grips.length > 1) {
    await page.locator('.grip').nth(1).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/07-stick-grip-2.png` });
    await page.locator('.grip').nth(0).click();
    await page.waitForTimeout(600);
  }

  // --- export
  await page.getByRole('button', { name: 'Export this grip' }).click();
  await page.screenshot({ path: `${OUT}/08-export.png` });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('[data-key="dl-glb"]').click()]);
  const glbPath = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(glbPath);
  const glb = readFileSync(glbPath);
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  writeFileSync(`${OUT}/export.gltf.json`, JSON.stringify(gltf, null, 1));
  const skin = gltf.skins?.[0];
  const anim = gltf.animations?.[0];
  check(glb.readUInt32LE(0) === 0x46546c67, 'export is a valid GLB container', `${glb.length} bytes`);
  check(!!skin && skin.joints.length === handInfo.bones, 'export has the skeleton', `${skin?.joints.length} joints`);
  check(gltf.meshes.length >= 2, 'export includes the hand and the object', `${gltf.meshes.length} meshes`);
  check(!!anim && anim.name === 'Grip' && anim.channels.length === handInfo.bones - 1, 'export has the Grip animation', `${anim?.channels.length} channels`);
  const prim = gltf.meshes[gltf.nodes.find((n) => n.skin !== undefined).mesh].primitives[0];
  check(prim.attributes.JOINTS_0 !== undefined && prim.attributes.WEIGHTS_0 !== undefined, 'hand mesh carries skin weights');

  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('[data-key="dl-json"]').click()]);
  await dl2.saveAs(`${OUT}/${dl2.suggestedFilename()}`);
  const pose = JSON.parse(readFileSync(`${OUT}/${dl2.suggestedFilename()}`, 'utf8'));
  check(
    pose.format === 'handhold-pose' && pose.bones.length === handInfo.bones - 1 && pose.restPoints.length === handInfo.bones && pose.bones.every((b) => b.delta.length === 4),
    'pose JSON lists every finger bone, its turn from rest, and where the bones are at rest',
  );

  // --- one download per program
  for (const [engine, ending, inside, title] of [
    ['unity', '.unitypackage', 'Assets/Handhold/HandholdGrip.cs', 'In Unity'],
    ['godot', '-godot.zip', 'handhold/handhold_grip.gd', 'In Godot'],
    ['blender', '-blender.zip', 'README.txt', 'In Blender'],
  ]) {
    const [pk] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator(`[data-key="export-${engine}"]`).click()]);
    await pk.saveAs(`${OUT}/${pk.suggestedFilename()}`);
    const files = await page.evaluate(() => window.__handhold.lastPackage.files);
    const size = readFileSync(`${OUT}/${pk.suggestedFilename()}`).length;
    const shown = await page.locator('.howto h3').innerText();
    check(
      pk.suggestedFilename().endsWith(ending) && files.includes(inside) && files.some((f) => f.endsWith('.pose.json') || f.endsWith('.py')) && size > 2000 && shown === title,
      `export for ${engine} downloads one file with everything in it`,
      `${pk.suggestedFilename()}, ${size} bytes: ${files.join(', ')}`,
    );
  }
  await page.screenshot({ path: `${OUT}/08b-export-engines.png` });

  // --- round trip: the exported file must load back in (here, as an object)
  await page.locator('.step-head', { hasText: 'Object' }).click();
  await page.locator('#panel .step.is-open input[type=file]').first().setInputFiles(glbPath);
  await page.waitForFunction((n) => window.__handhold.object?.name === n, dl.suggestedFilename().replace(/\.glb$/, ''), { timeout: 30000 });
  check((await page.evaluate(() => window.__handhold.ui.objectError)) === null, 'the exported GLB loads back in');

  // --- object controls: resize, turn, and the "swung around" mode
  await page.evaluate(() => window.__handhold.actions.objectSample('hammer'));
  const ratio0 = await page.evaluate(() => window.__handhold.ui.object.ratio);
  await page.evaluate(() => window.__handhold.actions.objectScale(0.2));
  const ratio1 = await page.evaluate(() => window.__handhold.ui.object.ratio);
  check(Math.abs(ratio1 / ratio0 - Math.pow(10, 0.2)) < 0.01, 'size slider rescales the object', `${ratio0.toFixed(2)} -> ${ratio1.toFixed(2)}`);
  await page.evaluate(() => window.__handhold.actions.objectTurn('x'));
  check(await page.evaluate(() => window.__handhold.ui.grip === false), 'turning the object clears the grip point');
  await page.evaluate(() => {
    const hh = window.__handhold;
    hh.actions.objectSample('hammer');
    hh.actions.setMode('any');
  });
  await page.locator('[data-key="find"]').click();
  await page.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
  const swung = await page.evaluate(() => window.__handhold.grasps.map((g) => g.stable));
  check(swung.length > 0 && swung[0] === true, 'hammer can be held for swinging (any direction)', JSON.stringify(swung));
  await page.evaluate(() => window.__handhold.actions.setMode('fixed'));

  // --- flip palm side
  await page.locator('.step-head', { hasText: 'Hand' }).click();
  await page.getByRole('button', { name: 'Flip palm side' }).click();
  await page.waitForFunction(() => window.__handhold.hand?.flip === true && !window.__handhold.ui.handBusy, null, { timeout: 60000 });
  check(await page.evaluate(() => window.__handhold.hand.rig.model.handedness === 'left'), 'flipping the palm side swaps left and right');
  await page.getByRole('button', { name: 'Flip palm side' }).click();
  await page.waitForFunction(() => window.__handhold.hand?.flip === false && !window.__handhold.ui.handBusy, null, { timeout: 60000 });

  // --- every other sample object
  for (const id of ['box', 'ball', 'mug', 'hammer']) {
    await page.evaluate((id) => window.__handhold.actions.objectSample(id), id);
    await page.locator('[data-key="find"]').click();
    await page.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
    const g = await page.evaluate(() => {
      const g = window.__handhold.grasps[0];
      return g ? { stable: g.stable, effort: Number(g.effort.toFixed(2)), fingers: g.fingersTouching, n: window.__handhold.grasps.length } : null;
    });
    check(!!g && g.stable, `${id}: best grip holds`, JSON.stringify(g));
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/10-${id}.png` });
  }

  // --- pick a new grip point by clicking the object in the 3D view
  await page.locator('.step-head', { hasText: 'Grip point' }).click();
  const before = await page.evaluate(() => window.__handhold.ui.grip);
  const target = await page.evaluate(() => {
    const hh = window.__handhold;
    const c = hh.object.box.getCenter(hh.object.box.min.clone());
    c.y -= 0.05; // somewhere down the hammer's handle
    return hh.viewer.toScreen(c);
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);
  const picked = await page.evaluate(() => ({ grip: window.__handhold.ui.grip, grasps: window.__handhold.grasps }));
  check(picked.grip === true && picked.grasps === null, 'clicking the object sets a new grip point and clears old grips', `before=${before}`);
  await page.screenshot({ path: `${OUT}/11-picked.png` });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('[data-key="find"]').click();
  await page.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/12-hammer-picked-grip.png` });
  check(await page.evaluate(() => window.__handhold.grasps.length > 0), 'grips found at the clicked point');

  // --- a real hand mesh dropped in as a file (skeleton ignored, re-rigged)
  const realHand = 'node_modules/@webxr-input-profiles/assets/dist/profiles/generic-hand/left.glb';
  await page.locator('.step-head', { hasText: 'Hand' }).click();
  await page.locator('#panel input[type=file]').first().setInputFiles(realHand);
  await page.waitForFunction(() => window.__handhold.hand?.name === 'left' && !window.__handhold.ui.handBusy, null, { timeout: 60000 });
  const real = await page.evaluate(() => {
    const h = window.__handhold.hand.rig;
    return { fingers: h.model.fingers.map((f) => f.name), handed: h.model.handedness, error: window.__handhold.ui.handError };
  });
  check(real.fingers.length === 5 && real.handed === 'left', 'real hand file loads and is recognised as a left hand', JSON.stringify(real));
  await page.evaluate(() => window.__handhold.actions.objectSample('mug'));
  await page.locator('[data-key="find"]').click();
  await page.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/13-real-hand-mug.png` });
  check(await page.evaluate(() => window.__handhold.grasps[0]?.stable === true), 'real hand holds the mug');

  // --- the same grip on the skeleton the file already had
  const ownChip = page.locator('#toggle-character');
  check(await ownChip.isVisible(), 'a model with its own skeleton offers "On my model"');
  await ownChip.click();
  await page.waitForTimeout(700);
  const own = await page.evaluate(() => {
    const hh = window.__handhold;
    return { view: hh.characterView, error: hh.transferError, posed: hh.hand.char.fingerBones, handBone: hh.hand.char.handBone.name };
  });
  check(own.view === true && own.posed >= 10 && own.error < 0.08, 'its own finger bones are posed to match the grip', JSON.stringify(own));
  await page.screenshot({ path: `${OUT}/13b-own-skeleton.png` });
  await page.getByRole('button', { name: 'Export this grip' }).click();
  const [dlOwn] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('[data-key="dl-glb"]').click()]);
  await dlOwn.saveAs(`${OUT}/own-skeleton.glb`);
  const ownGlb = readFileSync(`${OUT}/own-skeleton.glb`);
  const ownGltf = JSON.parse(ownGlb.subarray(20, 20 + ownGlb.readUInt32LE(12)).toString('utf8'));
  const ownNames = ownGltf.skins[0].joints.map((j) => ownGltf.nodes[j].name);
  check(ownNames.includes('index-finger-phalanx-proximal') && ownGltf.animations?.[0]?.name === 'Grip', 'export keeps the original bone names and adds the Grip animation', `${ownNames.length} bones`);
  await ownChip.click();
  await page.locator('.step-head', { hasText: 'Find grips' }).click();
  await page.getByRole('button', { name: 'Bones' }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/14-real-hand-bones.png` });

  // --- error message for a bad file
  await page.locator('.step-head', { hasText: 'Object' }).click();
  await page.locator('#panel input[type=file]').first().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('.error');
  check((await page.locator('.error').innerText()).includes('not a supported 3D file'), 'unsupported files get a clear message');

  // --- dark theme and phone layout
  const dark = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark' });
  const dp = await dark.newPage();
  dp.on('pageerror', (e) => problems.push('pageerror(dark): ' + e.message));
  await dp.goto(base + '?demo=mug');
  await dp.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
  await dp.waitForTimeout(1000);
  await dp.screenshot({ path: `${OUT}/20-dark.png` });
  await dark.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => problems.push('pageerror(phone): ' + e.message));
  await pp.goto(base + '?demo=ball');
  await pp.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 120000 });
  await pp.waitForTimeout(1000);
  await pp.screenshot({ path: `${OUT}/21-phone.png` });
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'phone layout has no sideways scroll');
  await phone.close();

  check(problems.length === 0, 'no console or page errors', problems.slice(0, 5).join(' | '));
} catch (e) {
  failed = true;
  console.log('FAIL  script error —', e.message);
  if (problems.length) console.log('problems:', problems.slice(0, 8).join(' | '));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
process.exit(failed ? 1 : 0);
