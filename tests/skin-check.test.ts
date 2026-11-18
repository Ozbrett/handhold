import { Bone, BufferGeometry, Float32BufferAttribute, Group, Matrix4, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FOLLOW_COLOURS, followColours, mainChild, turnWrist } from '../src/app/skinCheck';

/** An arm along +y: upper arm, forearm, hand with one finger, and a twist bone on the forearm with nothing under it. */
function arm() {
  const root = new Group();
  const upper = new Bone(); upper.name = 'upperarm';
  const fore = new Bone(); fore.name = 'forearm'; fore.position.set(0, 0.3, 0);
  const twist = new Bone(); twist.name = 'forearm_twist'; twist.position.set(0, 0.1, 0);
  const hand = new Bone(); hand.name = 'hand'; hand.position.set(0, 0.25, 0);
  const finger = new Bone(); finger.name = 'finger'; finger.position.set(0, 0.08, 0);
  root.add(upper); upper.add(fore); fore.add(twist, hand); hand.add(finger);
  root.updateMatrixWorld(true);
  return { root, upper, fore, hand, finger, twist };
}

describe('skin check', () => {
  it('follows the arm through its hand, not the twist bone', () => {
    const { fore, hand } = arm();
    expect(mainChild(fore)).toBe(hand);
  });

  it('colours a vertex on a finger red, one on the forearm blue, and a half-and-half one between', () => {
    const { root, upper, fore, hand, finger } = arm();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Array(9).fill(0), 3));
    g.setAttribute('skinIndex', new Uint16BufferAttribute([3, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0], 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0], 4));
    const mesh = new SkinnedMesh(g, new MeshBasicMaterial());
    mesh.bind(new Skeleton([upper, fore, hand, finger]), new Matrix4());
    root.add(mesh);
    const c = followColours(mesh, [{ upper, fore, hand }]);
    expect([...c.slice(0, 3)]).toEqual(FOLLOW_COLOURS.hand.map((x) => Math.fround(x)));
    expect([...c.slice(3, 6)]).toEqual(FOLLOW_COLOURS.fore.map((x) => Math.fround(x)));
    expect(c[6]).toBeCloseTo((FOLLOW_COLOURS.fore[0] + FOLLOW_COLOURS.hand[0]) / 2, 5);
  });

  it('rolls the hand about the forearm without moving the wrist or the forearm', () => {
    const { upper, fore, hand, finger } = arm();
    const wrist0 = hand.getWorldPosition(new Vector3());
    const fore0 = fore.getWorldQuaternion(new Quaternion());
    turnWrist({ upper, fore, hand }, 90, 0);
    expect(hand.getWorldPosition(new Vector3()).distanceTo(wrist0)).toBeLessThan(1e-6);
    expect(fore.getWorldQuaternion(new Quaternion()).angleTo(fore0)).toBeLessThan(1e-6);
    // the finger lies along the forearm's line, so a pure roll leaves it there
    expect(finger.getWorldPosition(new Vector3()).distanceTo(new Vector3(0, 0.63, 0))).toBeLessThan(1e-6);
    expect(hand.getWorldQuaternion(new Quaternion()).angleTo(new Quaternion())).toBeCloseTo(Math.PI / 2, 5);
  });

  it('bends the hand across the wrist: the finger leaves the forearm line by the bend', () => {
    const { upper, fore, hand, finger } = arm();
    turnWrist({ upper, fore, hand }, 0, 60);
    const wrist = hand.getWorldPosition(new Vector3());
    const way = finger.getWorldPosition(new Vector3()).sub(wrist).normalize();
    expect((Math.acos(way.dot(new Vector3(0, 1, 0))) * 180) / Math.PI).toBeCloseTo(60, 4);
  });
});
