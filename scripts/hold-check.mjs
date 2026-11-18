#!/usr/bin/env node
/**
 * Checks a hold on a character the way the game shows it: the item aimed from the eye, each hand's pose file put on it, the arms
 * solved, every whole-pose check run (joints, skin, overlaps, elbow, way up, grip, reach), a contact sheet drawn (front, both
 * sides, above, the eye) and the result put in <out>/review.json for a verdict (scripts/review.mjs).
 *
 *   node scripts/hold-check.mjs --character <fbx|glb> --item <obj> --name <name> --out <dir>
 *        --hand right=<pose.json>[;grip=<Piece,...>[;wrap=middle,ring,pinky]] [--hand left=<pose.json>...]
 *        [--item-name <name>] [--style gun|tool|thing|part] [--forward x,y,z] [--up x,y,z] [--unmirrored] [--unreviewed]
 *
 * Exit code: 0 when every check passes and every item in the review is approved; 3 when anything fails, is pending or is
 * rejected (--unreviewed: only failures count); 1 on an error. Headless: no window, no browser.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { importTs } from './lib/ts.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const flag = (k) => args.includes(`--${k}`);
const need = ['character', 'item', 'name', 'out'].filter((k) => !opt(k));
if (need.length || !all('hand').length) {
  console.error(`hold-check: missing ${[...need.map((k) => `--${k}`), ...(all('hand').length ? [] : ['--hand'])].join(', ')} (see the top of scripts/hold-check.mjs)`);
  process.exit(1);
}
const vec = (s) => s && s.split(',').map(Number);
const hands = all('hand').map((h) => {
  const [first, ...rest] = h.split(';');
  const [side, pose] = [first.slice(0, first.indexOf('=')), first.slice(first.indexOf('=') + 1)];
  const o = Object.fromEntries(rest.map((p) => p.split('=')));
  return { side, pose: resolve(pose), ...(o.grip ? { grip: { pieces: o.grip.split(','), wrap: (o.wrap ?? 'middle,ring,pinky').split(',').filter(Boolean) } } : {}) };
});
const out = resolve(opt('out'));
const { checkHold } = await importTs('src/check/holdCheck.ts');
const R = await importTs('src/check/review.ts');
const { describe } = await importTs('src/check/poseCheck.ts');
mkdirSync(out, { recursive: true });
const reviewPath = resolve(out, 'review.json');
const review = R.readReview(reviewPath);
const spec = {
  name: opt('name'),
  character: resolve(opt('character')),
  item: { name: opt('item-name') ?? opt('name'), obj: resolve(opt('item')), mirrored: !flag('unmirrored'), style: opt('style') ?? 'gun', forward: vec(opt('forward')), up: vec(opt('up')) },
  hands,
};
const { checks, sheet } = await checkHold(spec, out, review);
R.writeReview(reviewPath, review);
console.log(describe(checks).split('\n').filter((l) => l.startsWith('FAIL')).join('\n') || 'every check passes');
console.log(`sheet: ${sheet}`);
const left = R.blocking(review).filter((b) => !flag('unreviewed') || /fails/.test(b));
if (left.length) {
  console.log(`not done:\n  ${left.join('\n  ')}`);
  process.exit(3);
}
