import { Vector3 } from 'three';
import { type CollisionSphere, type HandJoint, type HandModel, type JointDof, indexDofs } from './model';

/** What an analysis (of a bare mesh or of an existing skeleton) has to provide. */
export interface FingerSpec {
  name: string;
  isThumb: boolean;
  /** Joint pivots from the base outwards (thumb: CMC, MCP, IP; fingers: MCP, PIP, DIP). */
  joints: Vector3[];
  tip: Vector3;
  /** Radius of each segment. */
  radii: number[];
}

export interface HandSpec {
  wrist: Vector3;
  fingers: FingerSpec[];
  up: Vector3;
  normal: Vector3;
  /** Across the palm towards the thumb. */
  side: Vector3;
  palmOrigin: Vector3;
  palmLength: number;
  palmWidth: number;
  palmSpheres: { center: Vector3; radius: number }[];
  handedness: 'left' | 'right';
  /** Manual correction: turn the thumb's bending direction about the thumb's own length (radians). */
  thumbTurn?: number;
}

const DEG = Math.PI / 180;

// Anatomical flexion ranges in radians, measured from a straight finger.
const FINGER_RANGE = [
  { min: -15 * DEG, max: 88 * DEG, open: 0 },
  { min: -2 * DEG, max: 105 * DEG, open: 5 * DEG },
  { min: -2 * DEG, max: 72 * DEG, open: 3 * DEG },
];

function signedAngle(a: Vector3, b: Vector3, axis: Vector3): number {
  const c = new Vector3().crossVectors(a, b);
  return Math.atan2(c.dot(axis), a.dot(b));
}

function flexDof(axis: Vector3, rest: number, range: { min: number; max: number; open: number }): JointDof {
  const min = Math.min(0, range.min - rest);
  const max = Math.max(20 * DEG, range.max - rest);
  const open = Math.min(max, Math.max(min, range.open - rest));
  return { axis: axis.clone(), kind: 'flex', min, max, open: Math.min(open, 0), closed: max };
}

/** Flexion axis of a finger: perpendicular to the finger within the palm plane. */
export function fingerFlexAxis(f: FingerSpec, up: Vector3, normal: Vector3): Vector3 {
  const dir = f.tip.clone().sub(f.joints[0]);
  const len = dir.length() || 1;
  const proj = dir.clone().addScaledVector(normal, -dir.dot(normal));
  if (proj.length() < 0.35 * len) proj.copy(up);
  const axis = new Vector3().crossVectors(proj, normal);
  if (axis.lengthSq() < 1e-12) axis.crossVectors(up, normal);
  return axis.normalize();
}

/** Flexion axis of the thumb: it closes across the palm, towards the fingers. */
export function thumbFlexAxis(f: FingerSpec, side: Vector3, normal: Vector3): Vector3 {
  const last = f.joints.length - 1;
  const mean = f.tip.clone().sub(f.joints[Math.min(1, last)]).normalize();
  const padRaw = side.clone().multiplyScalar(-0.75).addScaledVector(normal, 0.65);
  const pad = padRaw.addScaledVector(mean, -padRaw.dot(mean)).normalize();
  const axis = new Vector3().crossVectors(mean, pad).normalize();
  if (last >= 2) {
    // a thumb that is already bent shows which way it flexes
    const f1 = f.joints[last].clone().sub(f.joints[last - 1]).normalize();
    const f2 = f.tip.clone().sub(f.joints[last]).normalize();
    const bend = new Vector3().crossVectors(f1, f2);
    if (bend.length() > Math.sin(6 * DEG)) {
      bend.normalize();
      if (bend.dot(axis) > 0.4) axis.add(bend).normalize();
    }
  }
  return axis;
}

/**
 * Turns measured joints, radii and a palm frame into a solver-ready hand:
 * adds joint axes and limits, and fills fingers and palm with collision spheres.
 */
export function buildHandModel(spec: HandSpec): HandModel {
  const joints: HandJoint[] = [
    { name: 'wrist', position: spec.wrist.clone(), parent: -1, dofs: [], dofStart: 0 },
  ];
  const spheres: CollisionSphere[] = [];
  const fingers: HandModel['fingers'] = [];

  for (const p of spec.palmSpheres) {
    spheres.push({ center: p.center.clone(), radius: p.radius, joint: 0, finger: -1, link: -1 });
  }

  spec.fingers.forEach((f, fi) => {
    const n = f.joints.length;
    const pts = [...f.joints, f.tip];
    const dirs = pts.slice(1).map((p, i) => p.clone().sub(pts[i]).normalize());
    const jointIdx: number[] = [];
    if (f.isThumb) {
      const axis = thumbFlexAxis(f, spec.side, spec.normal);
      if (spec.thumbTurn) axis.applyAxisAngle(f.tip.clone().sub(f.joints[Math.min(1, n - 1)]).normalize(), spec.thumbTurn);
      const ranges = [
        { min: -10 * DEG, max: 35 * DEG },
        { min: -10 * DEG, max: 55 * DEG },
        { min: -10 * DEG, max: 78 * DEG },
      ];
      for (let k = 0; k < n; k++) {
        const dofs: JointDof[] = [];
        if (k === 0) {
          // palmar abduction: swings the thumb out in front of the palm
          const abd = new Vector3().crossVectors(dirs[0], spec.normal);
          if (abd.lengthSq() < 0.02) abd.crossVectors(axis, dirs[0]);
          abd.normalize();
          dofs.push({ axis: abd, kind: 'abduct', min: -15 * DEG, max: 60 * DEG, open: 0, closed: 0 });
          // spread: opens the thumb away from the fingers within the palm plane, so it
          // can pass round the far side of whatever the fingers are wrapping
          const spread = spec.normal.clone();
          if (new Vector3().crossVectors(spread, dirs[0]).dot(spec.up) > 0) spread.negate();
          dofs.push({ axis: spread, kind: 'spread', min: -10 * DEG, max: 60 * DEG, open: 0, closed: 0 });
        }
        const r = ranges[Math.min(k + (3 - n), 2)] ?? ranges[2];
        const a = axis.clone().addScaledVector(dirs[k], -axis.dot(dirs[k])).normalize();
        dofs.push({ axis: a, kind: 'flex', min: r.min, max: r.max, open: 0, closed: r.max });
        jointIdx.push(joints.length);
        joints.push({
          name: `${f.name}_${k}`,
          position: f.joints[k].clone(),
          parent: k === 0 ? 0 : joints.length - 1,
          dofs,
          dofStart: 0,
        });
      }
    } else {
      const axis = fingerFlexAxis(f, spec.up, spec.normal);
      for (let k = 0; k < n; k++) {
        let rest: number;
        if (k === 0) {
          const d = dirs[0];
          const out = d.dot(spec.normal);
          rest = Math.atan2(out, Math.sqrt(Math.max(1e-12, 1 - out * out)));
        } else {
          rest = signedAngle(dirs[k - 1], dirs[k], axis);
        }
        const range = FINGER_RANGE[Math.min(k + (3 - n), 2)] ?? FINGER_RANGE[2];
        jointIdx.push(joints.length);
        joints.push({
          name: `${f.name}_${k}`,
          position: f.joints[k].clone(),
          parent: k === 0 ? 0 : joints.length - 1,
          dofs: [flexDof(axis, rest, range)],
          dofStart: 0,
        });
      }
    }

    // collision spheres along each segment
    for (let k = 0; k < n; k++) {
      const a = pts[k];
      const r = f.radii[k];
      const b = pts[k + 1].clone();
      if (k === n - 1) b.addScaledVector(dirs[k], -Math.min(r, pts[k].distanceTo(pts[k + 1]) * 0.6));
      const len = a.distanceTo(b);
      const count = Math.max(2, Math.round(len / (0.8 * r)) + 1);
      for (let i = k === 0 ? 0 : 1; i < count; i++) {
        spheres.push({
          center: a.clone().lerp(b, i / (count - 1)),
          radius: r,
          joint: jointIdx[k],
          finger: fi,
          link: k,
        });
      }
    }
    fingers.push({ name: f.name, isThumb: f.isThumb, joints: jointIdx, tip: f.tip.clone(), radii: [...f.radii] });
  });

  const dofCount = indexDofs(joints);
  let size = 0;
  for (const f of spec.fingers) size = Math.max(size, f.tip.distanceTo(spec.wrist));
  return {
    joints,
    fingers,
    spheres,
    frame: {
      origin: spec.palmOrigin.clone(),
      up: spec.up.clone(),
      normal: spec.normal.clone(),
      side: spec.side.clone(),
      palmLength: spec.palmLength,
      palmWidth: spec.palmWidth,
    },
    handedness: spec.handedness,
    size,
    dofCount,
  };
}
