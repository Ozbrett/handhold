import { describe, expect, it } from 'vitest';
import { CylinderGeometry, Vector3 } from 'three';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { createProceduralHand } from '../src/core/sample/proceduralHand';
import { GraspObject } from '../src/core/grasp/object';
import { solveGrasp } from '../src/core/grasp/solver';
import { handOverlap, pairGrasps } from '../src/core/grasp/twoHands';

const hand = analyzeHandMesh(createProceduralHand().mesh).model;

/** A long bar lying along X, like a rifle or a broom handle. */
function bar() {
  const g = new CylinderGeometry(0.018, 0.018, 0.7, 24, 1).rotateZ(Math.PI / 2);
  const mesh = { positions: new Float32Array(g.getAttribute('position').array), indices: new Uint32Array(g.index!.array) };
  return new GraspObject(mesh);
}

describe('two-handed grips', () => {
  it('pairs grips at two points on a long bar without the hands running into each other', async () => {
    const object = bar();
    const settings = (x: number) => ({ gripPoint: new Vector3(x, 0.018, 0), gripNormal: new Vector3(0, 1, 0), maxResults: 6 });
    const a = await solveGrasp(hand, object, settings(-0.16));
    const b = await solveGrasp(hand, object, settings(0.16));
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    const pairs = pairGrasps(hand, a, hand, b, object);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].stable).toBe(true);
    for (const p of pairs) expect(p.overlap).toBeLessThanOrEqual(0.02 * hand.size + 1e-9);
    // together, the two hands hold the bar at least as easily as the best single hand
    const bestSingle = Math.min(...a.filter((g) => g.stable).map((g) => g.effort));
    expect(pairs[0].effort).toBeLessThanOrEqual(bestSingle + 1e-6);
    // the caller can rule pairs out (for example when the second arm cannot reach)
    const none = pairGrasps(hand, a, hand, b, object, { penalty: () => 2 });
    expect(none.length).toBe(0);
  }, 60000);

  it('drops pairs where both hands would be in the same place', async () => {
    const object = bar();
    const s = { gripPoint: new Vector3(0, 0.018, 0), gripNormal: new Vector3(0, 1, 0), maxResults: 3 };
    const a = await solveGrasp(hand, object, s);
    expect(handOverlap(hand, a[0], hand, a[0])).toBeGreaterThan(0.02 * hand.size);
    const pairs = pairGrasps(hand, a, hand, a, object);
    for (const p of pairs) expect(p.a).not.toBe(p.b);
  }, 60000);
});
