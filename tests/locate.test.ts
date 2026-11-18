import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { locateHands } from '../src/core/hand/locate';
import { createProceduralHand } from '../src/core/sample/proceduralHand';
import type { TriMesh } from '../src/core/trimesh';

function nearestVertex(mesh: TriMesh, p: [number, number, number], from = 0, to = mesh.positions.length / 3): number {
  let best = from, bd = Infinity;
  for (let i = from; i < to; i++) {
    const d = Math.hypot(mesh.positions[i * 3] - p[0], mesh.positions[i * 3 + 1] - p[1], mesh.positions[i * 3 + 2] - p[2]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function merge(a: TriMesh, b: TriMesh, shiftB: [number, number, number]): TriMesh {
  const nA = a.positions.length / 3;
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  for (let i = 0; i < b.positions.length; i += 3) {
    positions[a.positions.length + i] = b.positions[i] + shiftB[0];
    positions[a.positions.length + i + 1] = b.positions[i + 1] + shiftB[1];
    positions[a.positions.length + i + 2] = b.positions[i + 2] + shiftB[2];
  }
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + nA;
  return { positions, indices };
}

describe('finding hands inside bigger models', () => {
  it('treats a lone hand as a hand', () => {
    const r = locateHands(createProceduralHand().mesh);
    expect(r.kind).toBe('hand');
    expect(r.analysis!.spec.fingers.length).toBe(5);
  });

  it('finds both hands in a file that holds a left and a right hand', () => {
    const right = createProceduralHand();
    const left = createProceduralHand({ left: true });
    const both = merge(right.mesh, left.mesh, [-0.3, 0, 0]);
    const r = locateHands(both);
    expect(r.kind).toBe('character');
    expect(r.hands.map((h) => h.handedness).sort()).toEqual(['left', 'right']);
    const nRight = right.mesh.positions.length / 3;
    const rh = r.hands.find((h) => h.handedness === 'right')!;
    // the right hand's mask covers exactly the first mesh
    expect(rh.keep.subarray(0, nRight).every((v) => v === 1)).toBe(true);
    expect(rh.keep.subarray(nRight).every((v) => v === 0)).toBe(true);
  });

  it('finds the hand at the end of a long arm and leaves the arm behind', () => {
    // a hand on a 1.45 m arm stands in for a hand on a body
    const arm = createProceduralHand({ forearm: 1.45, cell: 0.0024 });
    const r = locateHands(arm.mesh, { character: true });
    expect(r.kind).toBe('character');
    expect(r.hands.length).toBe(1);
    const h = r.hands[0];
    expect(h.fingers).toBe(5);
    expect(h.handedness).toBe('right');
    for (const f of arm.truth.fingers) expect(h.keep[nearestVertex(arm.mesh, f.tip)]).toBe(1);
    expect(h.keep[nearestVertex(arm.mesh, [0, -1.4, 0])]).toBe(0);
    let kept = 0;
    for (const v of h.keep) kept += v;
    expect(kept / h.keep.length).toBeLessThan(0.5);
  });

  it('says so when a body has no usable hand', () => {
    // a plain capsule-ish blob: the wrist stub with nothing on it
    const blob = createProceduralHand({ forearm: 0.6, cell: 0.004 });
    const onlyArm: TriMesh = { positions: blob.mesh.positions, indices: blob.mesh.indices.filter((_, i, arr) => {
      const t = i - (i % 3);
      const y = (blob.mesh.positions[arr[t] * 3 + 1] + blob.mesh.positions[arr[t + 1] * 3 + 1] + blob.mesh.positions[arr[t + 2] * 3 + 1]) / 3;
      return y < -0.05;
    }) };
    const r = locateHands(onlyArm, { character: true });
    expect(r.kind).toBe('none');
    expect(r.error).toMatch(/no open hand/i);
  });
});

describe('hollow gloves (an outer and an inner wall)', () => {
  const glove = createProceduralHand({ hollow: 0.002 });

  it('still finds five fingers once, not twice', () => {
    const a = analyzeHandMesh(glove.mesh);
    expect(a.spec.fingers.map((f) => f.name)).toEqual(['thumb', 'index', 'middle', 'ring', 'pinky']);
    expect(a.model.handedness).toBe('right');
    a.spec.fingers.forEach((f, i) => {
      const t = glove.truth.fingers[i];
      expect(f.tip.distanceTo(new Vector3(...t.tip))).toBeLessThan(0.006);
      f.joints.forEach((j, k) => expect(j.distanceTo(new Vector3(...t.joints[k]))).toBeLessThan(0.016));
    });
    // the wrist is at the wrist, not up among the fingers
    expect(a.spec.wrist.y).toBeLessThan(0.03);
  });

  it('moves the inner wall with the finger it is inside', () => {
    const a = analyzeHandMesh(glove.mesh);
    const nOuter = glove.outerVertices!;
    const total = glove.mesh.positions.length / 3;
    a.model.fingers.forEach((f, fi) => {
      const tipBone = f.joints[f.joints.length - 1];
      const tip = glove.truth.fingers[fi].tip;
      for (const [from, to] of [[0, nOuter], [nOuter, total]]) {
        const v = nearestVertex(glove.mesh, tip, from, to);
        expect(a.skinIndices[v * 4]).toBe(tipBone);
        expect(a.skinWeights[v * 4]).toBeGreaterThan(0.9);
      }
    });
  });
});
