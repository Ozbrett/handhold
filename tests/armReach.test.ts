import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { type WristReport, buildArmRig, reachOf, solveArm } from '../src/app/armIk';
import { buildCharacterRig } from '../src/app/characterRig';
import { bakeToTriMesh, looksLikeCharacter, subsetBaked } from '../src/app/loaders';
import { sampleCharacter } from '../src/app/samples';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { locateHands } from '../src/core/hand/locate';

/** The whole arm reaches with the collarbone when it has to, keeps the elbow and forearm out of the body, and says when a target is out of reach instead of faking it. */
function rightArm() {
  const source = sampleCharacter();
  const full = bakeToTriMesh(source);
  const found = locateHands(full.mesh, { character: looksLikeCharacter(source) });
  const h = found.hands.find((x) => x.handedness === 'right')!;
  const baked = subsetBaked(full, h.keep);
  const analysis = analyzeHandMesh(baked.mesh, { flipPalm: h.flip });
  const char = buildCharacterRig(source, full, h.keep, analysis)!;
  return buildArmRig(char, analysis.model.frame)!;
}
const blank = (): WristReport => ({ flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 });

describe('whole-arm reach', () => {
  it('says how far short a target out of reach is, and never puts the hand there', () => {
    const arm = rightArm();
    const far = arm.shoulder.clone().addScaledVector(arm.forward, 2);
    const r = blank();
    solveArm(arm, { position: far, turn: [0, 0, 0] }, r);
    const at = arm.hand.getWorldPosition(new Vector3());
    expect(r.short!).toBeGreaterThan(1);
    expect(at.distanceTo(far)).toBeCloseTo(r.short!, 2);
    const near = blank();
    solveArm(arm, { position: arm.shoulder.clone().addScaledVector(arm.forward, 0.4).add(new Vector3(0, -0.15, 0)), turn: [0, 0, 0] }, near);
    expect(near.short).toBeLessThan(1e-6);
  });

  it('turns the collarbone to reach a little past the arm, and only then', () => {
    const arm = rightArm();
    expect(arm.clavicle?.name).toBe('RightShoulder');
    const max = reachOf(arm).max;
    const just = arm.shoulder.clone().addScaledVector(arm.forward, max + 0.03);
    const r = blank();
    solveArm(arm, { position: just, turn: [0, 0, 0] }, r);
    expect(r.clavicle!).toBeGreaterThan(1);
    expect(r.short!).toBeLessThan(0.002);
    const without = rightArm();
    without.clavicle = null;
    const w = blank();
    solveArm(without, { position: just, turn: [0, 0, 0] }, w);
    expect(w.short!).toBeGreaterThan(0.02);
    const inside = blank();
    solveArm(arm, { position: arm.shoulder.clone().addScaledVector(arm.forward, 0.35), turn: [0, 0, 0] }, inside);
    expect(inside.clavicle).toBe(0);
    // and back at rest after a reach
    solveArm(arm, null);
    expect(arm.clavicle!.quaternion.angleTo(arm.clavicleRest!)).toBeLessThan(1e-6);
  });

  it('keeps the elbow and forearm out of a body it is given, where the plain solve goes through it', () => {
    const arm = rightArm();
    // a hand held low across the belly: the elbow's natural line drops it into a chest put just inside it
    const target = arm.shoulder.clone().addScaledVector(arm.forward, 0.25).addScaledVector(arm.outward, -0.2).add(new Vector3(0, -0.2, 0));
    const plain = blank();
    solveArm(arm, { position: target, turn: [0, 0, 0] }, plain);
    const elbow = arm.fore.getWorldPosition(new Vector3());
    // something in the body put where the plain elbow went
    const lump = { a: elbow.clone(), b: elbow.clone(), radius: 0.02 };
    arm.avoid = [lump];
    const clear = blank();
    solveArm(arm, { position: target, turn: [0, 0, 0] }, clear);
    expect(plain.overlap ?? 0).toBe(0);
    expect(clear.overlap!).toBeLessThan(0.001);
    expect(arm.fore.getWorldPosition(new Vector3()).distanceTo(elbow)).toBeGreaterThan(0.05);
    expect(arm.hand.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(0.002);
  });
});
