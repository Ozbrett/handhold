import { type Bone, Matrix4, Quaternion, Vector3 } from 'three';
import { type Body, key, restQuat, setWorld, worldPos } from './body';

/**
 * Reading a Handhold pose file (docs/pose-format.md) back onto a character the way an engine does: each finger bone is given its
 * turn from rest in the model's space (`delta`), and the held thing goes where `objectInHandBone` puts it under the hand bone.
 * This is the far end of the round trip: what it draws is what the game draws.
 */

export interface PoseFileBone {
  name: string;
  restQuaternion: number[];
  quaternion: number[];
  delta: number[];
  position?: number[];
}

export interface PoseFile {
  format: string;
  handedness: 'left' | 'right';
  handBone: string;
  bones: PoseFileBone[];
  objectAtRest: { position: number[]; quaternion: number[]; scale: number[] } | null;
  objectInHandBone: { position: number[]; quaternion: number[]; scale: number[] } | null;
  secondHand?: { handBone: string; bones: PoseFileBone[] } | null;
  [k: string]: unknown;
}

export function findBone(body: Body, name: string): Bone | null {
  const k = key(name);
  return body.bones.find((b) => key(b.name) === k) ?? null;
}

/** Gives every finger bone the file names its turn from rest (parents first, so a child's world turn is exact). Returns names not found. */
export function applyFingerDeltas(body: Body, bones: PoseFileBone[]): string[] {
  const missing: string[] = [];
  const found = bones.map((pb) => ({ pb, b: findBone(body, pb.name) }));
  // parents before children
  const depth = (b: Bone) => { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; };
  found.sort((a, b) => (a.b ? depth(a.b) : 0) - (b.b ? depth(b.b) : 0));
  for (const { pb, b } of found) {
    if (!b) { missing.push(pb.name); continue; }
    const q = new Quaternion().fromArray(pb.delta).multiply(restQuat(body, b));
    setWorld(b, worldPos(b), q);
  }
  return missing;
}

/** The held thing's world matrix for the hand bone as it is posed now, from the file's `objectInHandBone`. */
export function itemFromHand(body: Body, pose: PoseFile): Matrix4 | null {
  const hand = findBone(body, pose.handBone);
  const o = pose.objectInHandBone;
  if (!hand || !o) return null;
  hand.updateWorldMatrix(true, false);
  const local = new Matrix4().compose(new Vector3().fromArray(o.position), new Quaternion().fromArray(o.quaternion), new Vector3().fromArray(o.scale));
  return hand.matrixWorld.clone().multiply(local);
}

/** The hand bone's matrix in the held thing's own space (what a hold keeps fixed while the item moves). */
export function handInItem(pose: PoseFile): Matrix4 | null {
  const o = pose.objectInHandBone;
  if (!o) return null;
  return new Matrix4().compose(new Vector3().fromArray(o.position), new Quaternion().fromArray(o.quaternion), new Vector3().fromArray(o.scale)).invert();
}
