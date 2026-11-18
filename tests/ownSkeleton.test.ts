import { Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { type CharacterRig, buildCharacterRig, poseCharacter } from '../src/app/characterRig';
import { buildRiggedHand, setHandPose } from '../src/app/handRig';
import { bakeToTriMesh, looksLikeCharacter, subsetBaked } from '../src/app/loaders';
import { onOwnSkeleton } from '../src/app/ownSkeleton';
import { sampleCharacter } from '../src/app/samples';
import { characterPoseJson } from '../src/app/exporter';
import { buildBody, posedSkin, skinPositions } from '../src/check/body';
import { applyFingerDeltas } from '../src/check/poseFile';
import type { Grasp } from '../src/core/grasp/solver';
import { type HandAnalysis, analyzeHandMesh } from '../src/core/hand/analyze';
import { locateHands } from '../src/core/hand/locate';

/**
 * What is drawn is what is exported: the hand the site draws, clears and reads contacts off must skin exactly like the
 * character's own bones and weights under the pose the export writes, or the game's fingers land somewhere else.
 */
function worstGap(source: ReturnType<typeof sampleCharacter>, baked: ReturnType<typeof subsetBaked>, analysis: HandAnalysis, char: CharacterRig) {
  const rig = buildRiggedHand(baked, analysis);
  const angles = new Float32Array(analysis.model.dofCount);
  // a firm curl of every finger joint, the thumb across
  analysis.model.joints.forEach((j) => j.dofs.forEach((d, k) => (angles[j.dofStart + k] = k === 0 ? Math.min(d.max, 1.1) : 0)));
  setHandPose(rig, { wrist: new Matrix4(), angles });
  poseCharacter(char, analysis.model, angles);
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const own = new Map<string, number[]>();
  source.traverse((o) => {
    const m = o as import('three').SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const rest = m.userData.rest as Float32Array;
    const now = skinPositions(m);
    for (let i = 0; i < now.length / 3; i++) own.set(key(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]), [now[i * 3], now[i * 3 + 1], now[i * 3 + 2]]);
  });
  let worst = 0, n = 0;
  for (const m of rig.meshes) {
    const drawn = skinPositions(m);
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const o = own.get(key(pos.getX(i), pos.getY(i), pos.getZ(i)));
      if (!o) continue;
      n++;
      worst = Math.max(worst, Math.hypot(o[0] - drawn[i * 3], o[1] - drawn[i * 3 + 1], o[2] - drawn[i * 3 + 2]));
    }
  }
  return { worst, n };
}

describe('a character hand on its own skeleton', () => {
  it('draws exactly what the exported bones and the character\'s own weights draw', () => {
    const source = sampleCharacter();
    source.updateMatrixWorld(true);
    source.traverse((o) => {
      const m = o as import('three').SkinnedMesh;
      if (m.isSkinnedMesh) m.userData.rest = skinPositions(m);
    });
    const full = bakeToTriMesh(source);
    const found = locateHands(full.mesh, { character: looksLikeCharacter(source) });
    const h = found.hands[0];
    const baked = subsetBaked(full, h.keep);
    const plain = analyzeHandMesh(baked.mesh, { flipPalm: h.flip });
    const plainChar = buildCharacterRig(source, full, h.keep, plain)!;
    // the solver's own joints and weights: the drawn hand is centimetres off what the game draws
    const before = worstGap(source, baked, plain, plainChar);
    poseCharacter(plainChar, plain.model, null);
    const own = onOwnSkeleton(source, full, h.keep, baked, analyzeHandMesh(baked.mesh, { flipPalm: h.flip }), { flipPalm: h.flip });
    expect(own.pivots).not.toBeNull();
    const after = worstGap(source, baked, own.analysis, own.char!);
    expect(after.n).toBeGreaterThan(200);
    expect(before.worst).toBeGreaterThan(0.002);
    expect(after.worst).toBeLessThan(0.0005);
  });

  it('reads the exported pose file back onto a fresh copy of the character as the same fingers', () => {
    const source = sampleCharacter();
    source.updateMatrixWorld(true);
    const full = bakeToTriMesh(source);
    const h = locateHands(full.mesh, { character: looksLikeCharacter(source) }).hands[0];
    const baked = subsetBaked(full, h.keep);
    const own = onOwnSkeleton(source, full, h.keep, baked, analyzeHandMesh(baked.mesh, { flipPalm: h.flip }), { flipPalm: h.flip });
    const model = own.analysis.model;
    const angles = new Float32Array(model.dofCount);
    model.joints.forEach((j) => j.dofs.forEach((d, k) => (angles[j.dofStart + k] = k === 0 ? Math.min(d.max, 1.1) : 0)));
    const grasp = { wrist: new Matrix4(), angles, contacts: [], stable: true, effort: 1, segmentsTouching: 0, segmentsTotal: 0 } as unknown as Grasp;
    const file = characterPoseJson(own.char!, model, grasp, null, null);
    // what the site posed: the character's own skin under the exported bones
    const key = (a: ArrayLike<number>, i: number) => `${Math.round(a[i * 3] * 1e5)},${Math.round(a[i * 3 + 1] * 1e5)},${Math.round(a[i * 3 + 2] * 1e5)}`;
    const posed = new Map<string, number[]>();
    source.traverse((o) => {
      const m = o as import('three').SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const rest = m.geometry.getAttribute('position').array, now = skinPositions(m);
      for (let i = 0; i < now.length / 3; i++) posed.set(key(rest, i), [now[i * 3], now[i * 3 + 1], now[i * 3 + 2]]);
    });
    // what a reader of the file gets on its own copy
    const body = buildBody(sampleCharacter())!;
    expect(applyFingerDeltas(body, file.bones, file.handBone)).toEqual([]);
    body.root.updateMatrixWorld(true);
    const now = posedSkin(body);
    let worst = 0, moved = 0, n = 0;
    body.skin.forEach((s, pi) => {
      const rest = s.mesh.geometry.getAttribute('position').array;
      for (let i = 0; i < rest.length / 3; i++) {
        const o = posed.get(key(rest, i));
        if (!o) continue;
        n++;
        const d = Math.hypot(o[0] - now[pi][i * 3], o[1] - now[pi][i * 3 + 1], o[2] - now[pi][i * 3 + 2]);
        worst = Math.max(worst, d);
        moved = Math.max(moved, Math.hypot(o[0] - s.rest[i * 3], o[1] - s.rest[i * 3 + 1], o[2] - s.rest[i * 3 + 2]));
      }
    });
    expect(n).toBeGreaterThan(200);
    // the fingers really curled, and the reader's skin lands on the site's to under a millimetre
    expect(moved).toBeGreaterThan(0.02);
    expect(worst).toBeLessThan(0.001);
  });
});
