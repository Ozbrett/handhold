import { type Bone, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { CharacterRig } from './characterRig';

/**
 * How far a human wrist and forearm turn, in degrees. Pronation and supination
 * are measured from the thumb-up position; the others from the hand in line
 * with the forearm. Pronation is a little over the usual 85 so that a T-pose
 * rest (palm flat down) is always allowed.
 */
export const WRIST_LIMITS = { flex: 80, extend: 70, radial: 20, ulnar: 35, pronate: 100, supinate: 90 };
/** How much of the forearm twist the forearm bone takes; the hand bone takes the rest. */
const FOREARM_SHARE = 0.5;

/**
 * Everything about how far an arm may turn, which the user can change: the wrist and forearm ranges (degrees, as WRIST_LIMITS),
 * how far the elbow may swing out of its natural line to help the wrist (degrees), which way the elbow hangs (degrees from
 * straight down towards the outside), and how soft the ends of each range are (0: a hard stop; 1: the joint starts slowing down
 * from the middle of its range, as a real joint stiffens towards its end).
 */
export interface BodyLimits {
  flex: number;
  extend: number;
  radial: number;
  ulnar: number;
  pronate: number;
  supinate: number;
  swivel: number;
  elbowOut: number;
  soft: number;
}

export const BODY_LIMITS: Readonly<BodyLimits> = { ...WRIST_LIMITS, swivel: 90, elbowOut: 17, soft: 0.35 };

/**
 * `x` kept inside [lo, hi], with soft ends: within `soft` of a quarter of the range from either end it is eased towards that end
 * (slope 1 where the easing starts, never reaching past the end), so a joint driven at an even speed slows down as it nears its
 * limit instead of stopping dead. soft = 0 is a plain clamp.
 */
export function softClamp(x: number, lo: number, hi: number, soft: number): number {
  if (hi < lo) return (lo + hi) / 2;
  const w = Math.max(0, Math.min(1, soft)) * 0.25 * (hi - lo);
  if (w < 1e-9) return Math.min(hi, Math.max(lo, x));
  if (x > hi - w) return hi - w + w * Math.tanh((x - (hi - w)) / w);
  if (x < lo + w) return lo + w - w * Math.tanh((lo + w - x) / w);
  return x;
}

/** The upper arm, forearm and hand bones of a character, for placing the hand anywhere it can reach. */
export interface ArmRig {
  upper: Bone;
  fore: Bone;
  hand: Bone;
  restLocal: Quaternion[];
  restWorld: Quaternion[];
  /** Rest positions of the shoulder, elbow and wrist joints. */
  shoulder: Vector3;
  elbow: Vector3;
  wrist: Vector3;
  upperLength: number;
  foreLength: number;
  handRestMatrix: Matrix4;
  handRestInverse: Matrix4;
  /** Which way the elbow prefers to point (down and a little outwards). */
  pole: Vector3;
  /** The way the character faces. */
  forward: Vector3;
  /** From the body's centre line towards this arm. */
  outward: Vector3;
  /** The wrist's axes at rest, in the model's space. */
  joint: WristJoint;
  /** The hand's turn from rest when held at the starting position with the wrist straight. */
  baseTurn: Quaternion;
  /** How far this arm may turn (setBodyLimits changes it). */
  limits: BodyLimits;
}

interface WristJoint {
  /** Elbow to wrist. */
  axis: Vector3;
  /** Turning about this bends the hand towards the palm. */
  flexAxis: Vector3;
  /** Turning about this bends the hand towards the thumb. */
  radialAxis: Vector3;
  /** +1 if turning about `axis` turns the palm up (supination), -1 if down. */
  supSign: number;
  /** The forearm's turn at rest, in degrees from thumb-up (palm down in a T-pose is about -90). */
  restSupination: number;
  /** The elbow's hinge axis at rest, and the elbow's bend at rest about it. */
  hinge: Vector3;
  restBend: number;
}

/**
 * Where the hand is held: the wrist's position, and how the held object is
 * turned (tilt, turn, roll in degrees, about the character's side, up and
 * forward axes) from how it sits at the starting position. The wrist, forearm
 * and elbow are solved to give that turn.
 */
export interface HoldPose {
  position: Vector3;
  turn: [number, number, number];
  /** The hand's whole turn from rest, used instead of `turn` (for a second hand that has to meet the object). */
  handTurn?: Quaternion;
}

/** What the solver did with the wrist, in degrees. */
export interface WristReport {
  /** Towards the palm (+) or the back of the hand (-). */
  flex: number;
  /** Towards the thumb (+) or the little finger (-). */
  radial: number;
  /** Forearm turned palm-up (+) or palm-down (-) from rest. */
  twist: number;
  /** How far the elbow swung out of its natural line (+ raised, - lowered). */
  elbow: number;
  /** How far the object ends up from the turn asked for, when the joints run out of range. */
  miss: number;
}

const _p = new Vector3(), _s = new Vector3();
const worldQuat = (b: { matrixWorld: Matrix4 }) => {
  const q = new Quaternion();
  b.matrixWorld.decompose(_p, q, _s);
  return q;
};
const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);
const perp = (v: Vector3, axis: Vector3) => v.clone().addScaledVector(axis, -v.dot(axis));

/** The palm's facing and thumb direction at rest, in the model's space. */
export interface PalmAtRest {
  normal: Vector3;
  side: Vector3;
}

/**
 * Finds the arm above a character's hand bone: its parent is taken as the
 * forearm and that bone's parent as the upper arm. Returns null if the hand
 * has no such chain (a bare hand, or a rig with extra bones in between).
 * Without `palm` the hand is assumed palm down, thumb forward (a T-pose).
 */
export function buildArmRig(char: CharacterRig, palm?: PalmAtRest): ArmRig | null {
  const hand = char.handBone;
  const fore = hand.parent as Bone | null;
  const upper = fore?.parent as Bone | null;
  if (!fore?.isBone || !upper?.isBone) return null;
  char.root.updateMatrixWorld(true);
  const shoulder = upper.getWorldPosition(new Vector3());
  const elbow = fore.getWorldPosition(new Vector3());
  const wrist = hand.getWorldPosition(new Vector3());
  const upperLength = shoulder.distanceTo(elbow), foreLength = elbow.distanceTo(wrist);
  if (!(upperLength > 1e-6) || !(foreLength > 1e-6)) return null;

  // outwards: from where the shoulder hangs off the body (its parent) to the shoulder, flattened
  const outward = shoulder.clone();
  if (upper.parent) outward.sub(upper.parent.getWorldPosition(new Vector3()));
  outward.y = 0;
  if (outward.lengthSq() < 1e-10) outward.copy(wrist).sub(shoulder).setY(0);
  if (outward.lengthSq() < 1e-10) outward.set(1, 0, 0);
  outward.normalize();
  // characters face +Z by convention; take the horizontal direction square to the arm that is nearest to it
  const forward = new Vector3().crossVectors(UP, outward).normalize();
  if (forward.z < 0) forward.negate();
  const pole = elbowPole(outward, forward, BODY_LIMITS.elbowOut);

  const arm: ArmRig = {
    upper,
    fore,
    hand,
    restLocal: [upper, fore, hand].map((b) => b.quaternion.clone()),
    restWorld: [upper, fore, hand].map(worldQuat),
    shoulder,
    elbow,
    wrist,
    upperLength,
    foreLength,
    handRestMatrix: hand.matrixWorld.clone(),
    handRestInverse: hand.matrixWorld.clone().invert(),
    pole,
    forward,
    outward,
    joint: wristJoint(shoulder, elbow, wrist, forward, palm),
    baseTurn: new Quaternion(),
    limits: { ...BODY_LIMITS },
  };
  arm.baseTurn.copy(armAt(arm, clampToReach(arm, defaultHold(arm).position), 0).fore);
  return arm;
}

/** Which way the elbow prefers to point: down, swung `out` degrees towards the outside, and a little back. */
function elbowPole(outward: Vector3, forward: Vector3, out: number): Vector3 {
  const a = out * DEG;
  return new Vector3(0, -Math.cos(a), 0).addScaledVector(outward, Math.sin(a)).addScaledVector(forward, -0.25).normalize();
}

/** Gives an arm new limits (see BodyLimits); the elbow's preferred direction follows `elbowOut`. */
export function setBodyLimits(arm: ArmRig, limits: Partial<BodyLimits>) {
  Object.assign(arm.limits, limits);
  arm.pole.copy(elbowPole(arm.outward, arm.forward, arm.limits.elbowOut));
}

function wristJoint(shoulder: Vector3, elbow: Vector3, wrist: Vector3, forward: Vector3, palm?: PalmAtRest): WristJoint {
  const axis = wrist.clone().sub(elbow).normalize();
  const fallbackN = perp(new Vector3(0, -1, 0), axis);
  let n = palm ? perp(palm.normal, axis) : fallbackN;
  if (n.lengthSq() < 1e-6) n = fallbackN.lengthSq() > 1e-6 ? fallbackN : perp(forward, axis);
  n.normalize();
  let s = palm ? perp(palm.side, axis).addScaledVector(n, -perp(palm.side, axis).dot(n)) : perp(forward, axis).addScaledVector(n, -perp(forward, axis).dot(n));
  if (s.lengthSq() < 1e-6) s = new Vector3().crossVectors(axis, n);
  s.normalize();
  const flexAxis = new Vector3().crossVectors(axis, n);
  const radialAxis = new Vector3().crossVectors(axis, s);
  // supination carries the palm normal round to where the thumb was
  const supSign = new Vector3().crossVectors(n, s).dot(axis) >= 0 ? 1 : -1;
  const supAxis = axis.clone().multiplyScalar(supSign);
  // thumb up is neutral for an arm held out; for an arm hanging down, thumb forward
  const upPerp = perp(UP, axis);
  const thumbNeutral = upPerp.clone().addScaledVector(perp(forward, axis), 1 - upPerp.length());
  const restSupination = thumbNeutral.lengthSq() > 1e-8 ? signedAngle(thumbNeutral.normalize(), s, supAxis) : 0;

  const u0 = elbow.clone().sub(shoulder).normalize();
  let hinge = new Vector3().crossVectors(u0, axis);
  if (Math.asin(Math.min(1, hinge.length())) < 10 * DEG || u0.dot(axis) < 0) {
    // a straight arm: the elbow bends the forearm forwards
    let f = perp(forward, u0);
    if (f.lengthSq() < 1e-6) f = perp(new Vector3(0, -1, 0), u0);
    hinge = new Vector3().crossVectors(u0, f.normalize());
  }
  hinge.normalize();
  const restBend = signedAngle(u0, axis, hinge);
  return { axis, flexAxis, radialAxis, supSign, restSupination, hinge, restBend };
}

/** The angle from `a` to `b` about `axis`, in degrees. */
function signedAngle(a: Vector3, b: Vector3, axis: Vector3): number {
  return Math.atan2(new Vector3().crossVectors(a, b).dot(axis), a.dot(b)) / DEG;
}

/** How near and how far from the shoulder the wrist can be. */
export function reachOf(arm: ArmRig): { min: number; max: number } {
  return { min: Math.abs(arm.upperLength - arm.foreLength) * 1.05 + 0.12 * (arm.upperLength + arm.foreLength), max: (arm.upperLength + arm.foreLength) * 0.995 };
}

/** Pulls a wanted wrist position back inside what the arm can reach. */
export function clampToReach(arm: ArmRig, position: Vector3): Vector3 {
  const { min, max } = reachOf(arm);
  const d = position.clone().sub(arm.shoulder);
  const len = d.length();
  if (len < 1e-9) return arm.shoulder.clone().addScaledVector(arm.forward, min);
  return arm.shoulder.clone().addScaledVector(d, Math.min(max, Math.max(min, len)) / len);
}

/** A natural starting point: the hand held out in front of the body at about waist height. */
export function defaultHold(arm: ArmRig): HoldPose {
  const reach = arm.upperLength + arm.foreLength;
  return {
    position: arm.shoulder
      .clone()
      .addScaledVector(arm.forward, 0.62 * reach)
      .addScaledVector(new Vector3(0, -1, 0), 0.42 * reach)
      .addScaledVector(arm.outward, -0.08 * reach),
    turn: [0, 0, 0],
  };
}

const basis = (x: Vector3, y: Vector3) => new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y));

/**
 * The upper arm and forearm with the wrist on `target` and the elbow swung
 * `swivel` degrees about the shoulder-to-wrist line. Both are returned as
 * turns from rest. The elbow is a hinge: the forearm keeps its rest relation
 * to the upper arm apart from the bend.
 */
function armAt(arm: ArmRig, target: Vector3, swivel: number): { upper: Quaternion; fore: Quaternion; elbow: Vector3 } {
  const toTarget = target.clone().sub(arm.shoulder);
  const d = toTarget.length();
  const dir = toTarget.multiplyScalar(1 / d);
  const a = arm.upperLength, b = arm.foreLength;
  const cos = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  // the elbow sits in the plane through the shoulder, the target and the pole
  const side = perp(arm.pole, dir);
  if (side.lengthSq() < 1e-8) side.copy(perp(arm.outward, dir));
  side.normalize().applyAxisAngle(dir, swivel * DEG);
  const elbow = arm.shoulder.clone().addScaledVector(dir, a * cos).addScaledVector(side, a * sin);

  const j = arm.joint;
  const u0 = arm.elbow.clone().sub(arm.shoulder).normalize();
  const u = elbow.clone().sub(arm.shoulder).normalize();
  const f = target.clone().sub(elbow).normalize();
  const hinge = new Vector3().crossVectors(side, dir).normalize();
  const upper = new Quaternion().setFromRotationMatrix(basis(u, hinge).multiply(basis(u0, j.hinge).transpose()));
  const bend = signedAngle(u, f, hinge);
  const fore = new Quaternion().setFromAxisAngle(hinge, (bend - j.restBend) * DEG).multiply(upper);
  // the rest forearm may sit a little off the hinge plane: line it up exactly
  const now = j.axis.clone().applyQuaternion(fore);
  fore.premultiply(new Quaternion().setFromUnitVectors(now, f));
  return { upper, fore, elbow };
}

/** The held object's turn asked for by a hold, as a turn of the hand from rest. */
export function wantedTurn(arm: ArmRig, turn: [number, number, number]): Quaternion {
  const side = new Vector3().crossVectors(UP, arm.forward).normalize();
  const b = basis(side, UP);
  const e = new Quaternion().setFromEuler(new Euler(turn[0] * DEG, turn[1] * DEG, turn[2] * DEG, 'YXZ'));
  const frame = new Quaternion().setFromRotationMatrix(b);
  const r = frame.clone().multiply(e).multiply(frame.invert());
  return r.multiply(arm.baseTurn);
}

const angleOf = (q: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w))) / DEG;

/**
 * Splits the wrist's turn (in the rest frame) into forearm twist and wrist
 * bend, holds each inside human limits, and returns what is left.
 */
function limitWrist(j: WristJoint, want: Quaternion, L: BodyLimits): { q: Quaternion; twist: number; flex: number; radial: number; miss: number } {
  // want = twist * bend; decompose its inverse as bend⁻¹ * twist⁻¹ (swing-twist)
  const inv = want.clone().invert();
  const proj = j.axis.dot(new Vector3(inv.x, inv.y, inv.z));
  let tw = new Quaternion(j.axis.x * proj, j.axis.y * proj, j.axis.z * proj, inv.w);
  if (tw.lengthSq() < 1e-12) tw = new Quaternion();
  tw.normalize();
  const swing = inv.clone().multiply(tw.clone().invert());
  const twistQ = tw.invert(), bendQ = swing.invert();
  if (twistQ.w < 0) twistQ.set(-twistQ.x, -twistQ.y, -twistQ.z, -twistQ.w);
  if (bendQ.w < 0) bendQ.set(-bendQ.x, -bendQ.y, -bendQ.z, -bendQ.w);

  // forearm twist, as palm-up turn from rest
  let twist = (2 * Math.atan2(new Vector3(twistQ.x, twistQ.y, twistQ.z).dot(j.axis), twistQ.w)) / DEG;
  twist = ((((twist * j.supSign + 180) % 360) + 360) % 360) - 180;
  const lo = Math.min(0, -L.pronate - j.restSupination), hi = Math.max(0, L.supinate - j.restSupination);
  if (twist < lo || twist > hi) {
    // past the range: towards whichever end is nearer round the circle
    const gap = (x: number) => Math.abs((((x + 180) % 360) + 360) % 360 - 180);
    const end = gap(twist - lo) <= gap(twist - hi) ? lo : hi;
    twist = end + (end === lo ? -gap(twist - lo) : gap(twist - hi));
  }
  twist = softClamp(twist, lo, hi, L.soft);

  // wrist bend, held inside an ellipse whose size depends on the direction
  const half = Math.acos(Math.min(1, bendQ.w));
  const s = Math.sin(half);
  const r = s > 1e-9 ? new Vector3(bendQ.x, bendQ.y, bendQ.z).multiplyScalar((2 * half) / s / DEG) : new Vector3();
  let flex = r.dot(j.flexAxis), radial = r.dot(j.radialAxis);
  // how far out towards the ellipse's edge (1 = on it), eased near the edge like the twist
  const rho = Math.sqrt((flex / Math.max(1e-6, flex >= 0 ? L.flex : L.extend)) ** 2 + (radial / Math.max(1e-6, radial >= 0 ? L.radial : L.ulnar)) ** 2);
  const kept = softClamp(rho, -1, 1, L.soft * 2);
  if (rho > 1e-9 && kept < rho) {
    flex *= kept / rho;
    radial *= kept / rho;
  }
  const bendVec = j.flexAxis.clone().multiplyScalar(flex).addScaledVector(j.radialAxis, radial);
  const bendAngle = bendVec.length();
  const bend = bendAngle > 1e-9 ? new Quaternion().setFromAxisAngle(bendVec.divideScalar(bendAngle), bendAngle * DEG) : new Quaternion();
  const q = new Quaternion().setFromAxisAngle(j.axis, twist * j.supSign * DEG).multiply(bend);
  const miss = angleOf(q.clone().invert().multiply(want));
  return { q, twist, flex, radial, miss };
}

/**
 * Two-bone inverse kinematics with a solved wrist. Turns the upper arm and
 * forearm so the wrist lands on the hold position, then turns the forearm and
 * hand so the held object takes the turn asked for, as far as a human wrist
 * goes. The elbow swings out of its natural line only when that gets the
 * object nearer. Only rotations change. Pass null to put the arm back in its
 * rest pose. Returns the hand bone's new world matrix; `report` receives what
 * the wrist did.
 */
export function solveArm(arm: ArmRig, hold: HoldPose | null, report?: WristReport): Matrix4 {
  const bones = [arm.upper, arm.fore, arm.hand];
  if (!hold) {
    bones.forEach((b, i) => b.quaternion.copy(arm.restLocal[i]));
    arm.upper.updateMatrixWorld(true);
    if (report) Object.assign(report, { flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 });
    return arm.hand.matrixWorld.clone();
  }
  const target = clampToReach(arm, hold.position);
  const want = hold.handTurn ? hold.handTurn.clone() : wantedTurn(arm, hold.turn);

  const tryAt = (swivel: number) => {
    const pose = armAt(arm, target, swivel);
    const wrist = limitWrist(arm.joint, pose.fore.clone().invert().multiply(want), arm.limits);
    // the elbow swinging out costs more the nearer it gets to its own limit (more so with soft ends)
    const out = Math.abs(swivel) / Math.max(1, arm.limits.swivel);
    const cost = wrist.miss + 0.3 * Math.abs(swivel) + 20 * arm.limits.soft * out ** 4 + 0.02 * (Math.abs(wrist.flex) + Math.abs(wrist.radial) + Math.abs(wrist.twist));
    return { swivel, pose, wrist, cost };
  };
  let best = tryAt(0);
  const maxSwivel = Math.max(0, arm.limits.swivel);
  for (let s = -maxSwivel; s <= maxSwivel; s += 3) {
    const t = tryAt(s);
    if (t.cost < best.cost - 1e-9) best = t;
  }
  for (let s = best.swivel - 3; s <= best.swivel + 3; s += 0.25) {
    if (Math.abs(s) > maxSwivel) continue;
    const t = tryAt(s);
    if (t.cost < best.cost - 1e-9) best = t;
  }

  const { pose, wrist } = best;
  const j = arm.joint;
  const upperWorld = pose.upper.clone().multiply(arm.restWorld[0]);
  const foreShare = new Quaternion().setFromAxisAngle(j.axis, wrist.twist * j.supSign * FOREARM_SHARE * DEG);
  const foreWorld = pose.fore.clone().multiply(foreShare).multiply(arm.restWorld[1]);
  const handWorld = pose.fore.clone().multiply(wrist.q).multiply(arm.restWorld[2]);

  const parentWorld = arm.upper.parent ? worldQuat(arm.upper.parent) : new Quaternion();
  arm.upper.quaternion.copy(parentWorld.invert()).multiply(upperWorld);
  arm.fore.quaternion.copy(upperWorld.clone().invert()).multiply(foreWorld);
  arm.hand.quaternion.copy(foreWorld.clone().invert()).multiply(handWorld);
  arm.upper.updateMatrixWorld(true);
  if (report) {
    const natural = armAt(arm, target, 0).elbow;
    const raised = best.swivel === 0 ? 0 : Math.sign(pose.elbow.y - natural.y || 1) * Math.abs(best.swivel);
    Object.assign(report, { flex: wrist.flex, radial: wrist.radial, twist: wrist.twist, elbow: raised, miss: wrist.miss });
  }
  return arm.hand.matrixWorld.clone();
}

/**
 * A point part-way along a sweep from one hold to another. The wrist travels
 * on an arc around the shoulder (not a straight line), which is how an arm
 * actually swings, and the object's turn blends evenly.
 */
export function mixHold(arm: ArmRig, from: HoldPose, to: HoldPose, t: number): HoldPose {
  const a = from.position.clone().sub(arm.shoulder), b = to.position.clone().sub(arm.shoulder);
  const la = a.length(), lb = b.length();
  const swing = new Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
  const part = new Quaternion().slerp(swing, t);
  const dir = a.normalize().applyQuaternion(part);
  return {
    position: arm.shoulder.clone().addScaledVector(dir, la + (lb - la) * t),
    turn: [0, 1, 2].map((i) => from.turn[i] + (to.turn[i] - from.turn[i]) * t) as [number, number, number],
  };
}

/**
 * Where a second hand has to be to hold the object at its own grip, given
 * where the first hand is now. `firstGrip` and `secondGrip` are the grips'
 * wrist matrices (each hand's rest space into the object's space). Solve the
 * first arm before calling this.
 */
export function meetHold(first: ArmRig, firstGrip: Matrix4, second: ArmRig, secondGrip: Matrix4): HoldPose {
  first.upper.updateMatrixWorld(true);
  const carried = first.hand.matrixWorld.clone().multiply(first.handRestInverse).multiply(firstGrip.clone().invert()).multiply(secondGrip);
  const q = new Quaternion();
  carried.decompose(new Vector3(), q, new Vector3());
  return { position: second.wrist.clone().applyMatrix4(carried), turn: [0, 0, 0], handTurn: q };
}

/** How far the hand ended up from where a hold wanted it, after solveArm. */
export function holdGap(arm: ArmRig, hold: HoldPose): number {
  arm.upper.updateMatrixWorld(true);
  return arm.hand.getWorldPosition(new Vector3()).distanceTo(hold.position);
}

/** The arm that holds nothing: its upper arm and forearm bones and how they sit at rest. */
export interface FreeArm {
  upper: Bone;
  fore: Bone;
  restLocal: [Quaternion, Quaternion];
  /** Outwards on that side of the body, and the body's forward. */
  outward: Vector3;
  forward: Vector3;
}

const boneKids = (b: Bone) => b.children.filter((c): c is Bone => (c as Bone).isBone === true);
const descendants = (b: Bone): number => boneKids(b).reduce((n, c) => n + 1 + descendants(c), 0);
/** The child a limb carries on through (not a twist or helper bone): the one with the most bones below it. */
const mainChild = (b: Bone) => boneKids(b).sort((x, y) => descendants(y) - descendants(x))[0] ?? null;

/**
 * Finds the character's other arm, mirrored across the body from `arm`: an upper arm bone on the other side at about the
 * same height, whose upper arm and forearm are about as long as this arm's. Call with the bones at rest.
 */
export function findOtherArm(char: CharacterRig, arm: ArmRig): FreeArm | null {
  char.root.updateMatrixWorld(true);
  const mine = new Set<Bone>();
  for (let b: Bone | null = arm.hand; b?.isBone; b = b.parent as Bone | null) mine.add(b);
  const at = (b: Bone) => b.getWorldPosition(new Vector3());
  let best: FreeArm | null = null;
  let bestScore = Infinity;
  char.root.traverse((o) => {
    const upper = o as Bone;
    if (!upper.isBone || mine.has(upper)) return;
    const fore = mainChild(upper);
    const hand = fore && mainChild(fore);
    if (!fore || !hand) return;
    const s = at(upper), e = at(fore), w = at(hand);
    const off = s.clone().sub(arm.shoulder);
    // on the other side, at the shoulder's height and depth
    if (off.dot(arm.outward) > -0.5 * arm.upperLength) return;
    const up = Math.abs(off.y) / arm.upperLength;
    const ahead = Math.abs(off.dot(arm.forward)) / arm.upperLength;
    const a = Math.abs(s.distanceTo(e) / arm.upperLength - 1);
    const f = Math.abs(e.distanceTo(w) / arm.foreLength - 1);
    if (up > 0.3 || ahead > 0.3 || a > 0.35 || f > 0.35) return;
    const score = up + ahead + a + f;
    if (score < bestScore) {
      bestScore = score;
      best = {
        upper,
        fore,
        restLocal: [upper.quaternion.clone(), fore.quaternion.clone()],
        outward: arm.outward.clone().negate(),
        forward: arm.forward.clone(),
      };
    }
  });
  return best;
}

/** Turns a bone so that it points from `from` along `dir` instead of at `to` (all in world space). */
function aimBone(bone: Bone, from: Vector3, to: Vector3, dir: Vector3) {
  const now = to.clone().sub(from).normalize();
  const delta = new Quaternion().setFromUnitVectors(now, dir);
  const world = delta.multiply(worldQuat(bone));
  const parent = bone.parent ? worldQuat(bone.parent) : new Quaternion();
  bone.quaternion.copy(parent.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * Lets the free arm hang at the side (a little out from the body, the elbow a little bent forward), or puts it back
 * as the model has it at rest.
 */
export function hangArm(free: FreeArm, on: boolean) {
  free.upper.quaternion.copy(free.restLocal[0]);
  free.fore.quaternion.copy(free.restLocal[1]);
  free.upper.updateMatrixWorld(true);
  if (!on) return;
  const hand = mainChild(free.fore);
  if (!hand) return;
  const at = (b: Bone) => b.getWorldPosition(new Vector3());
  const down = new Vector3(0, -Math.cos(10 * DEG), 0).addScaledVector(free.outward, Math.sin(10 * DEG)).normalize();
  aimBone(free.upper, at(free.upper), at(free.fore), down);
  // the forearm swings forward a little from straight down
  const bend = down.clone().applyAxisAngle(new Vector3().crossVectors(down, free.forward).normalize(), 15 * DEG);
  aimBone(free.fore, at(free.fore), at(hand), bend);
}

/** A second hand part-way (0..1) from its grip to hanging by the hip, as when it lets go of the object to reload. */
export function letGo(arm: ArmRig, want: HoldPose, t: number): HoldPose {
  const reach = arm.upperLength + arm.foreLength;
  const hip = arm.shoulder
    .clone()
    .addScaledVector(new Vector3(0, -1, 0), 0.78 * reach)
    .addScaledVector(arm.forward, 0.18 * reach)
    .addScaledVector(arm.outward, 0.05 * reach);
  const e = t * t * (3 - 2 * t);
  return { position: want.position.clone().lerp(hip, e), turn: [0, 0, 0], handTurn: (want.handTurn ?? new Quaternion()).clone().slerp(arm.baseTurn, e) };
}
