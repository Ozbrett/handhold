import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { createProceduralHand, type ProceduralHandTruth } from '../src/core/sample/proceduralHand';
import type { TriMesh } from '../src/core/trimesh';
import type { HandAnalysis } from '../src/core/hand/analyze';

const VERBOSE = !!process.env.HAND_DEBUG;

function transformMesh(mesh: TriMesh, m: Matrix4): TriMesh {
  const out = new Float32Array(mesh.positions.length);
  const v = new Vector3();
  for (let i = 0; i < out.length; i += 3) {
    v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return { positions: out, indices: mesh.indices };
}

/** Compare detected joints with the known joints; returns the worst error in metres (after undoing m). */
function compare(a: HandAnalysis, truth: ProceduralHandTruth, m = new Matrix4(), label = '') {
  const inv = m.clone().invert();
  const scale = new Vector3().setFromMatrixScale(m).x;
  let worstJoint = 0, worstTip = 0, worstRadius = 0;
  expect(a.spec.fingers.length).toBe(truth.fingers.length);
  if (truth.fingers.length === 5) expect(a.spec.fingers.map((f) => f.name)).toEqual(truth.fingers.map((f) => f.name));
  a.spec.fingers.forEach((f, i) => {
    const t = truth.fingers[i];
    const errs = f.joints.map((j, k) => j.clone().applyMatrix4(inv).distanceTo(new Vector3(...t.joints[k])));
    const tipErr = f.tip.clone().applyMatrix4(inv).distanceTo(new Vector3(...t.tip));
    const rErr = f.radii.map((r, k) => Math.abs(r / scale - t.radii[k]));
    worstJoint = Math.max(worstJoint, ...errs);
    worstTip = Math.max(worstTip, tipErr);
    worstRadius = Math.max(worstRadius, ...rErr.slice(f.isThumb ? 1 : 0));
    if (VERBOSE)
      console.log(
        label,
        f.name.padEnd(7),
        'joint err mm',
        errs.map((e) => (e * 1000).toFixed(1)).join(' '),
        '| tip',
        (tipErr * 1000).toFixed(1),
        '| radius mm',
        f.radii.map((r) => ((r / scale) * 1000).toFixed(1)).join(' '),
        'true',
        t.radii.map((r) => (r * 1000).toFixed(1)).join(' '),
      );
  });
  return { worstJoint, worstTip, worstRadius };
}

describe('auto-rigging a bare hand mesh', () => {
  const hand = createProceduralHand();

  it('finds five fingers, the thumb and the joints of a right hand', () => {
    const a = analyzeHandMesh(hand.mesh);
    if (VERBOSE) console.log('verts', hand.mesh.positions.length / 3, 'warnings', a.warnings, 'conf', a.palmConfidence);
    const r = compare(a, hand.truth, undefined, 'right');
    expect(a.model.handedness).toBe('right');
    expect(a.spec.normal.dot(new Vector3(0, 0, 1))).toBeGreaterThan(0.95);
    expect(a.spec.up.dot(new Vector3(0, 1, 0))).toBeGreaterThan(0.95);
    expect(r.worstTip).toBeLessThan(0.004);
    expect(r.worstJoint).toBeLessThan(0.012);
    expect(r.worstRadius).toBeLessThan(0.002);
    expect(a.model.spheres.filter((s) => s.finger < 0).length).toBeGreaterThan(8);
  });

  it('gives the same answer for any orientation and unit scale', () => {
    const m = new Matrix4().compose(
      new Vector3(12, -40, 7),
      new Quaternion().setFromAxisAngle(new Vector3(0.3, -0.8, 0.52).normalize(), 2.1),
      new Vector3(100, 100, 100),
    );
    const a = analyzeHandMesh(transformMesh(hand.mesh, m));
    const r = compare(a, hand.truth, m, 'rotated');
    expect(a.model.handedness).toBe('right');
    expect(r.worstJoint).toBeLessThan(0.012);
  });

  it('recognises a left hand', () => {
    const left = createProceduralHand({ left: true });
    const a = analyzeHandMesh(left.mesh);
    const r = compare(a, left.truth, undefined, 'left');
    expect(a.model.handedness).toBe('left');
    expect(a.spec.normal.dot(new Vector3(0, 0, 1))).toBeGreaterThan(0.95);
    expect(r.worstJoint).toBeLessThan(0.012);
  });

  it('handles a four-fingered cartoon hand and a forearm', () => {
    const toon = createProceduralHand({ fingerCount: 4, forearm: 0.12 });
    const a = analyzeHandMesh(toon.mesh);
    const r = compare(a, toon.truth, undefined, 'toon');
    expect(a.spec.fingers.length).toBe(4);
    expect(r.worstJoint).toBeLessThan(0.014);
  });

  it('copes with an open wrist and with unwelded triangle soup (as in STL files)', () => {
    // cut the wrist cap off, leaving a hole, and give every triangle its own three vertices
    const src = hand.mesh;
    const pos: number[] = [];
    for (let t = 0; t < src.indices.length; t += 3) {
      const ids = [src.indices[t], src.indices[t + 1], src.indices[t + 2]];
      const cy = (src.positions[ids[0] * 3 + 1] + src.positions[ids[1] * 3 + 1] + src.positions[ids[2] * 3 + 1]) / 3;
      if (cy < -0.026) continue;
      for (const i of ids) pos.push(src.positions[i * 3], src.positions[i * 3 + 1], src.positions[i * 3 + 2]);
    }
    const soup: TriMesh = { positions: new Float32Array(pos), indices: new Uint32Array(pos.length / 3).map((_, i) => i) };
    const a = analyzeHandMesh(soup);
    const r = compare(a, hand.truth, undefined, 'open soup');
    expect(a.model.handedness).toBe('right');
    expect(r.worstJoint).toBeLessThan(0.014);
    expect(a.skinWeights.length).toBe((pos.length / 3) * 4);
  });

  it('produces normalised skin weights that follow the fingers', () => {
    const a = analyzeHandMesh(hand.mesh);
    const n = hand.mesh.positions.length / 3;
    const tipBone = a.model.fingers[1].joints[2];
    const tip = a.spec.fingers[1].tip;
    let nearest = 0, nd = Infinity;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a.skinWeights[i * 4 + k];
      expect(Math.abs(s - 1)).toBeLessThan(1e-4);
      const d = Math.hypot(
        hand.mesh.positions[i * 3] - tip.x,
        hand.mesh.positions[i * 3 + 1] - tip.y,
        hand.mesh.positions[i * 3 + 2] - tip.z,
      );
      if (d < nd) {
        nd = d;
        nearest = i;
      }
    }
    expect(a.skinIndices[nearest * 4]).toBe(tipBone);
    expect(a.skinWeights[nearest * 4]).toBeGreaterThan(0.95);
  });
});
