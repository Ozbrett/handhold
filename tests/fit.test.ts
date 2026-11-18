import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fitPoints } from '../src/core/fit';

describe('fitPoints', () => {
  const from = [new Vector3(0, 0, 0), new Vector3(0.1, 0, 0), new Vector3(0, 0.08, 0.01), new Vector3(0.03, 0.02, 0.09), new Vector3(-0.02, 0.05, 0.04)];

  it('finds a turn and shift exactly', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0.3, -0.8, 0.5).normalize(), 2.4);
    const t = new Vector3(0.5, -1.2, 0.3);
    const to = from.map((p) => p.clone().applyQuaternion(q).add(t));
    const f = fitPoints(from, to)!;
    expect(f.rms).toBeLessThan(1e-9);
    expect(Math.abs(f.scale - 1)).toBeLessThan(1e-9);
    expect(Math.abs(f.rotation.dot(q))).toBeGreaterThan(1 - 1e-9);
    for (let i = 0; i < from.length; i++) expect(from[i].clone().applyMatrix4(f.matrix).distanceTo(to[i])).toBeLessThan(1e-9);
  });

  it('reports the scale between two sets', () => {
    const to = from.map((p) => p.clone().multiplyScalar(0.75).add(new Vector3(1, 2, 3)));
    const f = fitPoints(from, to)!;
    expect(f.scale).toBeCloseTo(0.75, 6);
    expect(f.rms).toBeLessThan(1e-9);
  });

  it('needs three points', () => {
    expect(fitPoints(from.slice(0, 2), from.slice(0, 2))).toBeNull();
  });
});
