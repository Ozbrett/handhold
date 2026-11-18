import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleCharacter } from '../src/app/samples';
import { ease, keyed } from '../src/check/attach';
import { type Body, type Side, buildBody, restQuat, worldPos } from '../src/check/body';
import { makeItem } from '../src/check/items';
import type { ObjPart } from '../src/check/load';
import { type LoadedMotion, type MotionFile, checkClip, loadMotion, poseFrame, writeMotion } from '../src/check/motion';
import type { PoseFile } from '../src/check/poseFile';
import { reloadMotion } from '../src/check/reload';

/**
 * A reload built from attachments on the sample player passes every check frame by frame, reads back the same through a
 * Unity-axes file, and the same motion broken three ways (a hand that lets go, an elbow through the chest, a gun upside down)
 * fails on exactly that.
 */

let body: Body;
let dir: string;
let good: string;
beforeAll(() => {
  body = buildBody(sampleCharacter())!;
  dir = mkdtempSync(join(tmpdir(), 'handhold-motion-'));
  const { items, clips } = reloadMotion(body, spec());
  good = writeMotion(join(dir, 'good'), body, 'sample', items, clips);
  writeMotion(join(dir, 'unity'), body, 'sample', items, clips, 'unity');
});

function box(name: string, min: [number, number, number], max: [number, number, number]): ObjPart {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const positions = Float32Array.from([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  return { name, positions, index: Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])) };
}

/**
 * A hand on the gun with its fingers pointing ahead, in line with the forearm: beside it with the palm turned in to face it, or
 * rolled `under` (0..1) toward palm up, cupping the magazine's base from below and the side.
 */
function handPose(side: Side, at: Vector3, under = 0): PoseFile {
  const hand = body.limbs[side]!.hand;
  // at rest the sample's fingers point out along the arm (right: -x, left: +x) with the palm down; here they point ahead (+z)
  // with the palm facing the gun's middle
  const s = side === 'right' ? 1 : -1;
  const beside = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 0, -s), new Vector3(-s, 0, 0), new Vector3(0, 1, 0)));
  const up = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 0, -s), new Vector3(0, -1, 0), new Vector3(-s, 0, 0)));
  const turn = beside.slerp(up, under);
  const inItem = new Matrix4().compose(at, turn.multiply(restQuat(body, hand)), new Vector3(1, 1, 1));
  const p = new Vector3(), q = new Quaternion();
  inItem.invert().decompose(p, q, new Vector3());
  return { format: 'handhold-pose', handedness: side, handBone: hand.name, bones: [], objectAtRest: null, objectInHandBone: { position: p.toArray(), quaternion: q.toArray(), scale: [1, 1, 1] } };
}

function spec() {
  const gun = makeItem('gun', [box('frame', [-0.015, -0.02, -0.1], [0.015, 0.03, 0.1]), box('mag', [-0.01, -0.11, -0.02], [0.01, -0.02, 0.02])], { style: 'gun' });
  return {
    name: 'reload',
    gun,
    grip: { side: 'right' as const, pose: handPose('right', new Vector3(-0.065, 0.005, -0.09)) },
    mag: { pose: handPose('left', new Vector3(0.035, -0.125, -0.08), 0.5), pieces: ['mag'], out: { slide: new Vector3(0, -0.06, 0) } },
  };
}

const fails = (m: LoadedMotion, name: string) => checkClip(m, m.file.clips.find((c) => c.name === name)!).filter((c) => !c.pass);
const ids = (cs: { id: string; value: number; frame?: number }[]) => cs.map((c) => `${c.id} ${c.value} @${c.frame}`);

/** The good motion with its frames changed by `edit`, written beside it, loaded. */
async function broken(name: string, edit: (f: MotionFile) => void): Promise<LoadedMotion> {
  const f = JSON.parse(readFileSync(good, 'utf8')) as MotionFile;
  edit(f);
  const d = join(dir, 'good');
  const path = join(d, `${name}.json`);
  writeFileSync(path, JSON.stringify(f));
  return loadMotion(path, body);
}

describe('animations with attachments', () => {
  it('ease from still to still', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    // no speed at either end: the first and last steps are tiny next to the middle one
    expect(ease(0.01) / 0.01).toBeLessThan(0.01);
    expect((1 - ease(0.99)) / 0.01).toBeLessThan(0.01);
    const k = [{ t: 0, offset: new Matrix4() }, { t: 1, offset: new Matrix4().makeTranslation(0, -0.1, 0) }];
    expect(new Vector3().setFromMatrixPosition(keyed(k, 0.5)).y).toBeCloseTo(-0.05, 6);
  });

  it('build a reload that passes every check on every frame', async () => {
    const m = await loadMotion(good, body);
    expect(m.fit.rms).toBeLessThan(1e-4);
    expect(ids(fails(m, 'reload_hold'))).toEqual([]);
    expect(ids(fails(m, 'reload'))).toEqual([]);
    // the magazine really moves, and the left hand with it
    const clip = m.file.clips.find((c) => c.name === 'reload')!;
    const at = (t: number) => clip.frames.findIndex((f) => f.t >= t - 1e-6);
    poseFrame(m, clip, at(0.5));
    const mag0 = new Vector3().setFromMatrixPosition(m.items[1].matrix), hand0 = worldPos(body.limbs.left!.hand);
    poseFrame(m, clip, at(0.9));
    const mag1 = new Vector3().setFromMatrixPosition(m.items[1].matrix), hand1 = worldPos(body.limbs.left!.hand);
    expect(mag0.distanceTo(mag1)).toBeGreaterThan(0.05);
    expect(hand1.clone().sub(hand0).distanceTo(mag1.clone().sub(mag0))).toBeLessThan(0.001);
  }, 300000);

  it('read a Unity-axes file back to the same pose', async () => {
    const a = await loadMotion(good, body);
    const b = await loadMotion(join(dir, 'unity', 'motion.json'), body);
    const clip = (m: LoadedMotion) => m.file.clips.find((c) => c.name === 'reload')!;
    for (const f of [0, 15, 30]) {
      poseFrame(a, clip(a), f);
      const pa = body.bones.map((x) => worldPos(x)), ga = a.items.map((x) => new Vector3().setFromMatrixPosition(x.matrix));
      poseFrame(b, clip(b), f);
      const pb = body.bones.map((x) => worldPos(x)), gb = b.items.map((x) => new Vector3().setFromMatrixPosition(x.matrix));
      expect(Math.max(...pa.map((p, i) => p.distanceTo(pb[i])))).toBeLessThan(0.001);
      expect(Math.max(...ga.map((p, i) => p.distanceTo(gb[i])))).toBeLessThan(0.001);
    }
  }, 120000);

  it('fail a hand that lets go of the magazine', async () => {
    const m = await broken('letgo', (f) => {
      const c = f.clips.find((x) => x.name === 'reload')!;
      // from 0.8 s the left arm goes back to where it waited, while the clip still says it holds the magazine
      const left = f.bones.map((n, i) => (/left/i.test(n) ? i : -1)).filter((i) => i >= 0);
      for (const fr of c.frames) if (fr.t >= 0.8 && fr.t <= 1.5) for (const i of left) fr.bones[i] = c.frames[0].bones[i];
    });
    expect(fails(m, 'reload').map((c) => c.id)).toContain('contact.left.gun_mag');
  }, 300000);

  it('fail an elbow through the chest', async () => {
    const m = await broken('elbow', (f) => {
      const i = f.bones.findIndex((n) => n === body.limbs.right!.upper.name);
      const swing = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (120 * Math.PI) / 180);
      for (const fr of f.clips.find((x) => x.name === 'reload')!.frames) {
        const b = fr.bones[i];
        fr.bones[i] = [b[0], b[1], b[2], ...swing.clone().multiply(new Quaternion(b[3], b[4], b[5], b[6])).toArray()];
      }
    });
    expect(fails(m, 'reload').some((c) => /^body\.(upperarm|forearm)right\.in\.torso$/.test(c.id))).toBe(true);
  }, 300000);

  it('fail a gun held upside down', async () => {
    const m = await broken('upside', (f) => {
      const roll = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
      for (const fr of f.clips.find((x) => x.name === 'reload')!.frames) {
        const g = fr.items[0]!;
        fr.items[0] = [g[0], g[1], g[2], ...new Quaternion(g[3], g[4], g[5], g[6]).multiply(roll).toArray()];
      }
    });
    expect(fails(m, 'reload').map((c) => c.id)).toContain('item.gun.up');
  }, 300000);
});
