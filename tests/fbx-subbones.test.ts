import { Bone, BufferGeometry, Group, Matrix4, MeshBasicMaterial, Skeleton, SkinnedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { mergeSubBones } from '../src/app/loaders';

/** A character in two meshes as three's FBXLoader leaves it: the second mesh's hand is a no-offset copy hung under the first's. */
function twoMeshArm() {
  const root = new Group();
  const upper = new Bone(); upper.name = 'upperarm_r';
  const fore = new Bone(); fore.name = 'lowerarm_r'; fore.position.set(0, 0.25, 0);
  const hand = new Bone(); hand.name = 'hand_r'; hand.position.set(0, 0.26, 0);
  const copy = new Bone(); copy.name = 'hand_r';
  const finger = new Bone(); finger.name = 'index_01_r'; finger.position.set(0, 0.08, 0);
  root.add(upper); upper.add(fore); fore.add(hand); hand.add(copy); copy.add(finger);
  root.updateMatrixWorld(true);
  const body = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  body.bind(new Skeleton([upper, fore, hand]), new Matrix4());
  const gloves = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  gloves.bind(new Skeleton([copy, finger]), new Matrix4());
  root.add(body, gloves);
  return { root, hand, fore, finger, gloves };
}

describe('FBX sub-bones', () => {
  it('folds a no-offset copy into the bone it copies, so the hand sits on the forearm', () => {
    const { root, hand, fore, finger, gloves } = twoMeshArm();
    expect(mergeSubBones(root)).toBe(1);
    expect(hand.children.filter((c) => (c as Bone).isBone)).toEqual([finger]);
    expect(finger.parent).toBe(hand);
    expect(hand.parent).toBe(fore);
    expect(gloves.skeleton.bones[0]).toBe(hand);
  });

  it('leaves a bone that only shares a name with its parent but sits apart from it', () => {
    const { root, hand } = twoMeshArm();
    const twist = new Bone(); twist.name = 'hand_r'; twist.position.set(0, 0.02, 0);
    hand.add(twist);
    mergeSubBones(root);
    expect(twist.parent).toBe(hand);
  });
});
