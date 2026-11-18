import { Matrix4, Quaternion, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleCharacter } from '../src/app/samples';
import { type Body, buildBody, restPose, setWorld, worldPos } from '../src/check/body';
import { makeItem } from '../src/check/items';
import type { ObjPart } from '../src/check/load';
import { type Check, checkPose, elbowChecks, gripChecks, jointChecks, overlapChecks, palmFrame, sameSkin, skinChecks, wayUpChecks } from '../src/check/poseCheck';
import { posedSkin } from '../src/check/body';

/**
 * Each whole-pose check passes the character standing at rest and fails a pose broken in exactly the way it is there to catch.
 */

let body: Body;
beforeAll(() => {
  body = buildBody(sampleCharacter())!;
});

const by = (checks: Check[], id: string) => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}: ${checks.map((x) => x.id).join(' ')}`);
  return c;
};

/** Turns a bone about a world axis through its own head, by degrees. */
function turn(b: import('three').Bone, axis: Vector3, deg: number) {
  b.updateWorldMatrix(true, false);
  const q = new Quaternion();
  b.matrixWorld.decompose(new Vector3(), q, new Vector3());
  setWorld(b, worldPos(b), new Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180).multiply(q));
  body.root.updateMatrixWorld(true);
}

/** A closed box (outward faces), as a parsed OBJ piece. */
function box(name: string, min: [number, number, number], max: [number, number, number]): ObjPart {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const positions = Float32Array.from([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  const index = Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  return { name, positions, index };
}

describe('whole-pose checks', () => {
  it('pass the character standing at rest', () => {
    restPose(body);
    const bad = checkPose({ body, items: [] }).filter((c) => !c.pass);
    expect(bad.map((c) => `${c.id} ${c.value}`)).toEqual([]);
  });

  it('find the palm facing down at rest on both hands', () => {
    restPose(body);
    for (const s of ['left', 'right'] as const) expect(palmFrame(body, body.limbs[s]!).normal.y).toBeLessThan(-0.8);
  });

  it('fail an elbow bent backwards and pass one bent forwards', () => {
    const l = body.limbs.right!;
    restPose(body);
    turn(l.fore, new Vector3(0, 1, 0), 60);
    const a = jointChecks(body, l);
    restPose(body);
    turn(l.fore, new Vector3(0, 1, 0), -60);
    const b = jointChecks(body, l);
    const [fwd, back] = by(a, 'right.elbow.flex').value > 0 ? [a, b] : [b, a];
    expect(by(fwd, 'right.elbow.hyperextend').pass).toBe(true);
    expect(by(fwd, 'right.elbow.flex').value).toBeCloseTo(60, 0);
    expect(by(back, 'right.elbow.hyperextend').pass).toBe(false);
  });

  it('fail a forearm bent out of the elbow hinge', () => {
    const l = body.limbs.right!;
    restPose(body);
    turn(l.fore, new Vector3(0, 0, 1), 40);
    expect(by(jointChecks(body, l), 'right.elbow.offPlane').pass).toBe(false);
  });

  it('fail a wrist bent past its range and a forearm twisted past its range', () => {
    const l = body.limbs.left!;
    restPose(body);
    const side = palmFrame(body, l).side;
    turn(l.hand, side, 95);
    const a = jointChecks(body, l);
    expect(a.filter((c) => c.id.startsWith('left.wrist.') && (c.id.endsWith('flex') || c.id.endsWith('extend'))).some((c) => !c.pass)).toBe(true);
    restPose(body);
    turn(l.hand, worldPos(l.hand).sub(worldPos(l.fore)), 170);
    const b = jointChecks(body, l);
    expect(by(b, 'left.forearm.supinate').pass && by(b, 'left.forearm.pronate').pass).toBe(false);
    expect(by(b, 'left.wrist.twistAlone').pass).toBe(false);
  });

  it('fail a finger bent sideways, bent back, or curled through itself', () => {
    const l = body.limbs.right!;
    const f = l.fingers.find((x) => x.name === 'middle')!;
    const n = () => palmFrame(body, l).normal;
    restPose(body);
    turn(f.bones[0], n(), 50);
    expect(by(jointChecks(body, l), 'right.finger.side').pass).toBe(false);
    restPose(body);
    const across = palmFrame(body, l).side;
    turn(f.bones[1], across, 140);
    const curl = jointChecks(body, l);
    restPose(body);
    turn(f.bones[1], across, -140);
    const back = jointChecks(body, l);
    expect(by(curl, 'right.finger.flex').pass && by(back, 'right.finger.flex').pass).toBe(false);
    expect(by(curl, 'right.finger.extend').pass && by(back, 'right.finger.extend').pass).toBe(false);
  });

  it('fail an upper arm swung behind the back', () => {
    const l = body.limbs.right!;
    restPose(body);
    // the right arm points along -x; turning it about +y by -80 sends it back (-z)
    turn(l.upper, new Vector3(0, 1, 0), 80);
    const a = by(jointChecks(body, l), 'right.shoulder.back');
    restPose(body);
    turn(l.upper, new Vector3(0, 1, 0), -80);
    const b = by(jointChecks(body, l), 'right.shoulder.back');
    expect([a.pass, b.pass].sort()).toEqual([false, true]);
  });

  it('fail skin torn at a wrist pulled off its arm', () => {
    const l = body.limbs.left!;
    restPose(body);
    expect(skinChecks(body, posedSkin(body)).every((c) => c.pass)).toBe(true);
    l.hand.position.multiplyScalar(1.6);
    body.root.updateMatrixWorld(true);
    expect(by(skinChecks(body, posedSkin(body)), 'left.skin.wrist.tear').pass).toBe(false);
    restPose(body);
  });

  it('fail a hand through the chest, and a hand through the other hand', () => {
    const l = body.limbs.right!;
    restPose(body);
    // the hand put in the middle of the chest
    const chest = worldPos(body.spine[body.spine.length - 1]);
    setWorld(l.hand, chest, l.hand.getWorldQuaternion(new Quaternion()));
    body.root.updateMatrixWorld(true);
    const a = overlapChecks(body, posedSkin(body), []);
    expect(by(a, 'body.handright.in.torso').pass).toBe(false);
    expect(by(a, 'body.handleft.in.torso').pass).toBe(true);
    restPose(body);
    const r = body.limbs.right!, le = body.limbs.left!;
    // both hands brought to the same place in front of the chest
    for (const [limb, sign] of [[r, 1], [le, -1]] as const) {
      turn(limb.upper, new Vector3(0, 1, 0), -80 * sign);
      const at = worldPos(limb.hand);
      setWorld(limb.hand, new Vector3(0, at.y, 0.45), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0).multiply(limb.hand.getWorldQuaternion(new Quaternion())));
    }
    body.root.updateMatrixWorld(true);
    const b = overlapChecks(body, posedSkin(body), []);
    expect(b.find((c) => /handright\.in\.handleft|handleft\.in\.handright/.test(c.id) && !c.pass)).toBeTruthy();
    restPose(body);
  });

  it('fail an item through the body and the body through an item, and an item in an item it does not mate with', () => {
    restPose(body);
    const chest = worldPos(body.spine[body.spine.length - 1]);
    const bar = makeItem('bar', [box('bar', [-0.01, -0.01, -0.3], [0.01, 0.01, 0.3])], { matrix: new Matrix4().makeTranslation(chest.x, chest.y, chest.z) });
    const a = overlapChecks(body, posedSkin(body), [bar]);
    expect(a.find((c) => c.id === 'item.bar.in.torso')?.pass).toBe(false);
    const block = makeItem('block', [box('block', [-0.15, -0.15, -0.15], [0.15, 0.15, 0.15])], { matrix: new Matrix4().makeTranslation(chest.x, chest.y, chest.z) });
    expect(overlapChecks(body, posedSkin(body), [block]).find((c) => c.id === 'item.block.has.torso')?.pass).toBe(false);
    const far = new Matrix4().makeTranslation(0, 1, 2);
    const g = makeItem('gun', [box('frame', [-0.02, -0.05, -0.1], [0.02, 0.05, 0.1])], { matrix: far });
    const m = makeItem('mag', [box('mag', [-0.01, -0.08, -0.02], [0.01, 0.0, 0.02])], { matrix: far });
    expect(overlapChecks(body, posedSkin(body), [g, m]).filter((c) => c.id.startsWith('item.mag.in.gun'))[0].pass).toBe(false);
    const mated = makeItem('mag', [box('mag', [-0.01, -0.08, -0.02], [0.01, 0.0, 0.02])], { matrix: far, mates: ['gun'] });
    expect(overlapChecks(body, posedSkin(body), [g, mated]).some((c) => c.id.startsWith('item.mag.in.gun'))).toBe(false);
    // clear of everything
    expect(overlapChecks(body, posedSkin(body), [g]).every((c) => c.pass)).toBe(true);
  });

  it('find nothing inside a body part that is only in line with its bones, past their ends', () => {
    restPose(body);
    // a block straight on from the right arm's fingertips, well clear of the hand
    const tip = worldPos(body.limbs.right!.hand).clone();
    const out = tip.clone().sub(worldPos(body.limbs.right!.fore)).normalize();
    const at = tip.addScaledVector(out, 0.35);
    const block = makeItem('block', [box('block', [-0.01, -0.01, -0.01], [0.01, 0.01, 0.01])], { matrix: new Matrix4().makeTranslation(at.x, at.y, at.z) });
    const bad = overlapChecks(body, posedSkin(body), [block]).filter((c) => !c.pass);
    expect(bad.map((c) => `${c.id} ${c.value}`)).toEqual([]);
  });

  it('fail wrist skin folded back over itself', () => {
    restPose(body);
    // the hand bent back flat onto the forearm
    const l = body.limbs.left!;
    turn(l.hand, new Vector3(0, 0, 1), 170);
    expect(by(skinChecks(body, posedSkin(body)), 'left.skin.wrist.pinch').pass).toBe(false);
    restPose(body);
  });

  it('fail an elbow pointed in at the chest', () => {
    const l = body.limbs.right!;
    restPose(body);
    expect(by(elbowChecks(body, l), 'right.elbow.in').pass).toBe(true);
    // the arm reaches forward, then rolls so the elbow swings in and up across the chest line
    turn(l.upper, new Vector3(0, 1, 0), -90);
    turn(l.fore, new Vector3(0, 1, 0), 90);
    const S = worldPos(l.upper), W = worldPos(l.hand);
    turn(l.upper, W.clone().sub(S), 0);
    const a = by(elbowChecks(body, l), 'right.elbow.in');
    restPose(body);
    turn(l.upper, new Vector3(0, 1, 0), -90);
    turn(l.fore, new Vector3(0, 1, 0), -90);
    const b = by(elbowChecks(body, l), 'right.elbow.in');
    // one of the two folds swings the elbow in, the other out
    expect([a.pass, b.pass].sort()).toEqual([false, true]);
  });

  it('fail a gun held upside down or pointed back, and never a plain thing', () => {
    restPose(body);
    const parts = [box('frame', [-0.02, -0.05, -0.1], [0.02, 0.05, 0.1])];
    const upright = makeItem('gun', parts, { style: 'gun', matrix: new Matrix4().makeTranslation(0, 1.3, 0.5) });
    expect(wayUpChecks(body, [upright]).every((c) => c.pass)).toBe(true);
    const flipped = makeItem('gun', parts, { style: 'gun', matrix: new Matrix4().makeRotationZ(Math.PI).setPosition(0, 1.3, 0.5) });
    expect(by(wayUpChecks(body, [flipped]), 'item.gun.up').pass).toBe(false);
    const back = makeItem('gun', parts, { style: 'gun', matrix: new Matrix4().makeRotationY(Math.PI).setPosition(0, 1.3, 0.5) });
    expect(by(wayUpChecks(body, [back]), 'item.gun.away').pass).toBe(false);
    expect(wayUpChecks(body, [makeItem('cup', parts, { matrix: new Matrix4().makeRotationZ(Math.PI) })])).toEqual([]);
  });

  it('pass a hand closed round a grip, and fail it open, on the back of the hand, or with the thumb on the fingers\' side', () => {
    const l = body.limbs.right!;
    const place = () => {
      const pf = palmFrame(body, l);
      // a bar across the palm (along the knuckle line), under the roots of the fingers: placed for the grip's measures only (the
      // hand's skin is still a little in it, which is the overlap check's business)
      const c = pf.centre.clone().addScaledVector(pf.normal, 0.02).addScaledVector(pf.along, 0.015);
      const z = pf.side.clone(), y = pf.normal.clone(), x = new Vector3().crossVectors(y, z);
      return new Matrix4().makeBasis(x, y, z).setPosition(c);
    };
    const bar = () => [box('grip', [-0.012, -0.012, -0.06], [0.012, 0.012, 0.06])];
    const curl = (deg: number, thumb = 0) => {
      restPose(body);
      const pf = palmFrame(body, l);
      for (const f of l.fingers) {
        if (f.name === 'thumb') continue;
        for (const b of f.bones) turn(b, pf.side, deg * (l.side === 'right' ? 1 : -1));
      }
      if (thumb) {
        const t = l.fingers.find((f) => f.name === 'thumb')!;
        turn(t.bones[0], pf.along, thumb);
      }
    };
    const grips = [{ side: 'right' as const, item: 'gun', pieces: ['grip'], wrap: ['middle', 'ring', 'pinky'] as ('middle' | 'ring' | 'pinky')[] }];
    // find which way the fingers close (towards the palm)
    let sign = 1;
    {
      curl(60);
      const pf = palmFrame(body, l);
      const tip = worldPos(l.fingers[2].bones[2]);
      restPose(body);
      if (tip.clone().sub(palmFrame(body, l).centre).dot(pf.normal) < 0) sign = -1;
    }
    restPose(body);
    const m = place();
    curl(75 * sign);
    const closed = gripChecks(body, [makeItem('gun', bar(), { matrix: m })], grips);
    restPose(body);
    const open = gripChecks(body, [makeItem('gun', bar(), { matrix: m })], grips);
    const pf = palmFrame(body, l);
    const behind = place().setPosition(pf.centre.clone().addScaledVector(pf.normal, -0.045));
    curl(75 * sign);
    const back = gripChecks(body, [makeItem('gun', bar(), { matrix: behind })], grips);
    const fails = (cs: Check[]) => cs.filter((c) => !c.pass).map((c) => c.id);
    expect(fails(closed).filter((id) => id !== 'right.grip.thumb')).toEqual([]);
    expect(fails(open)).toContain('right.grip.wrap');
    expect(fails(back)).toContain('right.grip.facing');
    // the thumb laid along the fingers and closed with them: round the fingers' way
    curl(75 * sign, 0);
    const pf2 = palmFrame(body, l);
    const t = l.fingers.find((f) => f.name === 'thumb')!;
    const dir = worldPos(t.bones[1]).sub(worldPos(t.bones[0])).normalize();
    const q = new Quaternion().setFromUnitVectors(dir, pf2.along);
    const ax = new Vector3(q.x, q.y, q.z).normalize();
    turn(t.bones[0], ax, (2 * Math.acos(Math.min(1, q.w)) * 180) / Math.PI);
    t.bones.forEach((b, k) => turn(b, pf2.side, (k ? 70 : 10) * sign));
    const wrong = gripChecks(body, [makeItem('gun', bar(), { matrix: m })], grips);
    expect(fails(wrong)).toContain('right.grip.thumb');
  });

  it('measure what is shown against what is exported to the millimetre', () => {
    restPose(body);
    const a = posedSkin(body);
    const b = a.map((x) => Float32Array.from(x));
    expect(sameSkin('truth', 'drawn against exported', a, b).pass).toBe(true);
    b[0][0] += 0.002;
    const c = sameSkin('truth', 'drawn against exported', a, b);
    expect(c.pass).toBe(false);
    expect(c.value).toBeCloseTo(2, 1);
  });
});
