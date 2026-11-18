import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildRiggedHand } from '../src/app/handRig';
import type { Baked } from '../src/app/loaders';
import { SkinGuard } from '../src/app/skinGuard';
import { GraspObject } from '../src/core/grasp/object';
import { solveGrasp } from '../src/core/grasp/solver';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import type { TriMesh } from '../src/core/trimesh';
import { loadGlbHand } from './helpers/glb';

/** The real low-poly WebXR hand, rigged by Handhold, drawn with its own skin. */
function realHand() {
  const glb = loadGlbHand('node_modules/@webxr-input-profiles/assets/dist/profiles/generic-hand/right.glb');
  const analysis = analyzeHandMesh(glb.mesh);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(glb.mesh.positions.slice(), 3));
  geo.setIndex(new BufferAttribute(glb.mesh.indices.slice(), 1));
  const mesh = new Mesh(geo, new MeshBasicMaterial());
  const baked: Baked = { mesh: glb.mesh, parts: [{ mesh, start: 0, count: glb.mesh.positions.length / 3 }] };
  return buildRiggedHand(baked, analysis);
}

function graspObject(geo: BufferGeometry, m?: Matrix4): GraspObject {
  if (m) geo.applyMatrix4(m);
  const mesh: TriMesh = { positions: new Float32Array(geo.getAttribute('position').array), indices: new Uint32Array(geo.index!.array) };
  return new GraspObject(mesh);
}

const tol = 0.001;

describe('skin guard', () => {
  const hand = realHand();

  it('a solved grip on a pistol-sized grip has no skin in the grip, and the fingers still rest on it', async () => {
    const object = graspObject(new BoxGeometry(0.03, 0.11, 0.05, 3, 8, 4));
    const grasps = await solveGrasp(hand.model, object, { gripPoint: new Vector3(0.015, 0, 0), gripNormal: new Vector3(1, 0, 0) });
    expect(grasps.length).toBeGreaterThan(0);
    const g = grasps[0];
    const guard = new SkinGuard(hand, object);
    const r = guard.clear(g.wrist, g.angles);
    // the solver's spheres sit inside the skin, so its own grip has skin in the part: the guard is what takes it out
    expect(r.before.worst).toBeGreaterThan(tol);
    expect(r.clear).toBe(true);
    expect(guard.measure(r.wrist, r.angles).worst).toBeLessThanOrEqual(tol);
    // and the hand still holds: the thumb and at least three fingers touch (skin within 2 mm)
    const near = (['thumb', 'index', 'middle', 'ring', 'little'] as const).filter((k) => r.after.gap[k] <= 0.002);
    expect(near).toContain('thumb');
    expect(near.length).toBeGreaterThanOrEqual(4);
  });

  it('a hand put 15 mm into a stick by whoever placed it is moved out and closed on it again', async () => {
    const object = graspObject(new CylinderGeometry(0.017, 0.017, 0.3, 24, 12));
    const grasps = await solveGrasp(hand.model, object, { gripPoint: new Vector3(0.017, 0, 0), gripNormal: new Vector3(1, 0, 0) });
    const g = grasps[0];
    // into the stick: against the way the palm faces
    const palm = hand.model.frame.normal.clone().transformDirection(g.wrist);
    const wrist = new Matrix4().makeTranslation(palm.x * 0.015, palm.y * 0.015, palm.z * 0.015).multiply(g.wrist);
    const guard = new SkinGuard(hand, object);
    const r = guard.clear(wrist, g.angles);
    expect(r.before.depth.palm).toBeGreaterThan(0.005);
    expect(r.clear).toBe(true);
    expect(r.moved).toBeGreaterThan(0.005);
    // out no further than the knuckles need: the palm stays on the stick and the fingers close round it again
    expect(r.after.gap.palm).toBeLessThanOrEqual(0.004);
    const near = (['thumb', 'index', 'middle', 'ring', 'little'] as const).filter((k) => r.after.gap[k] <= 0.002);
    expect(near.length, JSON.stringify(r.after.gap)).toBeGreaterThanOrEqual(3);
  });

  it('a thin bar through a finger between its skin points counts as inside, and is taken out', () => {
    // a 3 mm bar (corners far away, none of them in the finger) across the index finger's first segment, at rest
    const f = hand.model.fingers.find((x) => x.name === 'index')!;
    const a = hand.model.joints[f.joints[0]].position, b = hand.model.joints[f.joints[1]].position;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const along = hand.model.frame.side.clone().normalize();
    const turn = new Matrix4().makeBasis(
      new Vector3().crossVectors(along, hand.model.frame.normal).normalize(),
      hand.model.frame.normal.clone().normalize(),
      along,
    );
    const object = graspObject(new BoxGeometry(0.003, 0.003, 0.2), new Matrix4().makeTranslation(mid.x, mid.y, mid.z).multiply(turn));
    const guard = new SkinGuard(hand, object);
    const rest = new Float32Array(hand.model.dofCount);
    const m = guard.measure(new Matrix4(), rest);
    expect(m.depth.index).toBeGreaterThan(tol);
    const r = guard.clear(new Matrix4(), rest);
    expect(r.clear).toBe(true);
  });
});
