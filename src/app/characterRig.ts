import { type Bone, Line3, Matrix4, type Object3D, Quaternion, type SkinnedMesh, Vector3 } from 'three';
import { fitPoints } from '../core/fit';
import type { HandAnalysis } from '../core/hand/analyze';
import { type HandModel, indexDofs, poseMatrices } from '../core/hand/model';
import type { Baked } from './loaders';

/**
 * The link between a solved hand and the skeleton the model already had.
 * Lets a grip be applied to a character's own finger bones instead of to a
 * separate, freshly rigged hand.
 */
export interface CharacterRig {
  /** The loaded model with its original skeleton. */
  root: Object3D;
  /** The bones in and around the hand, parents before children. */
  bones: Bone[];
  /** For each bone, which of the solved hand's joints it moves with (0 = palm, does not move). */
  jointOf: number[];
  restLocal: Quaternion[];
  restWorld: Quaternion[];
  /** Rest world position of each bone's pivot. */
  restHead: Vector3[];
  /** Inverse of each bone's rest world matrix. */
  restInverse: Matrix4[];
  restMatrix: Matrix4[];
  restPosition: Vector3[];
  /**
   * True for finger bones that do not hang off another hand bone (some rigs
   * keep every bone as a sibling). Those are moved as well as turned.
   */
  free: boolean[];
  /**
   * What each bone points at: the pivot of the next bone along the finger (or
   * the fingertip for the last one), and the solved joint that point moves with.
   */
  aim: ({ point: Vector3; joint: number } | null)[];
  /** The bone a held object should be attached to (the hand / wrist bone). */
  handBone: Bone;
  /** How many of the bones are finger bones that actually get posed. */
  fingerBones: number;
}

const _p = new Vector3(), _s = new Vector3();

/**
 * Works out which of the model's own bones drive the hand that was analysed,
 * and which solved joint each one corresponds to. The match is by position
 * (a bone lying inside the index finger's middle segment follows that
 * segment), so it does not depend on bone names or on any naming convention.
 * Returns null if the model has no skeleton or no usable finger bones.
 */
export function buildCharacterRig(
  source: Object3D,
  baked: Baked,
  keep: Uint8Array | null,
  analysis: HandAnalysis,
): CharacterRig | null {
  source.updateMatrixWorld(true);
  const model = analysis.model;
  // how much each bone weighs on the vertices of this hand
  const weight = new Map<Bone, number>();
  let total = 0;
  for (const part of baked.parts) {
    const mesh = part.mesh as unknown as SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) continue;
    const si = mesh.geometry.getAttribute('skinIndex');
    const sw = mesh.geometry.getAttribute('skinWeight');
    if (!si || !sw) continue;
    for (let i = 0; i < part.count; i++) {
      if (keep && !keep[part.start + i]) continue;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0) continue;
        const bone = mesh.skeleton.bones[si.getComponent(i, k)];
        if (!bone) continue;
        weight.set(bone, (weight.get(bone) ?? 0) + w);
        total += w;
      }
    }
  }
  if (!(total > 0)) return null;

  const inHand = new Set<Bone>();
  for (const [bone, w] of weight) if (w > 0.002 * total) inHand.add(bone);
  // tip bones carry no weight but belong to their finger
  const addChildren = (b: Object3D) => {
    for (const c of b.children) {
      if ((c as Bone).isBone) {
        inHand.add(c as Bone);
        addChildren(c);
      }
    }
  };
  for (const b of [...inHand]) addChildren(b);

  // parents before children
  const bones: Bone[] = [];
  source.traverse((o) => {
    if ((o as Bone).isBone && inHand.has(o as Bone)) bones.push(o as Bone);
  });
  const indexOf = new Map<Object3D, number>();
  bones.forEach((b, i) => indexOf.set(b, i));
  const restHead = bones.map((b) => b.getWorldPosition(new Vector3()));

  const jointOf: number[] = [];
  const mid = new Vector3(), child = new Vector3();
  let fingerBones = 0;
  bones.forEach((bone, i) => {
    // a bone is "where its body is": halfway to its children, not at its pivot
    mid.copy(restHead[i]);
    let n = 0;
    child.set(0, 0, 0);
    for (const c of bone.children) {
      const ci = indexOf.get(c);
      if (ci === undefined) continue;
      child.add(restHead[ci]);
      n++;
    }
    if (n) mid.lerp(child.multiplyScalar(1 / n), 0.5);
    const j = analysis.jointAt(mid.x, mid.y, mid.z);
    jointOf.push(j);
    if (j > 0) fingerBones++;
  });
  if (fingerBones < 4) return null;

  // what each finger bone points at
  const fingerOfJoint = new Map<number, number>();
  model.fingers.forEach((f, fi) => f.joints.forEach((j) => fingerOfJoint.set(j, fi)));
  const aim = bones.map((bone, i) => {
    if (jointOf[i] === 0) return null;
    const finger = model.fingers[fingerOfJoint.get(jointOf[i])!];
    // the next bone along the same finger
    for (const c of bone.children) {
      const ci = indexOf.get(c);
      if (ci !== undefined && jointOf[ci] > 0 && fingerOfJoint.get(jointOf[ci]) === fingerOfJoint.get(jointOf[i])) {
        if (restHead[ci].distanceTo(restHead[i]) > 0.03 * model.size) return { point: restHead[ci].clone(), joint: jointOf[ci] };
      }
    }
    // the last bone: the fingertip
    if (finger.tip.distanceTo(restHead[i]) < 0.05 * model.size) return null;
    return { point: finger.tip.clone(), joint: finger.joints[finger.joints.length - 1] };
  });

  // the hand bone: the palm bone that weighs most on this hand
  let handBone = bones[0], best = -1;
  bones.forEach((b, i) => {
    const w = weight.get(b) ?? 0;
    if (jointOf[i] === 0 && w > best) {
      best = w;
      handBone = b;
    }
  });

  return {
    root: source,
    bones,
    jointOf,
    restLocal: bones.map((b) => b.quaternion.clone()),
    restWorld: bones.map((b) => {
      const q = new Quaternion();
      b.matrixWorld.decompose(_p, q, _s);
      return q;
    }),
    restHead,
    restInverse: bones.map((b) => new Matrix4().copy(b.matrixWorld).invert()),
    restMatrix: bones.map((b) => b.matrixWorld.clone()),
    restPosition: bones.map((b) => b.position.clone()),
    free: bones.map((b, i) => jointOf[i] > 0 && !(b.parent && indexOf.has(b.parent))),
    aim,
    handBone,
    fingerBones,
  };
}

const _m = new Matrix4();
const _d = new Quaternion();
const _c = new Quaternion();
const _inv = new Quaternion();
const _v0 = new Vector3(), _v1 = new Vector3(), _h = new Vector3();

/**
 * Turns the character's own finger bones to match a solved pose. Only
 * rotations change, so bone lengths stay exactly as rigged. Each bone takes
 * the turn of the solved segment it lies in and is then re-aimed at where the
 * next joint (or the fingertip) should be, because the two skeletons do not
 * bend at exactly the same points. Pass null to restore the rest pose.
 */
export function poseCharacter(rig: CharacterRig, model: HandModel, angles: ArrayLike<number> | null) {
  if (!angles) {
    rig.bones.forEach((b, i) => {
      b.quaternion.copy(rig.restLocal[i]);
      b.position.copy(rig.restPosition[i]);
    });
    rig.root.updateMatrixWorld(true);
    return;
  }
  const mats = poseMatrices(model, angles);
  const world = new Map<Object3D, Quaternion>();
  rig.root.updateMatrixWorld(true);
  rig.bones.forEach((bone, i) => {
    const parent = bone.parent;
    let parentWorld: Quaternion;
    if (parent && world.has(parent)) parentWorld = world.get(parent)!;
    else {
      parentWorld = new Quaternion();
      if (parent) parent.matrixWorld.decompose(_p, parentWorld, _s);
    }
    const j = rig.jointOf[i];
    if (j === 0) {
      // palm and wrist bones are left exactly as rigged (the arm is posed separately)
      bone.quaternion.copy(rig.restLocal[i]);
      bone.updateMatrix();
      if (parent) bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
      const q = new Quaternion();
      bone.matrixWorld.decompose(_p, q, _s);
      world.set(bone, q);
      return;
    }
    if (rig.free[i] && parent) {
      // no parent bone to carry it: place it exactly where its segment went
      _m.copy(parent.matrixWorld).invert().multiply(mats[j]).multiply(rig.restMatrix[i]);
      _m.decompose(bone.position, bone.quaternion, _s);
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
      const q = new Quaternion();
      bone.matrixWorld.decompose(_p, q, _s);
      world.set(bone, q);
      return;
    }
    _d.setFromRotationMatrix(_m.extractRotation(mats[j]));
    const target = _d.clone().multiply(rig.restWorld[i]);
    const aim = rig.aim[i];
    if (j > 0 && aim && parent) {
      // where this bone's pivot actually is now, and where it should point
      _h.copy(bone.position).applyMatrix4(parent.matrixWorld);
      _v0.subVectors(aim.point, rig.restHead[i]).applyQuaternion(_d);
      _v1.copy(aim.point).applyMatrix4(mats[aim.joint]).sub(_h);
      if (_v0.lengthSq() > 1e-16 && _v1.lengthSq() > 1e-16) {
        _c.setFromUnitVectors(_v0.normalize(), _v1.normalize());
        target.premultiply(_c);
      }
    }
    world.set(bone, target);
    bone.quaternion.copy(_inv.copy(parentWorld).invert()).multiply(target);
    bone.updateMatrix();
    if (parent) bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
  });
  rig.root.updateMatrixWorld(true);
}

/**
 * How far the model's own bones put the fingertips from where the solver
 * wanted them, as a fraction of the hand's length (the worst finger). The two
 * skeletons differ in bone lengths, so this is never exactly zero.
 * Call after poseCharacter with the same angles.
 */
export function transferError(rig: CharacterRig, model: HandModel, angles: ArrayLike<number>): number {
  const mats = poseMatrices(model, angles);
  const want = new Vector3(), got = new Vector3(), m = new Matrix4();
  let worst = 0;
  for (const f of model.fingers) {
    const distal = f.joints[f.joints.length - 1];
    let bone = -1;
    rig.jointOf.forEach((j, i) => {
      if (j === distal) bone = i;
    });
    if (bone < 0) continue;
    want.copy(f.tip).applyMatrix4(mats[distal]);
    got.copy(f.tip).applyMatrix4(m.multiplyMatrices(rig.bones[bone].matrixWorld, rig.restInverse[bone]));
    worst = Math.max(worst, want.distanceTo(got));
  }
  return worst / model.size;
}

/**
 * A finger bone's one hinge, as an engine bends it: the axis (a positive turn closes the finger) and the bone's rest position,
 * both in the engine's own space (any one space for all bones), and the range from the rest pose in radians.
 */
export interface BoneHinge {
  axis: [number, number, number];
  max: number;
  at: [number, number, number];
}

export interface HingeUse {
  /** Joints put on the engine's hinges. */
  joints: number;
  /** For each, degrees between the axis the analysis had and the engine's. */
  apart: Record<string, number>;
  /** How well the engine's bone positions lined up on the character's (metres left over, scale between them). */
  rms: number;
  scale: number;
}

/**
 * Makes the solver bend the fingers the way the character's own skeleton will be bent in the engine. The engine's bone
 * positions are lined up on the character's bones (so its axes need not share any bone's own frame, which importers do not
 * agree on); then along each finger, base first, each hinged bone takes the next solved joint: that joint's axes become the
 * bone's one hinge with the engine's range, its pivot moves onto the bone's head, and the finger's collision spheres and the
 * bones' links are redone to follow. Joints with no hinged bone keep what they had. Null when too few bones line up.
 */
export function useHinges(rig: CharacterRig, model: HandModel, hinges: Map<string, BoneHinge>): HingeUse | null {
  const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byKey = new Map<string, BoneHinge>();
  for (const [n, h] of hinges) byKey.set(key(n), h);
  const hinged: number[] = [];
  const from: Vector3[] = [], to: Vector3[] = [];
  rig.bones.forEach((b, i) => {
    const h = byKey.get(key(b.name));
    if (!h || rig.jointOf[i] <= 0) return;
    hinged.push(i);
    from.push(new Vector3(...h.at));
    to.push(rig.restHead[i]);
  });
  const fit = fitPoints(from, to);
  if (!fit) return null;
  const fingerOfJoint = new Map<number, number>();
  model.fingers.forEach((f, fi) => f.joints.forEach((j) => fingerOfJoint.set(j, fi)));
  const apart: Record<string, number> = {};
  let count = 0;
  model.fingers.forEach((finger, fi) => {
    // this finger's hinged bones, parents first (rig.bones is in that order), each name once (a model may carry a skeleton twice)
    const seen = new Set<string>();
    const mine = hinged.filter((i) => {
      const k = key(rig.bones[i].name);
      if (fingerOfJoint.get(rig.jointOf[i]) !== fi || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const order = mine.map((i) => key(rig.bones[i].name));
    const n = Math.min(mine.length, finger.joints.length);
    if (!n) return;
    for (let k = 0; k < n; k++) {
      const i = mine[k], j = finger.joints[k];
      const h = byKey.get(key(rig.bones[i].name))!;
      const axis = new Vector3(...h.axis).normalize().applyQuaternion(fit.rotation);
      const joint = model.joints[j];
      const flex = joint.dofs.find((d) => d.kind === 'flex');
      if (flex) apart[joint.name] = Math.round((flex.axis.angleTo(axis) * 180) / Math.PI);
      joint.dofs = [{ axis, kind: 'flex', min: 0, max: h.max, open: 0, closed: h.max }];
      joint.position.copy(rig.restHead[i]);
      count++;
    }
    // the bones follow the joints they now are; anything further out on the finger (an end bone) follows the last
    const last = finger.joints[n - 1];
    rig.bones.forEach((_, i) => {
      if (fingerOfJoint.get(rig.jointOf[i]) !== fi) return;
      const k = order.indexOf(key(rig.bones[i].name));
      rig.jointOf[i] = k >= 0 && k < n ? finger.joints[k] : last;
      if (k >= 0 && k < n) rig.aim[i] = k + 1 < n ? { point: rig.restHead[mine[k + 1]].clone(), joint: finger.joints[k + 1] } : { point: finger.tip.clone(), joint: last };
    });
    // each of the finger's spheres moves with the segment it now lies on
    const ends = finger.joints.map((j) => model.joints[j].position);
    ends.push(finger.tip);
    const seg = new Line3(), near = new Vector3();
    for (const sp of model.spheres) {
      if (sp.finger !== fi) continue;
      let best = Infinity;
      for (let k = 0; k + 1 < ends.length; k++) {
        seg.set(ends[k], ends[k + 1]);
        const d = seg.closestPointToPoint(sp.center, true, near).distanceTo(sp.center);
        if (d < best) {
          best = d;
          sp.joint = finger.joints[k];
          sp.link = k;
        }
      }
    }
  });
  model.dofCount = indexDofs(model.joints);
  return { joints: count, apart, rms: fit.rms, scale: fit.scale };
}
