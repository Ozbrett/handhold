import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { graspQuality, type Contact } from '../src/core/grasp/quality';

/** Contacts round a vertical bar of radius r at heights hs, k per ring, a fraction `arc` of the way round. */
function wrap(r: number, hs: number[], k: number, arc: number): Contact[] {
  const out: Contact[] = [];
  for (const h of hs)
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2 * arc;
      const n = new Vector3(Math.cos(a), 0, Math.sin(a));
      out.push({ point: n.clone().multiplyScalar(r).setY(h), normal: n, finger: i % 5, link: 0 });
    }
  return out;
}

describe('a hand wrapped round a bar', () => {
  const opt = { friction: 0.6, gravity: new Vector3(0, -1, 0), com: new Vector3(0, 0.1, 0), lever: 0.1, mode: 'fixed' as const };
  for (const n of [6, 12, 24, 40]) {
    it(`holds a vertical bar with ${n} contacts all round`, () => {
      const q = graspQuality(wrap(0.02, [0, 0.02], n / 2, 1), opt);
      expect(q.stable).toBe(true);
      expect(q.effort).toBeLessThan(6);
    });
  }
  it('does not hold a bar touched on one side only', () => {
    // a quarter of the way round: nothing pushes back against the fingers, so the bar slides out of the hand
    const q = graspQuality(wrap(0.02, [0, 0.02], 6, 0.25), opt);
    expect(q.stable).toBe(false);
  });
});
