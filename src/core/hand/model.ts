import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * The solver's view of a hand: a wrist, finger chains with hinge joints,
 * and collision spheres that fill the mesh ("inflated" from the bones until
 * they touch the skin). Everything is expressed in the hand's rest space,
 * i.e. the coordinates the hand mesh was loaded in.
 */

export type DofKind = 'flex' | 'abduct' | 'spread';

export interface JointDof {
  /** Unit rotation axis in rest space. Positive angles close the hand. */
  axis: Vector3;
  kind: DofKind;
  /** Limits in radians, relative to the rest pose (rest = 0). */
  min: number;
  max: number;
  /** Angle of the open pose the hand approaches the object with. */
  open: number;
  /** Angle at full closure. */
  closed: number;
}

export interface HandJoint {
  name: string;
  /** Rest-space pivot. */
  position: Vector3;
  /** Parent joint index, -1 for the wrist. */
  parent: number;
  dofs: JointDof[];
  /** Index of this joint's first angle in a pose array. */
  dofStart: number;
}

export interface HandFinger {
  name: string;
  isThumb: boolean;
  /** Joint indices from the base to the last joint before the tip. */
  joints: number[];
  /** Rest-space fingertip. */
  tip: Vector3;
  /** Capsule radius of each segment (joint -> next joint or tip). */
  radii: number[];
}

export interface CollisionSphere {
  center: Vector3;
  radius: number;
  /** Joint this sphere moves with (0 = wrist / palm). */
  joint: number;
  /** Finger index, or -1 for the palm. */
  finger: number;
  /** Segment index along the finger (0 = closest to the palm), -1 for the palm. */
  link: number;
}

export interface HandFrame {
  /** Centre of the palm, on the palm-side skin. */
  origin: Vector3;
  /** Wrist -> fingers. */
  up: Vector3;
  /** Out of the palm (the direction the palm faces). */
  normal: Vector3;
  /** Across the palm, towards the thumb. */
  side: Vector3;
  palmLength: number;
  palmWidth: number;
}

export interface HandModel {
  joints: HandJoint[];
  fingers: HandFinger[];
  spheres: CollisionSphere[];
  frame: HandFrame;
  handedness: 'left' | 'right';
  /** Wrist to the furthest fingertip. */
  size: number;
  dofCount: number;
}

/** Assigns dofStart on each joint and returns the total number of angles. */
export function indexDofs(joints: HandJoint[]): number {
  let n = 0;
  for (const j of joints) {
    j.dofStart = n;
    n += j.dofs.length;
  }
  return n;
}

export function restPose(model: HandModel): Float32Array {
  return new Float32Array(model.dofCount);
}

export function openPose(model: HandModel): Float32Array {
  const a = new Float32Array(model.dofCount);
  for (const j of model.joints) for (let d = 0; d < j.dofs.length; d++) a[j.dofStart + d] = j.dofs[d].open;
  return a;
}

const _q = new Quaternion();
const _r = new Matrix4();
const _t = new Matrix4();

/** Rigid rotation about `axis` through `pivot`. */
export function rotationAbout(pivot: Vector3, axis: Vector3, angle: number, out: Matrix4): Matrix4 {
  _q.setFromAxisAngle(axis, angle);
  out.makeRotationFromQuaternion(_q);
  // out = T(p) * R * T(-p)
  const e = out.elements;
  const px = pivot.x, py = pivot.y, pz = pivot.z;
  e[12] = px - (e[0] * px + e[4] * py + e[8] * pz);
  e[13] = py - (e[1] * px + e[5] * py + e[9] * pz);
  e[14] = pz - (e[2] * px + e[6] * py + e[10] * pz);
  return out;
}

/**
 * Forward kinematics. Fills `out[j]` with the matrix that moves a rest-space
 * point attached to joint j into the posed hand (still in hand space; apply
 * the wrist transform afterwards).
 */
export function poseMatrices(model: HandModel, angles: ArrayLike<number>, out?: Matrix4[]): Matrix4[] {
  const res = out ?? model.joints.map(() => new Matrix4());
  for (let j = 0; j < model.joints.length; j++) {
    const joint = model.joints[j];
    const m = res[j];
    if (joint.parent >= 0) m.copy(res[joint.parent]);
    else m.identity();
    for (let d = 0; d < joint.dofs.length; d++) {
      const ang = angles[joint.dofStart + d];
      if (ang === 0) continue;
      rotationAbout(joint.position, joint.dofs[d].axis, ang, _r);
      m.multiply(_r);
    }
  }
  void _t;
  return res;
}

/** Local rotation of joint j (about its own pivot) for a pose, as a rest-space quaternion. */
export function jointLocalRotation(model: HandModel, j: number, angles: ArrayLike<number>, out: Quaternion): Quaternion {
  const joint = model.joints[j];
  out.identity();
  for (let d = 0; d < joint.dofs.length; d++) {
    _q.setFromAxisAngle(joint.dofs[d].axis, angles[joint.dofStart + d]);
    out.multiply(_q);
  }
  return out;
}

export function clampPose(model: HandModel, angles: Float32Array): Float32Array {
  for (const j of model.joints)
    for (let d = 0; d < j.dofs.length; d++) {
      const dof = j.dofs[d];
      const i = j.dofStart + d;
      angles[i] = Math.min(dof.max, Math.max(dof.min, angles[i]));
    }
  return angles;
}

/** Segment end points of a finger in rest space: joint k -> joint k+1 (or tip). */
export function fingerSegment(model: HandModel, finger: HandFinger, k: number): [Vector3, Vector3] {
  const a = model.joints[finger.joints[k]].position;
  const b = k + 1 < finger.joints.length ? model.joints[finger.joints[k + 1]].position : finger.tip;
  return [a, b];
}
