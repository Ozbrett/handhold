import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix3,
  Matrix4,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import type { HandAnalysis } from '../core/hand/analyze';
import type { HandModel } from '../core/hand/model';
import type { Baked } from './loaders';

/** A hand mesh bound to the skeleton the analysis produced, ready to pose and export. */
export interface RiggedHand {
  /** Receives the wrist transform; contains the skinned meshes and the bones. */
  root: Group;
  /** bones[i] drives model.joints[i]. */
  bones: Bone[];
  skeleton: Skeleton;
  meshes: SkinnedMesh[];
  model: HandModel;
  analysis: HandAnalysis;
  restLocal: Quaternion[];
  restWorld: Quaternion[];
}

export interface HandPose {
  /** Hand rest space -> world. */
  wrist: Matrix4;
  angles: Float32Array;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function boneNames(model: HandModel): string[] {
  const names = model.joints.map(() => 'Wrist');
  for (const f of model.fingers) f.joints.forEach((j, k) => (names[j] = `${cap(f.name)}${k + 1}`));
  return names;
}

/** Rest orientation of each bone: Y runs along the bone, X is the axis it bends around. */
function restMatrices(model: HandModel): Matrix4[] {
  const mats = model.joints.map(() => new Matrix4());
  const f = model.frame;
  const x = new Vector3().crossVectors(f.up, f.normal).normalize();
  mats[0].makeBasis(x, f.up.clone().normalize(), new Vector3().crossVectors(x, f.up).normalize());
  mats[0].setPosition(model.joints[0].position);
  for (const finger of model.fingers) {
    finger.joints.forEach((j, k) => {
      const joint = model.joints[j];
      const next = k + 1 < finger.joints.length ? model.joints[finger.joints[k + 1]].position : finger.tip;
      const y = next.clone().sub(joint.position).normalize();
      const bx = joint.dofs[joint.dofs.length - 1].axis.clone();
      bx.addScaledVector(y, -bx.dot(y));
      if (bx.lengthSq() < 1e-10) bx.set(1, 0, 0).addScaledVector(y, -y.x);
      bx.normalize();
      const z = new Vector3().crossVectors(bx, y).normalize();
      mats[j].makeBasis(bx, y, z);
      mats[j].setPosition(joint.position);
    });
  }
  return mats;
}

/**
 * Builds skinned meshes and a skeleton from the analysed hand. The geometry
 * is the baked, world-space copy of whatever was loaded, so any source
 * transform, old rig or pose is already folded in.
 */
export function buildRiggedHand(baked: Baked, analysis: HandAnalysis): RiggedHand {
  const model = analysis.model;
  const root = new Group();
  root.name = 'Hand';
  root.matrixAutoUpdate = false;

  const names = boneNames(model);
  const world = restMatrices(model);
  const bones = model.joints.map((_, i) => {
    const b = new Bone();
    b.name = names[i];
    return b;
  });
  const inv = new Matrix4(), local = new Matrix4(), scale = new Vector3();
  model.joints.forEach((joint, i) => {
    if (joint.parent >= 0) {
      inv.copy(world[joint.parent]).invert();
      local.multiplyMatrices(inv, world[i]);
      bones[joint.parent].add(bones[i]);
    } else {
      local.copy(world[i]);
    }
    local.decompose(bones[i].position, bones[i].quaternion, scale);
  });
  root.add(bones[0]);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);

  const meshes: SkinnedMesh[] = [];
  const normalMatrix = new Matrix3();
  for (const part of baked.parts) {
    const src = part.mesh.geometry;
    const geo = new BufferGeometry();
    const a = part.start, b = part.start + part.count;
    geo.setAttribute('position', new BufferAttribute(baked.mesh.positions.slice(a * 3, b * 3), 3));
    if (src.index) geo.setIndex(src.index.clone());
    for (const name of ['uv', 'uv1', 'uv2', 'color']) {
      const attr = src.getAttribute(name);
      if (attr) geo.setAttribute(name, attr.clone());
    }
    for (const g of src.groups) geo.addGroup(g.start, g.count, g.materialIndex);
    const srcNormal = src.getAttribute('normal');
    const posed = (part.mesh as unknown as SkinnedMesh).isSkinnedMesh || !!src.morphAttributes.position;
    if (srcNormal && !posed) {
      const n = srcNormal.clone();
      normalMatrix.getNormalMatrix(part.mesh.matrixWorld);
      n.applyNormalMatrix(normalMatrix);
      geo.setAttribute('normal', n);
    } else {
      geo.computeVertexNormals();
    }
    geo.setAttribute('skinIndex', new Uint16BufferAttribute(analysis.skinIndices.slice(a * 4, b * 4), 4));
    geo.setAttribute('skinWeight', new Float32BufferAttribute(analysis.skinWeights.slice(a * 4, b * 4), 4));
    const mesh = new SkinnedMesh(geo, part.mesh.material);
    mesh.name = part.mesh.name || 'HandMesh';
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    root.add(mesh);
    mesh.bind(skeleton, new Matrix4());
    meshes.push(mesh);
  }

  return {
    root,
    bones,
    skeleton,
    meshes,
    model,
    analysis,
    restLocal: bones.map((b) => b.quaternion.clone()),
    restWorld: world.map((m) => new Quaternion().setFromRotationMatrix(m)),
  };
}

const _d = new Quaternion();
const _a = new Quaternion();
const _i = new Quaternion();

/** Poses the bones and places the hand. */
export function setHandPose(hand: RiggedHand, pose: HandPose) {
  const { model, bones } = hand;
  for (let j = 1; j < bones.length; j++) {
    const joint = model.joints[j];
    _d.identity();
    for (let d = 0; d < joint.dofs.length; d++) {
      _a.setFromAxisAngle(joint.dofs[d].axis, pose.angles[joint.dofStart + d]);
      _d.multiply(_a);
    }
    // the joint rotation is defined in rest space; express it in the bone's own frame
    _i.copy(hand.restWorld[j]).invert();
    bones[j].quaternion.copy(hand.restLocal[j]).multiply(_i).multiply(_d).multiply(hand.restWorld[j]);
  }
  hand.root.matrix.copy(pose.wrist);
  hand.root.matrixWorldNeedsUpdate = true;
  hand.root.updateMatrixWorld(true);
}

const _p0 = new Vector3(), _p1 = new Vector3(), _s = new Vector3();
const _q0 = new Quaternion(), _q1 = new Quaternion();

/** In-between of two poses, t in 0..1. */
export function mixPose(a: HandPose, b: HandPose, t: number, out: HandPose): HandPose {
  for (let i = 0; i < out.angles.length; i++) out.angles[i] = a.angles[i] + (b.angles[i] - a.angles[i]) * t;
  a.wrist.decompose(_p0, _q0, _s);
  b.wrist.decompose(_p1, _q1, _s);
  out.wrist.compose(_p0.lerp(_p1, t), _q0.slerp(_q1, t), _s.set(1, 1, 1));
  return out;
}
