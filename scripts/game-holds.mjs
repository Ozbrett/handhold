/**
 * Solves every hold a game exported (a manifest of held things and where the game puts each hand) in one headless browser
 * session, and writes a pose file per hold plus summary.json. Nothing is opened on screen.
 *
 *   node scripts/game-holds.mjs --hand <character file> --in <folder with manifest.json> [--out folder]
 *        [--only pose,pose] [--frames 3,4] [--move 0.2] [--turn 15] [--skin-mm 1] [--shots] [--compare] [--eval js] [--build]
 *
 * The manifest (the game writes it, for example from an editor script); an optional top-level "hinges": "bone:ax,ay,az,maxDegrees,px,py,pz;..."
 * (each finger bone's one bending axis and rest position, in the game's rest space, mirrored like the rest) makes the fingers bend only about those
 * (--no-hinges ignores it):
 *   { "items": [ { "name", "pose", "frame", "part" (optional: the fitted part the hold is on, 0 or absent for the bare frame),
 *                  "side": "right"|"left", "file": "<obj in the folder>",
 *                  "relax": "index" (fingers left straight), "place": "hand_r:x,y,z;index_01_r:x,y,z;..." } ] }
 * "place" is where the game has put the hand's bones, in the held thing's own axes (mirrored to right-handed). The hand is lined up
 * on those bones and only the fingers and thumb are closed, on the real mesh, so the result drops straight into the game's own
 * hand placement. With --move / --turn (a share of the hand's length, degrees; 0 keeps the hand exactly where the game put it) the
 * hand may also shift and turn that far when it then holds clearly better; where it ended up is written as "placeAfter" (same form as
 * "place") for the game to apply. An idle hold is solved on its grip hold's hand, so laying the trigger finger along the frame never
 * moves the hand. Every hold is settled the way the site settles every grip it shows: the drawn hand's skin is kept out of the
 * WHOLE held thing (every part of the OBJ, not only the grip), both ways, its edges included, by turning finger joints within
 * their limits and, where no joint can, moving the hand out and closing the fingers on it again ("cleared" says what moved, and
 * the move is in "placeAfter"). "depth" is what is left, per finger and the palm, in metres; anything over --skin-mm (1) is a
 * problem. The trigger finger stays where the game wants it unless it is in the part. --shots: close-ups from both sides; --compare: the same views of the game's own hold (game_*.obj from the export).
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
/** Skin deeper than this inside the held thing (mm), or the held thing this deep in the skin, is a problem: the site keeps both under 1 mm. */
const SkinDepthMm = Number(args['skin-mm'] ?? 1);
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
      // a hold on a fitted part (a foregrip, a magazine) is its own hold: the part is in its name
      const part = it0.part ? `_p${it0.part}` : '';
      const tag = `${it0.pose}_${it0.frame}${part}_${it0.side}`;
      const gripKey = `${it0.frame}/${it0.part ?? 0}`;
      const obj = readFileSync(join(inDir, it0.file), 'utf8');
      // the idle hold keeps the grip hold's hand where it is
      const onGrip = it0.pose === 'idle' && gripAfter.has(gripKey);
      const it = onGrip ? { ...it0, place: gripAfter.get(gripKey) } : it0;
      const adjust = onGrip ? null : { move: Number(args.move ?? 0.2), turn: Number(args.turn ?? 15) };
      // on the grip the trigger finger's tip goes onto the trigger: the middle of the part the file names Trigger
      const trigger = it.pose === 'grip' ? partCentre(obj, /^trigger/i) : null;
      const r = await page.evaluate(
        async ({ obj, file, it, adjust, trigger }) => {
          const hh = window.__handhold;
          await hh.actions.objectFile(new File([obj], file));
          if (!hh.object) return { error: hh.ui.objectError ?? 'object did not load' };
          hh.actions.setCarried(!['torch', 'knife', 'shovel'].includes(it.pose));
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
          // the site keeps the drawn skin out of the whole held thing (both ways, edges included), moving fingers or the hand
          const skin = hh.skin();
          // what the game must draw for this to be the hold: every finger joint, each tip, the touches (the verify step compares them)
          const drawn = hh.handJoints();
          return {
            drawn,
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
            depth: skin?.after ?? null,
            depthBefore: skin?.before ?? null,
            skinClear: skin?.clear ?? false,
            skinMoved: skin?.moved ?? 0,
            cleared: skin?.changes.join('; ') ?? '',
          };
        },
        { obj, file: it.file, it, adjust, trigger },
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
      const { pose, after, drawn, ...stats } = r;
      const round = (x) => Math.round(x * 1e6) / 1e6;
      const points = (list) => (list ?? []).map((p) => `${p.name}:${p.at.map(round).join(',')}`).join(';');
      const joints = points(drawn?.joints), tips = points(drawn?.tips);
      const contacts = (drawn?.contacts ?? []).map((c) => `${c.finger}.${c.link}:${c.at.map(round).join(',')}`).join(';');
      const placeAfter = after.filter((a) => a.at).map((a) => `${a.name}:${a.at.map(round).join(',')}`).join(';');
      if (it.pose === 'grip') gripAfter.set(gripKey, placeAfter);
      // how far the hand bone moved from where the game put it
      const was = it0.place.split(';')[0].split(':')[1].split(',').map(Number);
      const now = after[0]?.at ?? was;
      const moved = Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]);
      results.push({ ...strip(it0), ...stats, place: it0.place, placeAfter, joints, tips, contacts, moved: round(moved), poseFile });
      const fit = r.placed ? `fit ${(r.placed.rms * 1000).toFixed(1)} mm, scale ${r.placed.scale.toFixed(3)}` : 'no fit';
      const deep = r.depth ? Object.entries(r.depth).filter(([, d]) => d * 1000 > SkinDepthMm) : [];
      if (deep.length || !r.skinClear) problems.push(`${tag}: skin and the held thing in each other: ${deep.map(([k, d]) => `${k} ${(d * 1000).toFixed(1)} mm`).join(', ') || 'not cleared'}`);
      console.log(`  ${tag}: ${r.stable ? 'holds' : 'slips'}, squeeze ${r.squeeze}, ${r.segments}/${r.segmentsTotal} segments, thumb ${r.thumb}, palm ${r.palm}; ${fit}; hand moved ${(moved * 1000).toFixed(0)} mm (${(r.skinMoved * 1000).toFixed(1)} of it out of the part)${r.triggerMiss >= 0 ? `, trigger finger ${(r.triggerMiss * 1000).toFixed(0)} mm short` : ''} (${ms} ms)${r.cleared ? `; cleared ${r.cleared}` : ''}${r.depth ? `; skin in ${['thumb', 'index', 'middle', 'ring', 'little', 'palm'].map((k) => (r.depth[k] * 1000).toFixed(1)).join('/')} mm` : ''}`);
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
        // an item in the fist (the torch, a blade) has one game file named after its hold
        const gameFile = ['torch', 'knife', 'shovel'].includes(it.pose) ? `game_${it.pose}.obj` : `game_${it.pose === 'reload' ? 'reload' : 'grip'}_${it.frame}_${it.name}.obj`;
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
  return { name: it.name, pose: it.pose, frame: it.frame, part: it.part ?? 0, side: it.side, file: it.file, relax: it.relax ?? '' };
}
const summary = { hand: resolve(args.hand), in: inDir, out, holds: results, problems };
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
const failed = results.filter((r) => r.error).length;
const badFit = results.filter((r) => r.placed && (r.placed.rms > 0.004 || Math.abs(r.placed.scale - 1) > 0.05)).length;
console.log(`${results.length - failed} of ${items.length} solved, ${results.filter((r) => r.stable).length} hold; ${badFit} lined up badly; problems: ${problems.length ? problems.join(' | ') : 'none'}`);
console.log(`summary: ${join(out, 'summary.json')}`);
process.exit(failed || problems.length ? 1 : 0);
