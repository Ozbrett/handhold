import { describe, expect, it } from 'vitest';
import { GraspObject } from '../src/core/grasp/object';

/** A wedge: a prism whose bottom and sloping faces meet along the z axis at 17 degrees, sharper than a right angle. */
function wedge(): GraspObject {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0.3, 0, 0, 0, 1, 1, 0, 1, 1, 0.3, 1]);
  const [a0, b0, c0, a1, b1, c1] = [0, 1, 2, 3, 4, 5];
  const indices = new Uint32Array([a0, b0, b1, a0, b1, a1, b0, c0, c1, b0, c1, b1, c0, a0, a1, c0, a1, c1, a0, c0, b0, a1, b1, c1]);
  return new GraspObject({ positions, indices });
}

describe('signed distance at a sharp edge', () => {
  const object = wedge();

  it('a point off a sharp edge is outside, though it lies behind one of the two faces that meet there', () => {
    // all the way round the edge outside the wedge: past 107 degrees the point is behind the bottom face, past 180 behind the sloping one
    for (let deg = 100; deg <= 350; deg += 2) {
      const t = (deg * Math.PI) / 180;
      const d = object.distance(0.5 * Math.cos(t), 0.5 * Math.sin(t), 0.5);
      expect(d, `${deg} degrees round the edge`).toBeGreaterThan(0);
      if (deg >= 107 && deg <= 270) expect(d).toBeCloseTo(0.5, 5);
    }
  });

  it('a point off the sharp corner is outside too, and a point in the wedge is inside', () => {
    expect(object.distance(-1, -0.5, -1)).toBeGreaterThan(0);
    expect(object.distance(-1, 0.2, 2)).toBeGreaterThan(0);
    expect(object.distance(0.8, 0.1, 0.5)).toBeCloseTo(-0.1, 5);
    expect(object.distance(0.3, 0.02, 0.5)).toBeLessThan(0);
  });
});
