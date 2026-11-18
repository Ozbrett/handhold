#!/usr/bin/env node
/**
 * Builds a reload for a gun out of attachments and writes it as a motion file, ready for scripts/motion-check.mjs: the shooting
 * hand stays on the grip; the other hand goes from the gun (or from under the magazine) to the magazine, draws it out, puts it
 * back without letting go, and returns. Two clips are written: the hold (still) and the reload, which starts and ends on it.
 *
 *   node scripts/make-reload.mjs --character <fbx|glb> --gun <obj> --name <name> --out <dir>
 *        --grip right=<pose.json> --mag <pose.json> --mag-pieces <Piece|#n,...>
 *        (--mag-slide <mm> | --mag-rock <deg> [--mag-drop <mm>]) [--support <pose.json>] [--below <m>] [--unmirrored]
 *
 * --mag-slide: the magazine slides straight out along its own length by that much (a pistol).
 * --mag-rock: the magazine rocks forward about its front top corner by that many degrees, and drops --mag-drop (a rifle).
 * The pose files are Handhold pose files of each hand on the gun; the gun OBJ is in the character's space unless --unmirrored.
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { importTs } from './lib/ts.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const need = ['character', 'gun', 'name', 'out', 'grip', 'mag', 'mag-pieces'].filter((k) => !opt(k));
if (need.length || !(opt('mag-slide') || opt('mag-rock'))) {
  console.error(`make-reload: missing ${[...need.map((k) => `--${k}`), ...(opt('mag-slide') || opt('mag-rock') ? [] : ['--mag-slide or --mag-rock'])].join(', ')} (see the top of scripts/make-reload.mjs)`);
  process.exit(1);
}
const { Vector3 } = await import('three');
const { bodyFor } = await importTs('src/check/holdCheck.ts');
const { loadItem } = await importTs('src/check/scene.ts');
const { reloadMotion, longAxis } = await importTs('src/check/reload.ts');
const { writeMotion } = await importTs('src/check/motion.ts');
const pose = (p) => JSON.parse(readFileSync(resolve(p), 'utf8'));
const character = resolve(opt('character'));
const body = await bodyFor(character);
const gun = loadItem({ name: opt('name'), obj: resolve(opt('gun')), mirrored: !args.includes('--unmirrored'), style: 'gun' });
const pieces = opt('mag-pieces').split(',');
const [side, gripPose] = [opt('grip').split('=')[0], opt('grip').split('=').slice(1).join('=')];
const down = longAxis(gun, pieces);
let out;
if (opt('mag-slide')) out = { slide: down.clone().multiplyScalar(Number(opt('mag-slide')) / 1000) };
else {
  // the front top corner of the magazine: where it hooks into the gun
  let best = null;
  gun.pieces.forEach((p, i) => {
    if (!pieces.includes(p.name) && !pieces.includes(`#${i}`)) return;
    for (let k = 0; k < p.positions.length; k += 3) {
      const v = new Vector3(p.positions[k], p.positions[k + 1], p.positions[k + 2]);
      const s = v.dot(gun.forward) + v.dot(gun.up);
      if (!best || s > best.s) best = { s, v };
    }
  });
  const axis = new Vector3().crossVectors(gun.up, gun.forward).normalize();
  out = { pivot: best.v, axis, deg: Number(opt('mag-rock')), slide: gun.up.clone().multiplyScalar(-Number(opt('mag-drop') ?? 30) / 1000) };
}
const spec = {
  name: opt('name'),
  gun,
  grip: { side, pose: pose(gripPose) },
  support: opt('support') ? pose(opt('support')) : undefined,
  mag: { pose: pose(opt('mag')), pieces, out },
  below: opt('below') ? Number(opt('below')) : undefined,
};
const { items, clips } = reloadMotion(body, spec);
const path = writeMotion(resolve(opt('out')), body, character, items, clips);
console.log(`motion: ${path} (${clips.map((c) => `${c.name} ${c.frames.length} frames`).join(', ')})`);
