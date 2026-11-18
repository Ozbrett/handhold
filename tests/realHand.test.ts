import { describe, expect, it } from 'vitest';
import { CylinderGeometry, Vector3 } from 'three';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { GraspObject } from '../src/core/grasp/object';
import { graspSpheres } from '../src/core/grasp/pose';
import { solveGrasp } from '../src/core/grasp/solver';
import { loadGlbHand } from './helpers/glb';

/**
 * A real, low-poly human hand mesh (the WebXR generic hand, MIT licensed,
 * installed as a dev dependency). Its skeleton is thrown away and used only
 * as ground truth for what the auto-rigger should find.
 */
const base = 'node_modules/@webxr-input-profiles/assets/dist/profiles/generic-hand/';
const truthNames: Record<string, string[]> = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'],
  index: ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal'],
  middle: ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal'],
  ring: ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal'],
  pinky: ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal'],
};

describe('real hand mesh', () => {
  for (const side of ['right', 'left'] as const) {
    it(`auto-rigs the ${side} hand close to its original skeleton`, () => {
      const hand = loadGlbHand(`${base}${side}.glb`);
      const a = analyzeHandMesh(hand.mesh);
      expect(a.model.handedness).toBe(side);
      expect(a.spec.fingers.map((f) => f.name)).toEqual(['thumb', 'index', 'middle', 'ring', 'pinky']);
      for (const f of a.spec.fingers) {
        f.joints.forEach((j, k) => {
          const err = j.distanceTo(hand.joints[truthNames[f.name][k]]);
          // finger joints within 1 cm; the thumb's base joint is a looser convention
          expect(err).toBeLessThan(f.isThumb && k === 0 ? 0.02 : 0.01);
        });
      }
    });
  }

  it('grips a stick with the real hand without cutting into it', async () => {
    const hand = loadGlbHand(`${base}right.glb`);
    const model = analyzeHandMesh(hand.mesh).model;
    const geo = new CylinderGeometry(0.017, 0.017, 0.3, 24, 8);
    const object = new GraspObject({
      positions: new Float32Array(geo.getAttribute('position').array),
      indices: new Uint32Array(geo.index!.array),
    });
    const grasps = await solveGrasp(model, object, { gripPoint: new Vector3(0.017, 0, 0), gripNormal: new Vector3(1, 0, 0) });
    expect(grasps.length).toBeGreaterThan(0);
    const g = grasps[0];
    expect(g.stable).toBe(true);
    expect(g.fingersTouching).toBeGreaterThanOrEqual(4);
    let worst = 0;
    for (const s of graspSpheres(model, g)) worst = Math.max(worst, s.radius - object.distance(s.center.x, s.center.y, s.center.z));
    expect(worst).toBeLessThan(0.002);
  });
});
