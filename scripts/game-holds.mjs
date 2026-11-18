/**
 * Solves every hold a game exported (a manifest of held things and where the game puts each hand) in one headless browser
 * session, and writes a pose file per hold plus summary.json. Nothing is opened on screen.
 *
 *   node scripts/game-holds.mjs --hand <character file> --in <folder with manifest.json> [--out folder]
 *        [--only pose,pose] [--frames 3,4] [--move 0.2] [--turn 15] [--skin-mm 5] [--shots] [--compare] [--eval js] [--build]
 *
 * The manifest (the game writes it, for example from an editor script); an optional top-level "hinges": "bone:ax,ay,az,maxDegrees,px,py,pz;..."
 * (each finger bone's one bending axis and rest position, in the game's rest space, mirrored like the rest) makes the fingers bend only about those
 * (--no-hinges ignores it):
 *   { "items": [ { "name", "pose", "frame", "side": "right"|"left", "file": "<obj in the folder>",
 *                  "relax": "index" (fingers left straight), "place": "hand_r:x,y,z;index_01_r:x,y,z;..." } ] }
 * "place" is where the game has put the hand's bones, in the held thing's own axes (mirrored to right-handed). The hand is lined up
 * on those bones and only the fingers and thumb are closed, on the real mesh, so the result drops straight into the game's own
 * hand placement. With --move / --turn (a share of the hand's length, degrees; 0 keeps the hand exactly where the game put it) the
 * hand may also shift and turn that far when it then holds clearly better; where it ended up is written as "placeAfter" (same form as
 * "place") for the game to apply. An idle hold is solved on its grip hold's hand, so laying the trigger finger along the frame never
 * moves the hand. Every hold also reports "depth": how far the drawn hand's skin goes into the WHOLE held thing (every part of
 * the OBJ, not only the grip), per finger and the palm, in metres. A finger deeper than --skin-mm (5) is first taken out of it (its end
 * joints, knuckle or whole finger opened or closed, measured on the skin; "cleared" says what moved), and still deeper is listed as a
 * problem. The trigger finger is left where the game wants it. --shots: close-ups from both sides; --compare: the same views of the game's own hold (game_*.obj from the export).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[argv[i].slice(2)] = true;
  else args[argv[i++].slice(2)] = next;
}
if (!args.hand || !args.in) {
  console.log('usage: node scripts/game-holds.mjs --hand <character file> --in <folder with manifest.json> [--out folder] [--only grip,idle] [--frames 3,4] [--shots] [--build]');
  process.exit(2);
}
const inDir = resolve(args.in);
const out = resolve(args.out ?? join(inDir, '..', 'out'));
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(inDir, 'manifest.json'), 'utf8'));
const only = args.only ? String(args.only).split(',') : null;
const frames = args.frames ? String(args.frames).split(',').map(Number) : null;
const items = manifest.items.filter((it) => (!only || only.includes(it.pose)) && (!frames || frames.includes(it.frame)));
console.log(`${items.length} holds to solve`);

if (!existsSync(join(root, 'dist', 'index.html')) || args.build) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (b.status !== 0) process.exit(1);
}
process.chdir(root);
const server = await preview({ preview: { port: 4180 + Math.floor(Math.random() * 400), strictPort: false, host: '127.0.0.1' } });
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const results = [];
const problems = [];
/** Glove skin deeper than this inside the held thing (mm) is a problem: a few mm is a glove pressed on a grip, more is a finger through the gun. */
const SkinDepthMm = Number(args['skin-mm'] ?? 5);
try {
  for (const side of ['right', 'left']) {
    const mine = items.filter((it) => it.side === side);
    if (!mine.length) continue;
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
    page.on('pageerror', (e) => problems.push(`${side}: pageerror: ${e.message}`));
    await page.goto(base);
    await page.waitForSelector('.steps');
    await page.locator('#panel .step.is-open input[type=file]').first().setInputFiles(resolve(args.hand));
    await page.waitForFunction(() => {
      const hh = window.__handhold;
      return !hh.ui.handBusy && (hh.hand || hh.ui.handError || hh.ui.handChoice);
    }, null, { timeout: 300000 });
    if (await page.evaluate(() => !!window.__handhold.ui.handChoice)) {
      const byKey = page.locator(`[data-key="pick-${side}"]`);
      if (await byKey.count()) await byKey.first().click();
      else await page.locator('#panel [data-key^="pick-"]').nth(side === 'left' ? 1 : 0).click();
      await page.waitForFunction(() => !window.__handhold.ui.handBusy && (window.__handhold.hand || window.__handhold.ui.handError), null, { timeout: 300000 });
    }
    const handInfo = await page.evaluate(() => {
      const hh = window.__handhold;
      return hh.hand ? { handed: hh.hand.rig.model.handedness, fingers: hh.hand.rig.model.fingers.length, character: !!hh.hand.char } : { error: hh.ui.handError };
    });
    console.log(`HAND ${side}:`, JSON.stringify(handInfo));
    if (handInfo.error || !handInfo.character) {
      problems.push(`${side} hand: ${handInfo.error ?? 'not a whole character with its own skeleton'}`);
      continue;
    }
    if (manifest.hinges && !args['no-hinges']) {
      // the game bends each finger joint about one hinge: solve on those, so the fingers bend where the game can show them
      const hinged = await page.evaluate((text) => window.__handhold.actions.setHinges(text), manifest.hinges);
      console.log(`HINGES ${side}:`, JSON.stringify(hinged));
      if (!hinged || hinged.joints < 10) problems.push(`${side} hand: only ${hinged?.joints ?? 0} finger joints found the game's hinges`);
    }
    const gripAfter = new Map();
    for (const it0 of mine) {
      const t0 = Date.now();
      const tag = `${it0.pose}_${it0.frame}_${it0.side}`;
      const obj = readFileSync(join(inDir, it0.file), 'utf8');
      // the idle hold keeps the grip hold's hand where it is
      const onGrip = it0.pose === 'idle' && gripAfter.has(it0.frame);
      const it = onGrip ? { ...it0, place: gripAfter.get(it0.frame) } : it0;
      const adjust = onGrip ? null : { move: Number(args.move ?? 0.2), turn: Number(args.turn ?? 15) };
      // on the grip the trigger finger's tip goes onto the trigger: the middle of the part the file names Trigger
      const trigger = it.pose === 'grip' ? partCentre(obj, /^trigger/i) : null;
      const r = await page.evaluate(
        async ({ obj, file, it, adjust, trigger }) => {
          const hh = window.__handhold;
          await hh.actions.objectFile(new File([obj], file));
          if (!hh.object) return { error: hh.ui.objectError ?? 'object did not load' };
          hh.actions.setCarried(it.pose !== 'torch');
          const points = it.place.split(';').map((e) => {
            const [name, xyz] = e.split(':');
            return { name, at: xyz.split(',').map(Number) };
          });
          const index = hh.hand.rig.model.fingers.findIndex((f) => f.name === 'index');
          const err = hh.actions.placeHand(
            points,
            it.relax ? it.relax.split(',') : [],
            adjust && (adjust.move > 0 || adjust.turn > 0) ? adjust : undefined,
            trigger && index >= 0 ? { finger: index, at: trigger } : undefined,
          );
          if (err) return { error: err };
          await hh.solve();
          const g = hh.grasps?.[0];
          if (!g) return { error: 'no grip came back', placed: hh.placed };
          let triggerMiss = -1;
          if (trigger && index >= 0 && !hh.actions.pinAt(index, trigger)) triggerMiss = hh.ui.pinMiss * hh.hand.rig.model.size;
          // the trigger finger (pinned to the trigger, or laid along the frame on an idle hold) is where the game wants it: leave it
          const cleared = clearSkin(hh, g, (trigger || it.relax) && index >= 0 ? index : -1, it.skinTol);
          return {
            placed: hh.placed,
            stable: g.stable,
            squeeze: Number.isFinite(g.effort) ? Number(g.effort.toFixed(2)) : -1,
            robust: Number(g.robustness.toFixed(2)),
            fingers: g.fingersTouching,
            thumb: g.thumbTouching,
            palm: g.palmTouching,
            segments: g.segmentsTouching,
            segmentsTotal: g.segmentsTotal,
            triggerMiss,
            after: hh.handAt(points.map((p) => p.name)),
            pose: hh.pose(),
            depth: skinDepth(hh),
            cleared,
          };
          /**
           * Takes each finger whose drawn skin is deeper than tol in the held thing out of it (2026-11-18): its end joints, its knuckle or
           * the whole finger opened or closed in tenths of the way to open or to its stop, measured on the skin each time, the shallowest
           * kept. The solver keeps its collision spheres clear, but the skin over a thumb's root stood 14 to 20 mm past them into a gun.
           */
          function clearSkin(hh, g, leave, tol) {
            const model = hh.hand.rig.model;
            const keyOf = (name) => (name === 'pinky' ? 'little' : name);
            const angles = Float32Array.from(g.angles);
            const show = () => hh.viewer.setPose({ wrist: g.wrist, angles }, 0);
            show();
            const said = [];
            model.fingers.forEach((f, fi) => {
              if (fi === leave) return;
              const key = keyOf(f.name);
              const depthNow = () => skinDepth(hh)?.[key] ?? 0;
              const start = depthNow();
              if (start <= tol) return;
              const dofs = f.joints.map((j) => {
                const joint = model.joints[j];
                const d = joint.dofs.findIndex((x) => x.kind === 'flex');
                return d < 0 ? null : { at: joint.dofStart + d, dof: joint.dofs[d] };
              });
              const was = dofs.map((d) => (d ? angles[d.at] : 0));
              const set = (way, share, mask) =>
                dofs.forEach((d, k) => {
                  if (!d) return;
                  const to = (mask & (1 << k)) === 0 ? was[k] : way < 0 ? Math.max(d.dof.min, Math.min(d.dof.max, d.dof.open ?? 0)) : d.dof.max;
                  angles[d.at] = was[k] + (to - was[k]) * share;
                });
              let best = { depth: start, way: 0, share: 0, mask: 7 };
              for (let step = 1; step <= 10 && best.depth > tol; step++) {
                for (const mask of [6, 1, 7]) {
                  for (const way of [-1, 1]) {
                    set(way, step / 10, mask);
                    show();
                    const d = depthNow();
                    if (d < best.depth - 0.0005) best = { depth: d, way, share: step / 10, mask };
                    if (best.depth <= tol) break;
                  }
                  if (best.depth <= tol) break;
                }
              }
              set(best.way, best.share, best.mask);
              show();
              if (best.way) said.push(`${key} ${best.mask === 6 ? 'end joints ' : best.mask === 1 ? 'knuckle ' : ''}${best.way < 0 ? 'opened' : 'closed'} ${Math.round(best.share * 100)}%: ${(start * 1000).toFixed(1)} -> ${(best.depth * 1000).toFixed(1)} mm`);
            });
            g.angles.set(angles);
            return said.join('; ');
          }
          /**
           * How deep the drawn hand's own skin goes into the whole held thing, per finger and the palm (metres, 0 = outside), with the
           * deepest point's place: the solver keeps its collision spheres clear, but a sphere is thinner than the glove over a knuckle,
           * so a thumb could lie 10 mm inside a receiver with every sphere clear (the game measured it, 2026-11-18).
           */
          function skinDepth(hh) {
            const root = hh.viewer.hand?.root;
            if (!root || !hh.object?.grasp) return null;
            root.updateMatrixWorld(true);
            const V = root.position.constructor;
            const v = new V();
            const out = { thumb: 0, index: 0, middle: 0, ring: 0, little: 0, palm: 0 };
            const where = {};
            const finger = (name) => {
              const n = name.toLowerCase();
              if (n.includes('thumb')) return 'thumb';
              if (n.includes('index')) return 'index';
              if (n.includes('middle')) return 'middle';
              if (n.includes('ring')) return 'ring';
              if (n.includes('pinky') || n.includes('little')) return 'little';
              return 'palm';
            };
            root.traverse((m) => {
              const pos = m.geometry?.getAttribute?.('position');
              if (!pos || !m.visible) return;
              const si = m.isSkinnedMesh ? m.geometry.getAttribute('skinIndex') : null;
              const sw = m.isSkinnedMesh ? m.geometry.getAttribute('skinWeight') : null;
              const bones = m.isSkinnedMesh ? m.skeleton.bones : null;
              for (let i = 0; i < pos.count; i++) {
                m.getVertexPosition(i, v);
                v.applyMatrix4(m.matrixWorld);
                const d = -hh.object.grasp.distance(v.x, v.y, v.z);
                if (!(d > 0)) continue;
                let key = 'palm';
                if (si && sw) {
                  let best = 0, w = -1;
                  for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > w) { w = sw.getComponent(i, k); best = si.getComponent(i, k); }
                  key = finger(bones[best]?.name ?? '');
                }
                if (d > out[key]) { out[key] = d; where[key] = [v.x, v.y, v.z].map((x) => Math.round(x * 1e4) / 1e4); }
              }
            });
            return { ...out, where };
          }
        },
        { obj, file: it.file, it: { ...it, skinTol: SkinDepthMm / 1000 }, adjust, trigger },
      );
      const ms = Date.now() - t0;
      // --eval "<expression>": printed per hold, evaluated in the page after the solve (hh is window.__handhold), for checking by hand
      if (args.eval) console.log(`  ${tag} eval:`, JSON.stringify(await page.evaluate((src) => { const hh = window.__handhold; return eval(src); }, String(args.eval))));
      if (r.error) {
        console.log(`  ${tag}: FAILED ${r.error}`);
        results.push({ ...strip(it), error: r.error, ...(r.placed ? { placed: r.placed } : {}) });
        continue;
      }
      const poseFile = `${tag}.pose.json`;
      writeFileSync(join(out, poseFile), JSON.stringify(r.pose, null, 1));
      const { pose, after, ...stats } = r;
      const round = (x) => Math.round(x * 1e6) / 1e6;
      const placeAfter = after.filter((a) => a.at).map((a) => `${a.name}:${a.at.map(round).join(',')}`).join(';');
      if (it.pose === 'grip') gripAfter.set(it.frame, placeAfter);
      // how far the hand bone moved from where the game put it
      const was = it0.place.split(';')[0].split(':')[1].split(',').map(Number);
      const now = after[0]?.at ?? was;
      const moved = Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]);
      results.push({ ...strip(it0), ...stats, place: it0.place, placeAfter, moved: round(moved), poseFile });
      const fit = r.placed ? `fit ${(r.placed.rms * 1000).toFixed(1)} mm, scale ${r.placed.scale.toFixed(3)}` : 'no fit';
      const deep = r.depth ? Object.entries(r.depth).filter(([k, d]) => k !== 'where' && d * 1000 > SkinDepthMm) : [];
      if (deep.length) problems.push(`${tag}: skin inside the held thing: ${deep.map(([k, d]) => `${k} ${(d * 1000).toFixed(1)} mm`).join(', ')}`);
      console.log(`  ${tag}: ${r.stable ? 'holds' : 'slips'}, squeeze ${r.squeeze}, ${r.segments}/${r.segmentsTotal} segments, thumb ${r.thumb}, palm ${r.palm}; ${fit}; hand moved ${(moved * 1000).toFixed(0)} mm${r.triggerMiss >= 0 ? `, trigger finger ${(r.triggerMiss * 1000).toFixed(0)} mm short` : ''} (${ms} ms)${r.cleared ? `; cleared ${r.cleared}` : ''}${r.depth ? `; skin in ${['thumb', 'index', 'middle', 'ring', 'little', 'palm'].map((k) => (r.depth[k] * 1000).toFixed(1)).join('/')} mm` : ''}`);
      if (args.shots) {
        // close up on the hand, from either side of the held thing (its X axis runs across a gun); the view is kept in the held
        // thing's own axes so the game's own hold (--compare) is seen from exactly the same place
        const views = await page.evaluate(() => {
          const hh = window.__handhold;
          const V = hh.viewer.camera.up.constructor;
          const ch = hh.hand.char;
          const at = ch.restHead[ch.bones.indexOf(ch.handBone)].clone().applyMatrix4(hh.grasps[0].wrist);
          // most of the way from the wrist bone to where the fingers touch
          const touch = new V(0, 0, 0);
          let n = 0;
          for (const c of hh.grasps[0].contacts ?? []) {
            const p = c.point ?? c.position;
            if (p && Number.isFinite(p.x)) { touch.add(p); n++; }
          }
          if (n) at.lerp(touch.multiplyScalar(1 / n), 0.6);
          const size = hh.hand.rig.model.size;
          const toLocal = hh.object.source.matrixWorld.clone().invert();
          return [1, -1].map((s) => ({
            target: at.clone().applyMatrix4(toLocal).toArray(),
            camera: at.clone().add(new V(s * size * 2.2, size * 0.6, -size * 0.5)).applyMatrix4(toLocal).toArray(),
          }));
        });
        const shoot = async (suffix) => {
          for (let i = 0; i < views.length; i++) {
            await page.evaluate((view) => {
              const hh = window.__handhold;
              const v = hh.viewer;
              const V = v.camera.up.constructor;
              v.camTween = null; // a glide from loading the object would carry the camera off again
              const m = hh.object.source.matrixWorld;
              v.controls.target.copy(new V(...view.target).applyMatrix4(m));
              v.camera.position.copy(new V(...view.camera).applyMatrix4(m));
              v.controls.update();
              v.invalidate();
            }, views[i]);
            await page.waitForTimeout(i === 0 ? 700 : 250);
            await page.screenshot({ path: join(out, `${tag}${suffix}-${'ab'[i]}.png`), clip: { x: 350, y: 0, width: 750, height: 760 } });
          }
        };
        await shoot('');
        // --compare: the game's own hold, the arms as the game posed them (HandholdExport writes game_*.obj), Handhold's hand hidden
        const gameFile = it.pose === 'torch' ? 'game_torch.obj' : `game_${it.pose === 'reload' ? 'reload' : 'grip'}_${it.frame}_${it.name}.obj`;
        if (args.compare && existsSync(join(inDir, gameFile))) {
          const ok = await page.evaluate(
            async ({ obj, file }) => {
              const hh = window.__handhold;
              await hh.actions.objectFile(new File([obj], file));
              if (!hh.object) return false;
              hh.viewer.hand && (hh.viewer.hand.root.visible = false);
              hh.viewer.character && (hh.viewer.character.visible = false);
              hh.viewer.setContacts([]);
              hh.viewer.invalidate();
              return true;
            },
            { obj: readFileSync(join(inDir, gameFile), 'utf8'), file: gameFile },
          );
          if (ok) await shoot('-game');
        }
      }
    }
    await page.context().close();
  }
} finally {
  await browser.close();
  await server.close();
}
/** The middle of the vertices of the OBJ's part (o line) whose name matches, or null. */
function partCentre(text, name) {
  let on = false, n = 0;
  const sum = [0, 0, 0];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('o ')) on = name.test(line.slice(2).trim());
    else if (on && line.startsWith('v ')) {
      const v = line.slice(2).trim().split(/\s+/).map(Number);
      for (let k = 0; k < 3; k++) sum[k] += v[k];
      n++;
    }
  }
  return n ? sum.map((x) => x / n) : null;
}
function strip(it) {
  return { name: it.name, pose: it.pose, frame: it.frame, side: it.side, file: it.file, relax: it.relax ?? '' };
}
const summary = { hand: resolve(args.hand), in: inDir, out, holds: results, problems };
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
const failed = results.filter((r) => r.error).length;
const badFit = results.filter((r) => r.placed && (r.placed.rms > 0.004 || Math.abs(r.placed.scale - 1) > 0.05)).length;
console.log(`${results.length - failed} of ${items.length} solved, ${results.filter((r) => r.stable).length} hold; ${badFit} lined up badly; problems: ${problems.length ? problems.join(' | ') : 'none'}`);
console.log(`summary: ${join(out, 'summary.json')}`);
process.exit(failed || problems.length ? 1 : 0);
