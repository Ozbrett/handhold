import { describe, expect, it } from 'vitest';
import { BoxGeometry, type BufferGeometry, CylinderGeometry, Matrix4, SphereGeometry, Vector3 } from 'three';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { createProceduralHand } from '../src/core/sample/proceduralHand';
import { GraspObject } from '../src/core/grasp/object';
import { graspSpheres } from '../src/core/grasp/pose';
import { type Grasp, type GraspSettings, solveGrasp } from '../src/core/grasp/solver';
import { solveLP } from '../src/core/grasp/lp';
import { graspQuality } from '../src/core/grasp/quality';
import type { TriMesh } from '../src/core/trimesh';
import type { HandModel } from '../src/core/hand/model';

const VERBOSE = !!process.env.HAND_DEBUG;

function toMesh(g: BufferGeometry): TriMesh {
  const pos = new Float32Array(g.getAttribute('position').array);
  const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array(pos.length / 3).map((_, i) => i);
  return { positions: pos, indices: idx };
}

const hand = analyzeHandMesh(createProceduralHand().mesh).model;

async function grip(mesh: TriMesh, settings: GraspSettings, label: string, model: HandModel = hand) {
  const object = new GraspObject(mesh);
  const t0 = Date.now();
  const grasps = await solveGrasp(model, object, settings);
  if (VERBOSE) {
    console.log(`${label}: ${grasps.length} grips in ${Date.now() - t0} ms, ${object.queries} distance queries`);
    for (const g of grasps)
      console.log(
        `   stable ${g.stable} effort ${g.effort.toFixed(2)} robust ${g.robustness.toFixed(2)} fingers ${g.fingersTouching} thumb ${g.thumbTouching} palm ${g.palmTouching} segments ${g.segmentsTouching}/${g.segmentsTotal} score ${g.score.toFixed(3)} contacts ${g.contacts.length}`,
      );
  }
  return { grasps, object };
}

/** Deepest the hand's collision spheres sink into the object, in metres (positive = penetration). */
function penetration(g: Grasp, object: GraspObject, model: HandModel = hand): number {
  let worst = 0;
  for (const s of graspSpheres(model, g)) {
    const d = object.distance(s.center.x, s.center.y, s.center.z) - s.radius;
    worst = Math.max(worst, -d);
  }
  return worst;
}

describe('linear program', () => {
  it('solves a small problem', () => {
    // minimise x0 + 2 x1 + 3 x2  s.t.  x0 + x1 + x2 = 4,  x0 - x1 = 1
    const r = solveLP([1, 1, 1, 1, -1, 0], [4, 1], [1, 2, 3], 2, 3);
    expect(r.feasible).toBe(true);
    expect(r.value).toBeCloseTo(5.5, 6);
  });
  it('reports infeasible problems', () => {
    const r = solveLP([1, 1], [-1], [1, 1], 1, 2);
    expect(r.feasible).toBe(false);
  });
});

describe('physical grip check', () => {
  const opt = { friction: 0.5, gravity: new Vector3(0, -1, 0), com: new Vector3(), lever: 0.05, mode: 'fixed' as const };
  it('supporting from below needs exactly the weight', () => {
    const contacts = [-1, 1].flatMap((x) =>
      [-1, 1].map((z) => ({ point: new Vector3(x * 0.03, -0.02, z * 0.03), normal: new Vector3(0, -1, 0), finger: 0, link: 0 })),
    );
    const q = graspQuality(contacts, opt);
    expect(q.stable).toBe(true);
    expect(q.effort).toBeCloseTo(1, 3);
  });
  it('pinching from the sides needs weight / friction', () => {
    const contacts = [-1, 1].flatMap((x) =>
      [-1, 1].map((z) => ({ point: new Vector3(x * 0.03, 0, z * 0.02), normal: new Vector3(x, 0, 0), finger: 0, link: 0 })),
    );
    const q = graspQuality(contacts, opt);
    expect(q.stable).toBe(true);
    // friction mu*N per side must carry the weight: total force = sqrt(1 + 1/mu^2)
    expect(q.effort).toBeCloseTo(Math.sqrt(1 + 1 / 0.25), 1);
  });
  it('pressing down from above cannot hold anything', () => {
    const contacts = [-1, 1].map((x) => ({ point: new Vector3(x * 0.03, 0.02, 0), normal: new Vector3(0, 1, 0), finger: 0, link: 0 }));
    expect(graspQuality(contacts, opt).stable).toBe(false);
  });
});

describe('grip solver', () => {
  it('wraps around a horizontal stick', async () => {
    const stick = new CylinderGeometry(0.016, 0.016, 0.3, 24, 8).rotateZ(Math.PI / 2);
    const { grasps, object } = await grip(toMesh(stick), { gripPoint: new Vector3(0, 0.016, 0), gripNormal: new Vector3(0, 1, 0) }, 'horizontal stick');
    expect(grasps.length).toBeGreaterThan(0);
    const g = grasps[0];
    expect(g.stable).toBe(true);
    expect(g.fingersTouching).toBeGreaterThanOrEqual(4);
    // wrapped means the fingers lie along the stick, not only their tips
    expect(g.segmentsTouching).toBeGreaterThanOrEqual(11);
    expect(g.effort).toBeLessThan(1.6);
    expect(penetration(g, object)).toBeLessThan(0.002);
  });

  it('with the hand placed for it, closes the fingers there and may move the hand onto a better hold', async () => {
    const stick = toMesh(new CylinderGeometry(0.016, 0.016, 0.3, 24, 8).rotateZ(Math.PI / 2));
    const free = (await grip(stick, { gripPoint: new Vector3(0, 0.016, 0), gripNormal: new Vector3(0, 1, 0) }, 'free')).grasps[0];
    // a game that put the hand 15 mm too high off the stick
    const wrist = new Matrix4().makeTranslation(0, 0.015, 0).multiply(free.wrist);
    const placed = (await grip(stick, { gripPoint: new Vector3(0, 0.016, 0), gripNormal: new Vector3(0, 1, 0), wrist }, 'placed')).grasps[0];
    const { grasps, object } = await grip(stick, { gripPoint: new Vector3(0, 0.016, 0), gripNormal: new Vector3(0, 1, 0), wrist, adjust: { move: 0.03, turn: 0.2 } }, 'adjusted');
    const adjusted = grasps[0];
    expect(placed.wrist.equals(wrist)).toBe(true);
    expect(adjusted.score).toBeGreaterThanOrEqual(placed.score);
    expect(adjusted.segmentsTouching).toBeGreaterThanOrEqual(placed.segmentsTouching);
    expect(adjusted.stable).toBe(true);
    const moved = new Vector3().setFromMatrixPosition(adjusted.wrist).distanceTo(new Vector3().setFromMatrixPosition(wrist));
    expect(moved).toBeLessThanOrEqual(0.03 * 1.8);
    expect(penetration(adjusted, object)).toBeLessThan(0.003);
  });

  it('holds a vertical stick by friction', async () => {
    const stick = new CylinderGeometry(0.018, 0.018, 0.3, 24, 8);
    const { grasps, object } = await grip(toMesh(stick), { gripPoint: new Vector3(0.018, 0, 0), gripNormal: new Vector3(1, 0, 0) }, 'vertical stick');
    const g = grasps[0];
    expect(g.stable).toBe(true);
    expect(g.fingersTouching).toBeGreaterThanOrEqual(4);
    expect(penetration(g, object)).toBeLessThan(0.002);
  });

  it('carries a box from underneath', async () => {
    const box = new BoxGeometry(0.07, 0.07, 0.07, 4, 4, 4);
    const { grasps, object } = await grip(toMesh(box), { gripPoint: new Vector3(0, -0.035, 0), gripNormal: new Vector3(0, -1, 0) }, 'box from below');
    const g = grasps[0];
    expect(g.stable).toBe(true);
    // the whole flat hand is under the box
    expect(g.segmentsTouching).toBeGreaterThanOrEqual(12);
    expect(g.effort).toBeLessThan(1.3);
    expect(penetration(g, object)).toBeLessThan(0.002);
  });

  it('knows a big ball cannot be held from the side with one hand', async () => {
    const ball = new SphereGeometry(0.2, 48, 32);
    const { grasps } = await grip(toMesh(ball), { gripPoint: new Vector3(0.2, 0, 0), gripNormal: new Vector3(1, 0, 0) }, 'big ball, side');
    expect(grasps.length).toBeGreaterThan(0);
    expect(grasps[0].stable).toBe(false);
  });

  it('can carry the same big ball from below', async () => {
    const ball = new SphereGeometry(0.2, 48, 32);
    const { grasps, object } = await grip(toMesh(ball), { gripPoint: new Vector3(0, -0.2, 0), gripNormal: new Vector3(0, -1, 0) }, 'big ball, below');
    expect(grasps[0].stable).toBe(true);
    // on something far bigger than the hand the fingers still lie along the surface
    expect(grasps[0].segmentsTouching).toBeGreaterThanOrEqual(8);
    expect(penetration(grasps[0], object)).toBeLessThan(0.002);
  });

  it('closes around a small ball', async () => {
    const ball = new SphereGeometry(0.03, 32, 24);
    const { grasps, object } = await grip(toMesh(ball), { gripPoint: new Vector3(0, 0, 0.03), gripNormal: new Vector3(0, 0, 1) }, 'small ball');
    const g = grasps[0];
    expect(g.stable).toBe(true);
    expect(g.fingersTouching).toBeGreaterThanOrEqual(3);
    expect(penetration(g, object)).toBeLessThan(0.002);
  });
});
