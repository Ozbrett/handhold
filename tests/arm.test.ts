import { describe, expect, it } from 'vitest';
import { Bone, Quaternion, Vector3 } from 'three';
import { type HoldPose, WRIST_LIMITS, type WristReport, buildArmRig, clampToReach, defaultHold, mixHold, reachOf, solveArm, wantedTurn } from '../src/app/armIk';
import type { CharacterRig } from '../src/app/characterRig';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { poseMatrices } from '../src/core/hand/model';
import { reachFingertip } from '../src/core/grasp/pin';
import { createProceduralHand } from '../src/core/sample/proceduralHand';

/** A bare T-pose arm: clavicle > upper arm > forearm > hand, pointing along -X. */
function makeArm() {
  const clavicle = new Bone(), upper = new Bone(), fore = new Bone(), hand = new Bone();
  clavicle.position.set(-0.05, 1.4, 0);
  upper.position.set(-0.15, 0, 0);
  fore.position.set(-0.28, 0, 0);
  hand.position.set(-0.26, 0, 0);
  clavicle.add(upper);
  upper.add(fore);
  fore.add(hand);
  clavicle.updateMatrixWorld(true);
  const char = { root: clavicle, handBone: hand } as unknown as CharacterRig;
  return { arm: buildArmRig(char)!, hand, fore, upper };
}

describe('arm inverse kinematics', () => {
  it('finds the arm above the hand bone', () => {
    const { arm } = makeArm();
    expect(arm.upperLength).toBeCloseTo(0.28, 5);
    expect(arm.foreLength).toBeCloseTo(0.26, 5);
    expect(arm.outward.x).toBeLessThan(-0.9);
    expect(arm.forward.z).toBeGreaterThan(0.9);
  });

  it('puts the wrist on a reachable target without changing bone lengths', () => {
    const { arm, hand, fore, upper } = makeArm();
    const target = arm.shoulder.clone().add(new Vector3(-0.05, -0.2, 0.3));
    solveArm(arm, { position: target, turn: [0, 0, 0] });
    const s = upper.getWorldPosition(new Vector3()), e = fore.getWorldPosition(new Vector3()), w = hand.getWorldPosition(new Vector3());
    expect(w.distanceTo(target)).toBeLessThan(1e-5);
    expect(s.distanceTo(e)).toBeCloseTo(0.28, 5);
    expect(e.distanceTo(w)).toBeCloseTo(0.26, 5);
    // the elbow hangs below the line from shoulder to wrist
    expect(e.y).toBeLessThan((s.y + w.y) / 2);
    // and the arm goes back to rest exactly
    solveArm(arm, null);
    expect(hand.getWorldPosition(new Vector3()).distanceTo(arm.wrist)).toBeLessThan(1e-6);
  });

  it('clamps targets the arm cannot reach', () => {
    const { arm, hand } = makeArm();
    const far = arm.shoulder.clone().add(new Vector3(0, 0, 5));
    solveArm(arm, { position: far, turn: [0, 0, 0] });
    const w = hand.getWorldPosition(new Vector3());
    expect(w.distanceTo(arm.shoulder)).toBeCloseTo(reachOf(arm).max, 4);
    expect(clampToReach(arm, far).distanceTo(w)).toBeLessThan(1e-5);
  });

  it('sweeps on an arc around the shoulder, not a straight line', () => {
    const { arm } = makeArm();
    const low = defaultHold(arm);
    const high = { position: arm.shoulder.clone().add(new Vector3(0, 0.3, 0.35)), turn: [0, 0, 40] as [number, number, number] };
    const mid = mixHold(arm, low, high, 0.5);
    const rLow = low.position.distanceTo(arm.shoulder), rHigh = high.position.distanceTo(arm.shoulder);
    expect(mid.position.distanceTo(arm.shoulder)).toBeCloseTo((rLow + rHigh) / 2, 5);
    const straight = low.position.clone().lerp(high.position, 0.5);
    expect(mid.position.distanceTo(straight)).toBeGreaterThan(0.01);
    expect(mid.turn[2]).toBeCloseTo(20, 5);
    expect(mixHold(arm, low, high, 0).position.distanceTo(low.position)).toBeLessThan(1e-6);
    expect(mixHold(arm, low, high, 1).position.distanceTo(high.position)).toBeLessThan(1e-6);
  });
});

describe('wrist turn solved from the held object', () => {
  const report = (): WristReport => ({ flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 });
  const handTurn = (arm: ReturnType<typeof makeArm>['arm']) => {
    arm.upper.updateMatrixWorld(true);
    return arm.hand.getWorldQuaternion(new Quaternion()).multiply(arm.restWorld[2].clone().invert());
  };
  const degreesBetween = (a: Quaternion, b: Quaternion) => (a.angleTo(b) * 180) / Math.PI;

  it('keeps the wrist straight at the starting position', () => {
    const { arm } = makeArm();
    const r = report();
    solveArm(arm, defaultHold(arm), r);
    expect(Math.abs(r.flex) + Math.abs(r.radial) + Math.abs(r.twist) + Math.abs(r.elbow)).toBeLessThan(0.5);
    expect(r.miss).toBeLessThan(0.5);
  });

  it('keeps the object turned the same way when the hand moves', () => {
    const { arm, hand, fore, upper } = makeArm();
    solveArm(arm, defaultHold(arm));
    const start = handTurn(arm);
    const r = report();
    const raised: HoldPose = { position: arm.shoulder.clone().add(new Vector3(0.1, -0.05, 0.4)), turn: [0, 0, 0] };
    solveArm(arm, raised, r);
    expect(degreesBetween(handTurn(arm), start)).toBeLessThan(1);
    expect(r.miss).toBeLessThan(1);
    // the wrist had to do the work, and the arm still reaches the spot with its bones the same length
    expect(Math.abs(r.flex) + Math.abs(r.radial) + Math.abs(r.twist)).toBeGreaterThan(5);
    const s = upper.getWorldPosition(new Vector3()), e = fore.getWorldPosition(new Vector3()), w = hand.getWorldPosition(new Vector3());
    expect(w.distanceTo(raised.position)).toBeLessThan(1e-5);
    expect(s.distanceTo(e)).toBeCloseTo(0.28, 5);
    expect(e.distanceTo(w)).toBeCloseTo(0.26, 5);
  });

  it('turns the object as asked, and reports how far off it is when the arm runs out of range', () => {
    const { arm } = makeArm();
    const at = defaultHold(arm).position;
    for (const turn of [[30, 0, 0], [0, 40, 0], [0, 0, 60], [20, -30, 45], [0, 0, 180], [-90, 180, 0], [60, 90, -120]] as [number, number, number][]) {
      const r = report();
      solveArm(arm, { position: at, turn }, r);
      // the reported miss is what is really left between the hand and the turn asked for
      expect(Math.abs(degreesBetween(handTurn(arm), wantedTurn(arm, turn)) - r.miss)).toBeLessThan(0.5);
      // and the joints stay inside human limits
      const F = r.flex >= 0 ? WRIST_LIMITS.flex : WRIST_LIMITS.extend, R = r.radial >= 0 ? WRIST_LIMITS.radial : WRIST_LIMITS.ulnar;
      expect((r.flex / F) ** 2 + (r.radial / R) ** 2).toBeLessThan(1.001);
      expect(r.twist).toBeGreaterThanOrEqual(-10.01);
      expect(r.twist).toBeLessThanOrEqual(180.01);
      expect(Math.abs(r.elbow)).toBeLessThanOrEqual(90);
    }
    // a modest turn is reached exactly
    const r = report();
    solveArm(arm, { position: at, turn: [20, -30, 25] }, r);
    expect(r.miss).toBeLessThan(1);
    // the object upside down is beyond a wrist held out in front at waist height
    solveArm(arm, { position: at, turn: [180, 0, 0] }, r);
    expect(r.miss).toBeGreaterThan(3);
  });

  it('moves smoothly along a sweep', () => {
    const { arm } = makeArm();
    const low = defaultHold(arm);
    const high: HoldPose = { position: arm.shoulder.clone().add(new Vector3(0, 0.25, 0.4)), turn: [-40, 0, 0] };
    let last: Quaternion | null = null;
    for (let i = 0; i <= 40; i++) {
      solveArm(arm, mixHold(arm, low, high, i / 40));
      const q = arm.fore.getWorldQuaternion(new Quaternion());
      if (last) expect(degreesBetween(q, last)).toBeLessThan(8);
      last = q;
    }
  });
});

describe('fingertip on a spot', () => {
  const model = analyzeHandMesh(createProceduralHand().mesh).model;
  const tipAt = (angles: Float32Array, finger: number) => {
    const f = model.fingers[finger];
    return f.tip.clone().applyMatrix4(poseMatrices(model, angles)[f.joints[f.joints.length - 1]]);
  };

  it('bends the index finger onto a reachable spot and leaves the others alone', () => {
    // a spot the index can reach: where its tip is when half curled
    const half = new Float32Array(model.dofCount);
    for (const j of model.fingers[1].joints) for (const [k, d] of model.joints[j].dofs.entries()) half[model.joints[j].dofStart + k] = d.max * 0.5;
    const target = tipAt(half, 1);
    const start = new Float32Array(model.dofCount);
    const r = reachFingertip(model, start, 1, target);
    expect(r.miss).toBeLessThan(0.004);
    expect(tipAt(r.angles, 1).distanceTo(target)).toBeLessThan(0.004);
    for (const j of model.fingers[2].joints) expect(r.angles[model.joints[j].dofStart]).toBe(0);
  });

  it('reports how far short it falls when the spot is out of reach', () => {
    const far = model.fingers[1].tip.clone().addScaledVector(model.frame.up, 0.2);
    const r = reachFingertip(model, new Float32Array(model.dofCount), 1, far);
    expect(r.miss).toBeGreaterThan(0.15);
  });
});
