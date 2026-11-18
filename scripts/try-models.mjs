/**
 * Runs real model files through the built app in a headless browser and
 * reports what happened, with screenshots. Nothing is opened on screen.
 *
 *   node scripts/try-models.mjs <out-name> <hand file> [object file] [more object files...]
 *
 * Options via env: HAND_PICK=left|right (for full characters), VIEW=bones|fit,
 * TWO=fx,fy,fz (second hand's spot), ARM=1|hold, HOLD / SWEEP_TO=forward,up,out,
 * TURN=tilt,turn,roll, EXPORT=1, ARMMODE=animation|hold|camera, OUT_DIR=folder,
 * STYLE=everyday|tool|weapon, CLIPS=kind[:name],... (ready-made animations), POSES=Name[:f,u,o[@tilt,turn,roll]]/...
 * (still poses) and LOOK=Name with LOOK_RANGE=up,down,left,right (the arm follows the view): all saved into the export.
 * The hand file may be "sample" (the built-in player) or "sample-hand"; an object may be
 * "sample:<stick|box|ball|mug|hammer>".
 * scripts/handhold.mjs wraps this with plain flags.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const [, , outName, handPath, ...objectPaths] = process.argv;
if (!outName || !handPath) {
  console.log('usage: node scripts/try-models.mjs <out-name> <hand file> [object files...]');
  process.exit(2);
}
const OUT = process.env.OUT_DIR ?? 'test-output/real';
mkdirSync(OUT, { recursive: true });
const port = 4180 + Math.floor(Math.random() * 400);
const server = await preview({ preview: { port, strictPort: false, host: '127.0.0.1' } });
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const problems = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true })).newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()));
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  await page.goto(base);
  await page.waitForSelector('.steps');

  // ---- hand
  let t0 = Date.now();
  if (handPath === 'sample') await page.getByRole('button', { name: 'Use the sample player' }).click();
  else if (handPath === 'sample-hand') await page.getByRole('button', { name: 'Use the sample hand' }).click();
  else await page.locator('#panel .step.is-open input[type=file]').first().setInputFiles(handPath);
  await page.waitForFunction(
    () => {
      const hh = window.__handhold;
      return !hh.ui.handBusy && (hh.hand || hh.ui.handError || hh.ui.handChoice);
    },
    null,
    { timeout: 300000 },
  );
  // a whole character: choose which hand to take
  if (await page.evaluate(() => !!window.__handhold.ui.handChoice)) {
    const pick = process.env.HAND_PICK ?? 'right';
    console.log('character detected, taking the', pick, 'hand; options:', await page.evaluate(() => JSON.stringify(window.__handhold.ui.handChoice)));
    await page.screenshot({ path: `${OUT}/${outName}-0-choice.png` });
    // HAND_PICK is "left", "right", or 0/1 for the first/second hand found
    const byKey = page.locator(`[data-key="pick-${pick}"]`);
    if (await byKey.count()) await byKey.first().click();
    else await page.locator('#panel [data-key^="pick-"]').nth(Number(pick) || 0).click();
    await page.waitForFunction(() => !window.__handhold.ui.handBusy && (window.__handhold.hand || window.__handhold.ui.handError), null, { timeout: 300000 });
  }
  const info = await page.evaluate(() => {
    const hh = window.__handhold;
    if (!hh.hand) return { error: hh.ui.handError };
    const h = hh.hand.rig;
    let verts = 0;
    for (const m of h.meshes) verts += m.geometry.getAttribute('position').count;
    return {
      fingers: h.model.fingers.map((f) => f.name),
      handed: h.model.handedness,
      verts,
      size: Number(h.model.size.toFixed(4)),
      palmConfidence: Number(h.analysis.palmConfidence.toFixed(2)),
      warnings: h.analysis.warnings,
      palmSpheres: h.model.spheres.filter((s) => s.finger < 0).length,
    };
  });
  console.log(`HAND ${basename(handPath)} (${Date.now() - t0} ms):`, JSON.stringify(info));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${outName}-1-hand.png` });
  if (info.error) throw new Error('hand failed: ' + info.error);
  await page.getByRole('button', { name: 'Bones' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${outName}-2-bones.png` });
  await page.getByRole('button', { name: 'Bones' }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${outName}-3-fit.png` });
  await page.getByRole('button', { name: 'Fit', exact: true }).click();

  // ---- objects
  let n = 0;
  for (const objectPath of objectPaths) {
    n++;
    // "<file>@<fx,fy,fz grip point as box fractions>@<size as multiples of the hand's length>"
    const [file, pickSpec, sizeSpec] = objectPath.split('@');
    await page.locator('.step-head', { hasText: 'Object' }).click();
    t0 = Date.now();
    const sample = file.startsWith('sample:') ? file.slice(7) : null;
    if (sample) await page.evaluate((id) => window.__handhold.actions.objectSample(id), sample);
    else await page.locator('#panel .step.is-open input[type=file]').first().setInputFiles(file);
    const expect = sample ? sample.charAt(0).toUpperCase() + sample.slice(1) : basename(file).replace(/\.[^.]+$/, '');
    await page.waitForFunction((name) => window.__handhold.object?.name === name || window.__handhold.ui.objectError, expect, { timeout: 300000 });
    const oinfo = await page.evaluate(() => {
      const hh = window.__handhold;
      if (hh.ui.objectError) return { error: hh.ui.objectError };
      const o = hh.object;
      const s = o.box.getSize(o.box.min.clone());
      return {
        tris: o.grasp.index.length / 3,
        size: [s.x, s.y, s.z].map((v) => Number(v.toFixed(3))),
        ratio: Number(hh.ui.object.ratio.toFixed(2)),
        rescaled: hh.ui.object.rescaled,
        watertight: o.grasp.watertight,
      };
    });
    console.log(`OBJECT ${basename(file)} (${Date.now() - t0} ms):`, JSON.stringify(oinfo));
    if (oinfo.error) continue;
    if (sizeSpec) {
      // same as dragging the Size slider
      await page.evaluate((want) => {
        const hh = window.__handhold;
        hh.actions.objectScale(Math.max(-1, Math.min(1, Math.log10(want / hh.ui.object.ratio))));
      }, Number(sizeSpec));
      console.log('  resized to', await page.evaluate(() => window.__handhold.ui.object.ratio.toFixed(2)), 'x hand length');
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${outName}-obj${n}-a-loaded.png` });
    // grip point: "fx,fy,fz" as fractions of the bounding box (default: middle), clicked through the view
    const frac = (pickSpec ?? '0.5,0.5,0.5').split(',').map(Number);
    await page.locator('.step-head', { hasText: 'Grip point' }).click();
    // AIM="x,y,z;fx,fy,fz;tx,ty,tz": hold it this way (point, fingers' way, thumb's way, in the object file's axes); AIM2 for the second hand
    const aimOf = (spec) => spec.split(';').map((t) => t.split(',').map(Number));
    if (process.env.CARRIED) await page.evaluate(() => window.__handhold.actions.setCarried(true));
    if (process.env.AIM) {
      const [at, fw, tw] = aimOf(process.env.AIM);
      await page.waitForTimeout(300);
      console.log('  AIM: first hand held this way:', await page.evaluate((a) => window.__handhold.actions.holdThisWay(1, a[0], a[1] ?? null, a[2] ?? null), [at, fw, tw]));
      if (process.env.AIM2) {
        const [at2, fw2, tw2] = aimOf(process.env.AIM2);
        await page.evaluate(() => window.__handhold.actions.setTwoHands(true));
        await page.waitForTimeout(300);
        console.log('  AIM2: second hand held this way:', await page.evaluate((a) => window.__handhold.actions.holdThisWay(2, a[0], a[1] ?? null, a[2] ?? null), [at2, fw2, tw2]));
      }
    }
    if (process.env.AIM) {
      // marked through the action above, no click
    } else {
    await page.waitForTimeout(700);
    const picked = await page.evaluate((frac) => {
      const hh = window.__handhold;
      const b = hh.object.box;
      const target = b.min.clone();
      target.x += (b.max.x - b.min.x) * frac[0];
      target.y += (b.max.y - b.min.y) * frac[1];
      target.z += (b.max.z - b.min.z) * frac[2];
      return hh.viewer.toScreen(target);
    }, frac);
    await page.mouse.click(picked.x, picked.y);
    await page.waitForTimeout(300);
    if (!(await page.evaluate(() => window.__handhold.ui.grip))) {
      console.log('  could not click a grip point there (ray missed the object)');
      await page.screenshot({ path: `${OUT}/${outName}-obj${n}-miss.png` });
      continue;
    }
    // TWO="fx,fy,fz": hold the object with both hands, the second one at this spot
    if (process.env.TWO) {
      if (!(await page.evaluate(() => window.__handhold.ui.twoHandsAvailable))) console.log('  TWO HANDS: this model has no second hand with an arm');
      else {
        await page.locator('[data-key="hands-2"]').click();
        await page.waitForTimeout(300);
        if (!(await page.evaluate(() => window.__handhold.ui.twoHands))) console.log('  TWO HANDS: the other hand could not be rigged');
        else {
          const f2 = process.env.TWO.split(',').map(Number);
          const spot = await page.evaluate((frac) => {
            const hh = window.__handhold;
            const b = hh.object.box;
            const t = b.min.clone();
            t.x += (b.max.x - b.min.x) * frac[0];
            t.y += (b.max.y - b.min.y) * frac[1];
            t.z += (b.max.z - b.min.z) * frac[2];
            return hh.viewer.toScreen(t);
          }, f2);
          await page.mouse.click(spot.x, spot.y);
          await page.waitForTimeout(300);
          console.log('  TWO HANDS: second spot marked:', await page.evaluate(() => window.__handhold.ui.grip2));
        }
      }
    }
    }
    await page.screenshot({ path: `${OUT}/${outName}-obj${n}-0-marked.png` });
    await page.getByRole('button', { name: 'Continue' }).click();
    t0 = Date.now();
    await page.locator('[data-key="find"]').click();
    await page.waitForFunction(() => window.__handhold.grasps && !window.__handhold.ui.solving, null, { timeout: 600000 });
    const grips = await page.evaluate(() =>
      window.__handhold.grasps.map((g) => ({
        holds: g.stable,
        squeeze: Number.isFinite(g.effort) ? Number(g.effort.toFixed(2)) : null,
        robust: Number(g.robustness.toFixed(2)),
        fingers: g.fingersTouching,
        thumb: g.thumbTouching,
        palm: g.palmTouching,
        segments: `${g.segmentsTouching}/${g.segmentsTotal}`,
        at: Object.fromEntries(Object.entries(g.params).map(([k, v]) => [k, Number(v.toFixed(2))])),
      })),
    );
    console.log(`  GRIPS (${Date.now() - t0} ms):`, JSON.stringify(grips));
    await page.waitForTimeout(1100);
    await page.screenshot({ path: `${OUT}/${outName}-obj${n}-1-grip.png` });
    if (await page.evaluate(() => window.__handhold.ui.twoHands)) {
      console.log('  SECOND HAND:', await page.evaluate(() => window.__handhold.ui.supportText));
      for (const [i, turn] of [[1, 0.55], [2, -0.55]]) {
        await page.evaluate((turn) => {
          const { viewer: v, hand } = window.__handhold;
          const a = hand.arm;
          const dir = a.forward.clone().applyAxisAngle(new v.camera.up.constructor(0, 1, 0), turn);
          v.camera.position.copy(v.controls.target).addScaledVector(dir, 1).add(new v.camera.up.constructor(0, 0.3, 0));
          v.frame();
        }, turn);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${OUT}/${outName}-obj${n}-two-${i}.png` });
      }
    }
    // look at it from the other side too
    await page.evaluate(() => {
      const v = window.__handhold.viewer;
      const t = v.controls.target;
      const d = v.camera.position.clone().sub(t);
      d.applyAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI * 0.85);
      v.camera.position.copy(t).add(d);
      v.controls.update();
      v.invalidate();
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${outName}-obj${n}-2-grip-back.png` });
    // PIN="finger,fx,fy,fz": put that fingertip (0 = thumb, 1 = index...) on a spot, clicked like the grip point
    if (process.env.PIN) {
      const [finger, ...pf] = process.env.PIN.split(',').map(Number);
      await page.locator(`[data-key="pin-f${finger}"]`).click();
      await page.locator('[data-key="pin-pick"]').click();
      const spot = await page.evaluate((frac) => {
        const hh = window.__handhold;
        const b = hh.object.box;
        const t = b.min.clone();
        t.x += (b.max.x - b.min.x) * frac[0];
        t.y += (b.max.y - b.min.y) * frac[1];
        t.z += (b.max.z - b.min.z) * frac[2];
        return hh.viewer.toScreen(t);
      }, pf);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(700);
      const pinState = await page.evaluate(() => window.__handhold.arm);
      console.log(`  FINGERTIP: set=${pinState.pinSet}, stops ${(pinState.pinMiss * 100).toFixed(1)}% of a hand length short`);
      await page.screenshot({ path: `${OUT}/${outName}-obj${n}-5-fingertip.png` });
    }
    // if the model has its own skeleton: show the same grip on it
    const chip = page.locator('#toggle-character');
    if ((await chip.isVisible()) && !(await page.evaluate(() => window.__handhold.ui.twoHands))) {
      await chip.click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${OUT}/${outName}-obj${n}-3-on-model.png` });
      await page.evaluate(() => window.__handhold.viewer.frame());
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${outName}-obj${n}-4-on-model-whole.png` });
      const bones = await page.evaluate(() => {
        const c = window.__handhold.hand.char;
        return { posed: c.fingerBones, handBone: c.handBone.name, sample: c.bones.filter((b, i) => c.jointOf[i] > 0).slice(0, 4).map((b) => b.name) };
      });
      console.log('  ON MODEL:', JSON.stringify(bones));
      const err = await page.evaluate(() => {
        const hh = window.__handhold;
        return { fraction: hh.transferError, size: hh.hand.rig.model.size };
      });
      console.log(`  fingertip mismatch vs solved hand: ${(err.fraction * 100).toFixed(1)}% of hand length`);
      await chip.click();
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => {
      const v = window.__handhold.viewer;
      const t = v.controls.target;
      const d = v.camera.position.clone().sub(t);
      d.applyAxisAngle({ x: 0, y: 1, z: 0 }, -Math.PI * 0.85);
      v.camera.position.copy(t).add(d);
      v.controls.update();
      v.invalidate();
    });
  }
  // ARM=1: pose the arm of a character, set a sweep from low to high, and photograph three points along it
  if (process.env.ARM && (await page.locator('[data-key="to-arm"]').count())) {
    await page.locator('[data-key="to-arm"]').click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${outName}-arm-0-default.png` });
    const hh = (fn) => page.evaluate(fn);
    // the same pose seen from in front of the character and off to the arm's side
    const frontShot = async (path) => {
      await hh(() => {
        const { viewer: v, hand } = window.__handhold;
        const a = hand.arm;
        v.camera.position.copy(v.controls.target).addScaledVector(a.forward, 1).addScaledVector(a.outward, 0.7).add(new v.camera.up.constructor(0, 0.35, 0));
        v.frame();
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path });
    };
    // HOLD / SWEEP_TO="forward,up,out": where the wrist goes, as fractions of the arm's reach from the shoulder
    const fractions = (text, fallback) => (text ? text.split(',').map(Number) : fallback);
    const holdAt = fractions(process.env.HOLD, [0.62, -0.5, -0.05]);
    await page.evaluate((f) => window.__handhold.setHold(f[0], f[1], f[2]), holdAt);
    // ARM=hold: one hold position and no sweep
    if (process.env.ARM !== 'hold') {
      await page.locator('[data-key="sweep-from"]').click();
      await page.evaluate((f) => window.__handhold.setHold(f[0], f[1], f[2]), fractions(process.env.SWEEP_TO, [0.6, 0.38, -0.05]));
      await page.locator('[data-key="sweep-to"]').click();
    } else {
      await page.waitForTimeout(400);
      console.log('  WRIST at the hold:', await hh(() => window.__handhold.ui.wristText));
      if (await hh(() => window.__handhold.ui.twoHands)) console.log('  SECOND HAND at the hold:', await hh(() => window.__handhold.ui.supportText));
      await frontShot(`${OUT}/${outName}-arm-hold-front.png`);
    }
    for (const [i, t] of process.env.ARM === 'hold' ? [] : [0, 0.5, 1].entries()) {
      await hh(() => 0);
      await page.evaluate((t) => window.__handhold.actions.sweepScrub(t), t);
      await page.evaluate(() => window.__handhold.viewer.frame());
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${outName}-arm-${i + 1}-sweep-${Math.round(t * 100)}.png` });
      console.log(`  WRIST at ${Math.round(t * 100)}%:`, await hh(() => window.__handhold.ui.wristText));
      await frontShot(`${OUT}/${outName}-arm-${i + 1}-sweep-${Math.round(t * 100)}-front.png`);
    }
    // the arm should not jump anywhere along the sweep: the largest turn of any arm bone between 1% steps
    if (process.env.ARM !== 'hold') {
      const step = await hh(() => {
        const { hand, actions } = window.__handhold;
        const a = hand.arm, bones = [a.upper, a.fore, a.hand];
        let last = null, worst = 0, at = 0;
        for (let i = 0; i <= 100; i++) {
          actions.sweepScrub(i / 100);
          const qs = bones.map((b) => b.getWorldQuaternion(b.quaternion.clone()));
          if (last) for (const [k, q] of qs.entries()) {
            const d = (q.angleTo(last[k]) * 180) / Math.PI;
            if (d > worst) [worst, at] = [d, i];
          }
          last = qs;
        }
        return { worst: Math.round(worst * 10) / 10, at };
      });
      console.log(`  SWEEP largest step: ${step.worst}° at ${step.at}%`);
    }
    // TURN=tilt,turn,roll: turn the held object and let the wrist follow
    if (process.env.TURN) {
      const turn = process.env.TURN.split(',').map(Number);
      for (const [axis, v] of turn.entries()) await page.evaluate(([axis, v]) => window.__handhold.actions.setTurn(axis, v), [axis, v]);
      await page.evaluate(() => window.__handhold.viewer.frame());
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${outName}-arm-turn.png` });
      await frontShot(`${OUT}/${outName}-arm-turn-front.png`);
      console.log(`  WRIST turned ${process.env.TURN}:`, await hh(() => window.__handhold.ui.wristText));
    }
    console.log('  ARM:', JSON.stringify(await hh(() => ({ on: window.__handhold.arm.on, sweep: window.__handhold.arm.sweep }))));
  }
  // EXPORT=1: download the GLB of the last grip through the real buttons and check what is in it
  if (process.env.EXPORT && (await page.evaluate(() => window.__handhold.grasps?.length > 0))) {
    // Saved animations: ready-made motions for the item type, still poses and a look, all written into the export
    const numbers = (text) => (text ? text.split(',').map(Number) : null);
    const noArm = 'could not be made (needs a character with arm bones and a grip)';
    if (process.env.STYLE) await page.evaluate((s) => window.__handhold.actions.setItemStyle(s), process.env.STYLE);
    for (const spec of (process.env.CLIPS ?? '').split(',').map((c) => c.trim()).filter(Boolean)) {
      const [kind, name] = spec.split(':');
      const made = await page.evaluate(([k, n]) => window.__handhold.addMotion(k, undefined, n || undefined), [kind, name]);
      console.log(`  ANIMATION ${spec}:`, made ?? noArm);
    }
    // a still pose: at the hold position, or at fractions of the arm's reach (forward, up, outward), optionally turned
    for (const spec of (process.env.POSES ?? '').split('/').map((c) => c.trim()).filter(Boolean)) {
      const [name, where] = spec.split(':');
      const [at, turn] = (where ?? '').split('@');
      const made = await page.evaluate(([n, a, t]) => window.__handhold.addPose(n, a, t), [name, numbers(at), numbers(turn)]);
      console.log(`  POSE ${spec}:`, made ?? noArm);
    }
    // a look: the arm follows the player's view up, down, left and right, this many degrees each way
    if (process.env.LOOK) {
      const r = numbers(process.env.LOOK_RANGE) ?? [];
      const ranges = r.length === 4 && r.every(Number.isFinite) ? { up: r[0], down: r[1], left: r[2], right: r[3] } : {};
      const made = await page.evaluate(([n, g]) => window.__handhold.addLook(n, g), [process.env.LOOK, ranges]);
      console.log(`  LOOK ${process.env.LOOK}:`, made ?? noArm);
    }
    console.log('  SAVED:', JSON.stringify(await page.evaluate(() => window.__handhold.saved)));
    await page.locator('.step-head', { hasText: 'Export' }).click();
    // ARMMODE=animation|hold|camera: how the arm is meant to move in the game
    if (process.env.ARMMODE && (await page.locator(`[data-key="arm-${process.env.ARMMODE}"]`).count()))
      await page.locator(`[data-key="arm-${process.env.ARMMODE}"]`).click();
    console.log('  ARM MODE:', await page.evaluate(() => window.__handhold.ui.armMode));
    // one package per program, through the real buttons
    for (const engine of ['unity', 'godot', 'blender']) {
      const [pk] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.locator(`[data-key="export-${engine}"]`).click()]);
      const ppath = `${OUT}/${outName}-${pk.suggestedFilename()}`;
      await pk.saveAs(ppath);
      const files = await page.evaluate(() => window.__handhold.lastPackage.files);
      console.log(`  PACKAGE ${ppath}: ${(readFileSync(ppath).length / 1e6).toFixed(2)} MB, files: ${files.join(', ')}`);
    }
    await page.screenshot({ path: `${OUT}/${outName}-6-export.png` });
    // For checking the engine scripts: where every named bone is at rest and in the
    // exported pose, straight from the app's own skeleton (not from the pose file).
    const fixture = await page.evaluate(() => {
      const hh = window.__handhold;
      const c = hh.hand.char;
      if (!c) return null;
      hh.makePose();
      c.root.updateMatrixWorld(true);
      const V = c.restHead[0].constructor, Q = c.restWorld[0].constructor;
      const world = (b) => {
        const p = new V(), q = new Q(), sc = new V();
        b.matrixWorld.decompose(p, q, sc);
        return { p: p.toArray(), q: q.toArray() };
      };
      const out = [];
      const add = (c, arm, second) => {
        const armBones = arm ? [arm.upper, arm.fore, arm.hand] : [];
        if (arm) {
          const at = [arm.shoulder, arm.elbow, arm.wrist];
          armBones.forEach((b, i) =>
            out.push({ name: b.name, parent: i ? armBones[i - 1].name : null, rest: { p: at[i].toArray(), q: arm.restWorld[i].toArray() }, posed: world(b), second }),
          );
        }
        c.bones.forEach((b, i) => {
          if (armBones.includes(b)) return;
          out.push({
            name: b.name,
            parent: b.parent && b.parent.isBone ? b.parent.name : null,
            rest: { p: c.restHead[i].toArray(), q: c.restWorld[i].toArray() },
            posed: world(b),
            second,
          });
        });
      };
      add(c, hh.hand.arm, false);
      // a two-handed grip: the second arm and hand follow, with their own chain
      const s = hh.support;
      if (s) {
        s.char.root.updateMatrixWorld(true);
        add(s.char, s.arm, true);
      }
      return { bones: out, second: s ? s.arm.hand.name : null };
    });
    if (fixture) {
      writeFileSync(`${OUT}/${outName}-fixture.json`, JSON.stringify(fixture));
      console.log(`  FIXTURE ${OUT}/${outName}-fixture.json: ${fixture.bones.length} bones`);
    }
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.locator('[data-key="dl-glb"]').click()]);
    const path = `${OUT}/${outName}-${dl.suggestedFilename()}`;
    await dl.saveAs(path);
    const glb = readFileSync(path);
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    const skinned = gltf.nodes.filter((n) => n.skin !== undefined).length;
    // is the object attached under one of the skeleton's joints?
    const joints = new Set(gltf.skins?.[0]?.joints ?? []);
    const carrier = gltf.nodes.findIndex((n, i) => joints.has(i) && (n.children ?? []).some((c) => !joints.has(c)));
    if (carrier >= 0) console.log(`  object is attached under bone "${gltf.nodes[carrier].name}"`);
    const [dj] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('[data-key="dl-json"]').click()]);
    const jpath = `${OUT}/${outName}-${dj.suggestedFilename()}`;
    await dj.saveAs(jpath);
    const pose = JSON.parse(readFileSync(jpath, 'utf8'));
    console.log(`  POSE JSON ${jpath}: skeleton=${pose.skeleton ?? 'new'}, ${pose.bones.length} bones, first: ${pose.bones.slice(0, 3).map((b) => b.name).join(', ')}${pose.handBone ? ', attach to ' + pose.handBone : ''}`);
    if (pose.secondHand) console.log(`  SECOND HAND in JSON: ${pose.secondHand.handBone}, ${pose.secondHand.bones.length} finger bones, arm ${pose.secondHand.arm.upperArm} > ${pose.secondHand.arm.forearm}, sweep keys: ${pose.secondHand.arm.sweep.length}`);
    if (pose.arm) console.log(`  ARM in JSON: mode ${pose.arm.mode}, ${pose.arm.upperArm} > ${pose.arm.forearm} > ${pose.arm.hand}, sweep keys: ${pose.arm.sweep.length}, rest points: ${pose.restPoints.length}`);
    if (pose.arm) console.log(`  SAVED in JSON: poses [${(pose.arm.poses ?? []).map((p) => p.name).join(', ')}], animations [${(pose.arm.clips ?? []).map((c) => `${c.name} ${c.duration.toFixed(2)}s${c.loops ? ' loops' : ''}`).join(', ')}], looks [${(pose.arm.looks ?? []).map((l) => `${l.name} yaw ${l.yaw.join('..')} pitch ${l.pitch.join('..')}`).join(', ')}]`);
    console.log(
      `EXPORT ${path}: ${(glb.length / 1e6).toFixed(1)} MB, ${gltf.meshes.length} meshes, ${skinned} skinned, ` +
        `${gltf.skins?.[0]?.joints.length ?? 0} bones, animations: ${(gltf.animations ?? []).map((a) => `${a.name} (${a.channels.length} channels)`).join(', ') || 'none'}, ` +
        `textures: ${(gltf.images ?? []).length}`,
    );
  }
  if (problems.length) console.log('PROBLEMS:', problems.slice(0, 6).join(' | '));
} catch (e) {
  console.log('STOPPED:', e.message.split('\n')[0]);
  if (problems.length) console.log('PROBLEMS:', problems.slice(0, 6).join(' | '));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
