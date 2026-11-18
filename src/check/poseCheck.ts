import { type Bone, Quaternion, Vector3 } from 'three';
import { WRIST_LIMITS, wristJoint } from '../app/armIk';
import { type Body, type FingerName, type Limb, REGION_NAMES, Region, SIDES, type Side, armRegion, fingerTips, mainChild, posedSkin, restPos, worldDelta, worldPos } from './body';
import { type HeldItem, depthInItem, distanceToItem } from './items';

/**
 * Whole-pose checks: one character pose (with whatever it holds) measured the way a person looking at it would judge it. Every
 * check is a pure function of the posed bones, the skin they draw and the items' places, and says pass or fail, by how much (mm or
 * degrees), against what limit, and which joint or part it is about. The site, the command line and the motion check all call
 * these, so a pose passes in one exactly when it passes in the others.
 */

export type Unit = 'mm' | 'deg' | 'x' | '';

export interface Check {
  /** Stable id, side first where there is one: `right.elbow.flex`. */
  id: string;
  /** The joint, part or pair it is about, in words. */
  about: string;
  pass: boolean;
  value: number;
  unit: Unit;
  /** The limit `value` is held to; `below` says which way. */
  limit: number;
  below: boolean;
  frame?: number;
  note?: string;
}

const DEG = Math.PI / 180;
const r1 = (x: number) => Math.round(x * 10) / 10;

function check(id: string, about: string, value: number, unit: Unit, limit: number, below = true, note?: string): Check {
  const v = Number.isFinite(value) ? r1(value) : value;
  return { id, about, value: v, unit, limit, below, pass: below ? v <= limit : v >= limit, ...(note ? { note } : {}) };
}

const signedAngle = (a: Vector3, b: Vector3, axis: Vector3) => Math.atan2(new Vector3().crossVectors(a, b).dot(axis), a.dot(b)) / DEG;
const perp = (v: Vector3, axis: Vector3) => v.clone().addScaledVector(axis, -v.dot(axis));

/** The twist of `q` about `axis` (unit), in degrees, and the swing left once it is taken out (q = swing * twist). */
export function swingTwist(q: Quaternion, axis: Vector3): { twist: number; swing: Quaternion } {
  const p = new Vector3(q.x, q.y, q.z).projectOnVector(axis);
  const t = new Quaternion(p.x, p.y, p.z, q.w);
  if (t.lengthSq() < 1e-12) t.identity();
  t.normalize();
  const swing = q.clone().multiply(t.clone().invert());
  let a = 2 * Math.atan2(new Vector3(t.x, t.y, t.z).dot(axis), t.w) / DEG;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return { twist: a, swing };
}

// ---------------------------------------------------------------------------------------------------------------- the hand's frame

/** The palm's facing, its thumb side and its centre, from the bones as they are posed now (rest = false) or at rest. */
export function palmFrame(body: Body, limb: Limb, rest = false): { normal: Vector3; side: Vector3; along: Vector3; centre: Vector3 } {
  const at = (b: import('three').Bone) => (rest ? restPos(body, b) : worldPos(b));
  const hand = at(limb.hand);
  const knuckle = (n: FingerName) => limb.fingers.find((f) => f.name === n)?.bones[0];
  const idx = knuckle('index'), mid = knuckle('middle'), pinky = knuckle('pinky') ?? knuckle('ring');
  const middle = mid ? at(mid) : idx ? at(idx) : hand.clone();
  const along = middle.clone().sub(hand).normalize();
  const side = idx && pinky ? at(idx).sub(at(pinky)) : new Vector3(0, 0, 1);
  side.addScaledVector(along, -side.dot(along)).normalize();
  // the palm faces away from the back of the hand: for a right hand that is along x thumb-side reversed
  const normal = new Vector3().crossVectors(along, side).multiplyScalar(limb.side === 'right' ? -1 : 1).normalize();
  const centre = hand.clone().lerp(middle, 0.55);
  return { normal, side, along, centre };
}

// ---------------------------------------------------------------------------------------------------------------- joint ranges

/** Elbow hinge from straight (negative is bent backwards), with this much out of the hinge plane allowed. */
export const ELBOW = { hyperextend: 5, flex: 150, offPlane: 15 };
/** Upper arm against the chest: how far behind the body and how far across it. */
export const SHOULDER = { back: 60, across: 50 };
/** Finger joints, degrees: [flex min, flex max, side, twist] for the knuckle, middle and end joint; the thumb's turn and twist. */
export const FINGER = { knuckle: [-30, 100, 30, 25], middle: [-10, 115, 15, 20], end: [-15, 95, 15, 20], thumb: { turn: 100, twist: 60 } };
/** The hand bone's own twist on the forearm bone: past this a skin with no twist bone between them wraps like a sweet paper. */
export const TWIST_SHARE = 60;

function chestFrame(body: Body) {
  const top = body.neck ? worldPos(body.neck) : body.spine.length ? worldPos(body.spine[body.spine.length - 1]) : new Vector3(0, 1.4, 0);
  const bottom = body.pelvis ? worldPos(body.pelvis) : body.spine.length ? worldPos(body.spine[0]) : new Vector3(0, 1, 0);
  const up = top.clone().sub(bottom).normalize();
  const R = body.limbs.right ? worldPos(body.limbs.right.upper) : null, L = body.limbs.left ? worldPos(body.limbs.left.upper) : null;
  const forward = body.forward.clone().applyQuaternion(body.spine.length ? worldDelta(body, body.spine[body.spine.length - 1]) : new Quaternion());
  if (R && L) {
    const f = new Vector3().crossVectors(up, R.sub(L));
    if (f.lengthSq() > 1e-8 && f.dot(forward) > 0) forward.copy(f);
    else if (f.lengthSq() > 1e-8) forward.copy(f.negate());
  }
  forward.addScaledVector(up, -forward.dot(up)).normalize();
  return { up, forward, top, bottom };
}

/** Rest geometry of an arm, kept per body so every pose is measured from the same place. */
const armRest = new WeakMap<Body, Map<Side, ReturnType<typeof wristJoint> & { palm: ReturnType<typeof palmFrame> }>>();
function restArm(body: Body, limb: Limb) {
  let m = armRest.get(body);
  if (!m) armRest.set(body, (m = new Map()));
  let r = m.get(limb.side);
  if (!r) {
    const palm = palmFrame(body, limb, true);
    const j = wristJoint(restPos(body, limb.upper), restPos(body, limb.fore), restPos(body, limb.hand), body.forward, { normal: palm.normal, side: palm.side });
    r = { ...j, palm };
    m.set(limb.side, r);
  }
  return r;
}

/** Shoulder, elbow, forearm twist, wrist and every finger joint of one arm, each against its range. */
export function jointChecks(body: Body, limb: Limb): Check[] {
  body.root.updateMatrixWorld(true);
  const s = limb.side;
  const out: Check[] = [];
  const rest = restArm(body, limb);
  const S = worldPos(limb.upper), E = worldPos(limb.fore), W = worldPos(limb.hand);
  const dU = worldDelta(body, limb.upper), dF = worldDelta(body, limb.fore), dH = worldDelta(body, limb.hand);

  // shoulder: where the upper arm points, in the chest's frame
  const chest = chestFrame(body);
  const u = E.clone().sub(S).normalize();
  const out_ = new Vector3().crossVectors(chest.forward, chest.up).multiplyScalar(s === 'right' ? -1 : 1);
  // which way is "out" for this side: the shoulder's side of the spine
  const mid = chest.bottom.clone().lerp(chest.top, 0.8);
  if (out_.dot(S.clone().sub(mid)) < 0) out_.negate();
  out.push(check(`${s}.shoulder.back`, `${s} shoulder: upper arm behind the body`, Math.asin(Math.max(-1, Math.min(1, -u.dot(chest.forward)))) / DEG, 'deg', SHOULDER.back));
  out.push(check(`${s}.shoulder.across`, `${s} shoulder: upper arm across the chest`, Math.asin(Math.max(-1, Math.min(1, -u.dot(out_)))) / DEG, 'deg', SHOULDER.across));

  // elbow: a hinge carried by the upper arm
  const hinge = rest.hinge.clone().applyQuaternion(dU).normalize();
  const f = W.clone().sub(E).normalize();
  const inPlane = perp(f, hinge).normalize();
  const flex = signedAngle(u, inPlane, hinge);
  out.push(check(`${s}.elbow.hyperextend`, `${s} elbow: bent backwards`, -flex, 'deg', ELBOW.hyperextend));
  out.push(check(`${s}.elbow.flex`, `${s} elbow: bent`, flex, 'deg', ELBOW.flex));
  out.push(check(`${s}.elbow.offPlane`, `${s} elbow: forearm out of the hinge`, Math.asin(Math.min(1, Math.abs(f.dot(hinge)))) / DEG, 'deg', ELBOW.offPlane));

  // forearm twist and wrist: the hand's turn on an untwisted forearm
  const ideal = new Quaternion().setFromAxisAngle(hinge, (flex - rest.restBend) * DEG).multiply(dU);
  const rel = ideal.clone().invert().multiply(dH);
  const { twist, swing } = swingTwist(rel, rest.axis);
  const sup = twist * rest.supSign + rest.restSupination;
  out.push(check(`${s}.forearm.supinate`, `${s} forearm: turned palm up`, sup, 'deg', WRIST_LIMITS.supinate));
  out.push(check(`${s}.forearm.pronate`, `${s} forearm: turned palm down`, -sup, 'deg', WRIST_LIMITS.pronate));
  const a2 = rest.axis.clone().applyQuaternion(swing);
  const fl = Math.atan2(a2.dot(rest.palm.normal.clone().addScaledVector(rest.axis, -rest.palm.normal.dot(rest.axis)).normalize()), a2.dot(rest.axis)) / DEG;
  const sideAxis = perp(rest.palm.side, rest.axis).normalize();
  const rd = Math.atan2(a2.dot(sideAxis), a2.dot(rest.axis)) / DEG;
  out.push(check(`${s}.wrist.flex`, `${s} wrist: bent to the palm`, fl, 'deg', WRIST_LIMITS.flex));
  out.push(check(`${s}.wrist.extend`, `${s} wrist: bent to the back of the hand`, -fl, 'deg', WRIST_LIMITS.extend));
  out.push(check(`${s}.wrist.radial`, `${s} wrist: bent to the thumb`, rd, 'deg', WRIST_LIMITS.radial));
  out.push(check(`${s}.wrist.ulnar`, `${s} wrist: bent to the little finger`, -rd, 'deg', WRIST_LIMITS.ulnar));
  const own = swingTwist(dF.clone().invert().multiply(dH), rest.axis).twist;
  out.push(check(`${s}.wrist.twistAlone`, `${s} wrist: hand twisted on its forearm bone`, Math.abs(own), 'deg', TWIST_SHARE));

  // fingers: each bone's turn on its parent, in the rest hand's frame
  const n = rest.palm.normal;
  let worst = { flex: -Infinity, ext: -Infinity, side: -Infinity, twist: -Infinity, thumb: -Infinity, thumbTwist: -Infinity };
  const at = { flex: '', ext: '', side: '', twist: '', thumb: '', thumbTwist: '' };
  const tips = fingerTips(body, limb);
  for (const finger of limb.fingers) {
    finger.bones.forEach((b, k) => {
      const parent = k ? finger.bones[k - 1] : limb.hand;
      const r = worldDelta(body, parent).invert().multiply(worldDelta(body, b));
      const head = restPos(body, b);
      const next = k + 1 < finger.bones.length ? restPos(body, finger.bones[k + 1]) : tips.get(finger.name)!.local.clone().applyMatrix4(body.restWorld.get(b)!);
      const d = next.sub(head).normalize();
      const { twist: tw } = swingTwist(r, d);
      const d2 = d.clone().applyQuaternion(r);
      if (finger.name === 'thumb') {
        const turn = d.angleTo(d2) / DEG;
        if (turn > worst.thumb) { worst.thumb = turn; at.thumb = b.name; }
        if (Math.abs(tw) > worst.thumbTwist) { worst.thumbTwist = Math.abs(tw); at.thumbTwist = b.name; }
        return;
      }
      const lim = k === 0 ? FINGER.knuckle : k === 1 ? FINGER.middle : FINGER.end;
      const nn = perp(n, d).normalize();
      const across = new Vector3().crossVectors(d, nn);
      const flexA = Math.atan2(d2.dot(nn), d2.dot(d)) / DEG;
      const sideA = Math.asin(Math.max(-1, Math.min(1, d2.dot(across)))) / DEG;
      // each joint against its own range: the worst overshoot is what is reported
      const over = { flex: flexA - lim[1], ext: lim[0] - flexA, side: Math.abs(sideA) - lim[2], twist: Math.abs(tw) - lim[3] };
      for (const key of ['flex', 'ext', 'side', 'twist'] as const) if (over[key] > worst[key]) { worst[key] = over[key]; at[key] = b.name; }
    });
  }
  out.push(check(`${s}.finger.flex`, `${s} fingers: curled past their range at ${at.flex || 'none'}`, Math.max(0, worst.flex), 'deg', 0, true, 'degrees past the joint\'s own limit'));
  out.push(check(`${s}.finger.extend`, `${s} fingers: bent back past their range at ${at.ext || 'none'}`, Math.max(0, worst.ext), 'deg', 0, true, 'degrees past the joint\'s own limit'));
  out.push(check(`${s}.finger.side`, `${s} fingers: bent sideways at ${at.side || 'none'}`, Math.max(0, worst.side), 'deg', 0, true, 'degrees past the joint\'s own limit'));
  out.push(check(`${s}.finger.twist`, `${s} fingers: twisted at ${at.twist || 'none'}`, Math.max(0, worst.twist), 'deg', 0, true, 'degrees past the joint\'s own limit'));
  out.push(check(`${s}.thumb.turn`, `${s} thumb: turned at ${at.thumb || 'none'}`, Math.max(0, worst.thumb), 'deg', FINGER.thumb.turn));
  out.push(check(`${s}.thumb.twist`, `${s} thumb: twisted at ${at.thumbTwist || 'none'}`, Math.max(0, worst.thumbTwist), 'deg', FINGER.thumb.twist));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- skin

/**
 * Skin at a joint: an edge stretched this many times its rest length tears; a triangle this small (a share of its rest area) is
 * pinched, and one folded over is always pinched; a ring this much nearer its joint has collapsed. The area allowed differs by
 * joint: the inside of a bent elbow and the front of the armpit squash in every rig and in life, a wrist does not.
 */
export const SKIN = { stretch: 1.8, area: { wrist: 0.2, elbow: 0.1, shoulder: 0.05 }, ring: 0.7 };
/** A fold: neighbours whose faces agreed this well at rest (cosine) and now disagree this much. */
const FOLD = { rest: 0.5, now: -0.5 };

interface JointZone {
  id: string;
  joint: 'wrist' | 'elbow' | 'shoulder';
  about: string;
  /** Two regions the joint's skin lies between. */
  a: Region;
  b: Region;
  pivot: import('three').Bone;
}

function zones(body: Body): JointZone[] {
  const out: JointZone[] = [];
  for (const s of SIDES) {
    const l = body.limbs[s];
    if (!l) continue;
    out.push({ id: `${s}.skin.wrist`, joint: 'wrist', about: `${s} wrist skin`, a: armRegion(s, 'fore'), b: armRegion(s, 'hand'), pivot: l.hand });
    out.push({ id: `${s}.skin.elbow`, joint: 'elbow', about: `${s} elbow skin`, a: armRegion(s, 'upper'), b: armRegion(s, 'fore'), pivot: l.fore });
    out.push({ id: `${s}.skin.shoulder`, joint: 'shoulder', about: `${s} shoulder skin`, a: Region.Torso, b: armRegion(s, 'upper'), pivot: l.upper });
  }
  return out;
}

const inZone = (z: JointZone, r: number, b: number) => (r === z.a && b === z.b) || (r === z.b && b === z.a);

/**
 * Tear, pinch and collapse of the skin at each wrist, elbow and shoulder. `skin` is the posed skin (from `posedSkin`). `marks`,
 * when given (one array per skin part), gets a 1 on every vertex of a torn edge or a pinched or folded triangle, for the sheet.
 */
export function skinChecks(body: Body, skin: Float32Array[], marks?: Uint8Array[]): Check[] {
  const out: Check[] = [];
  const A = new Vector3(), B = new Vector3(), C = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3();
  const n0 = new Vector3(), n1 = new Vector3();
  for (const z of zones(body)) {
    let stretch = 0, area = Infinity, ringRest = 0, ringNow = 0, ringN = 0;
    const pivotRest = restPos(body, z.pivot), pivotNow = worldPos(z.pivot);
    body.skin.forEach((part, pi) => {
      const P = skin[pi], R = part.rest, I = part.index;
      const joint = (v: number) => inZone(z, part.region[v], part.blend[v]);
      for (let v = 0; v < part.region.length; v++) {
        if (!joint(v)) continue;
        ringRest += Math.hypot(R[v * 3] - pivotRest.x, R[v * 3 + 1] - pivotRest.y, R[v * 3 + 2] - pivotRest.z);
        ringNow += Math.hypot(P[v * 3] - pivotNow.x, P[v * 3 + 1] - pivotNow.y, P[v * 3 + 2] - pivotNow.z);
        ringN++;
      }
      // per triangle: rest and posed normals (unit), for the fold test across shared edges
      const tris: number[] = [];
      const nr: Vector3[] = [], np: Vector3[] = [];
      for (let t = 0; t + 2 < I.length; t += 3) {
        const i = I[t], j = I[t + 1], k = I[t + 2];
        if (!joint(i) && !joint(j) && !joint(k)) continue;
        A.fromArray(R, i * 3); B.fromArray(R, j * 3); C.fromArray(R, k * 3);
        a.fromArray(P, i * 3); b.fromArray(P, j * 3); c.fromArray(P, k * 3);
        for (const [p, q, pp, qq] of [[A, B, a, b], [B, C, b, c], [C, A, c, a]] as const) {
          const l0 = p.distanceTo(q);
          if (l0 <= 1e-5) continue;
          const r = pp.distanceTo(qq) / l0;
          stretch = Math.max(stretch, r);
          if (marks && r > SKIN.stretch) marks[pi][i] = marks[pi][j] = marks[pi][k] = 1;
        }
        n0.subVectors(B, A).cross(C.clone().sub(A));
        n1.subVectors(b, a).cross(c.clone().sub(a));
        const s0 = n0.length();
        if (s0 < 1e-9) continue;
        area = Math.min(area, n1.length() / s0);
        if (marks && n1.length() / s0 < SKIN.area[z.joint]) marks[pi][i] = marks[pi][j] = marks[pi][k] = 1;
        tris.push(t);
        nr.push(n0.clone().normalize());
        np.push(n1.clone().normalize());
      }
      // folded over: two neighbours that faced the same way at rest now face apart. Measured against each other, not against a
      // bone, because skin between two bones turns part of the way with each and no one bone's turn is its own.
      const edges = new Map<string, number>();
      tris.forEach((t, n) => {
        for (const [u, v] of [[I[t], I[t + 1]], [I[t + 1], I[t + 2]], [I[t + 2], I[t]]]) {
          const key = u < v ? `${u}-${v}` : `${v}-${u}`;
          const m = edges.get(key);
          if (m === undefined) { edges.set(key, n); continue; }
          if (nr[n].dot(nr[m]) > FOLD.rest && np[n].dot(np[m]) < FOLD.now) {
            area = 0;
            if (marks) for (const q of [tris[n], tris[m]]) marks[pi][I[q]] = marks[pi][I[q + 1]] = marks[pi][I[q + 2]] = 1;
          }
        }
      });
    });
    if (!ringN) continue;
    out.push(check(`${z.id}.tear`, `${z.about}: stretched`, stretch, 'x', SKIN.stretch));
    out.push(check(`${z.id}.pinch`, `${z.about}: pinched or folded over`, area === Infinity ? 1 : area, 'x', SKIN.area[z.joint], false));
    out.push(check(`${z.id}.collapse`, `${z.about}: fallen in on the joint`, ringNow / Math.max(1e-9, ringRest), 'x', SKIN.ring, false));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- nothing inside anything

/** How deep one thing may be inside another (mm). A hand's skin gives where it presses on what it holds; nothing else does. */
export const DEPTH = { handOnItem: 2, other: 1, bodyOnBody: 2 };

/**
 * The flesh of one bone: an elliptical rod round the bone from its head to its main child, as wide (across the body) and as deep
 * (front to back) as the middle of the skin it carries at rest, turned with the bone. A region is the union of its bones' rods.
 * The skin itself is not used for "is this point in the body": one region's skin is open where the next starts, and clothes are
 * shells laid over each other, so a point past an open edge reads as inside it; a rod has no edges.
 */
interface BoneVolume {
  bone: Bone;
  child: Bone | null;
  region: Region;
  /** Rest length past the head when there is no child. */
  length: number;
  /** The stretch of the bone this rod covers, as shares of its length: a limb narrows along its bone, so each bone is cut into slices. */
  t0: number;
  t1: number;
  /** Rest direction of the rod, and the axes across it (world), with its half-width and half-depth along them. */
  axis: Vector3;
  u: Vector3;
  w: Vector3;
  ru: number;
  rw: number;
}

const volumesOf = new WeakMap<Body, BoneVolume[]>();

/** How much of a bone's skin lies inside its rod: the middle of the flesh, not the pockets and folds. */
const ROD_SHARE = 0.6;
/** Slices per bone: enough to follow a forearm from the elbow's bulk down to the wrist. */
const ROD_SLICES = 4;

export function boneVolumes(body: Body): BoneVolume[] {
  let out = volumesOf.get(body);
  if (out) return out;
  out = [];
  const byBone = new Map<Bone, number[]>();
  for (const s of body.skin) {
    for (let v = 0; v < s.bone.length; v++) {
      const b = s.bone[v];
      if (!b) continue;
      let list = byBone.get(b);
      if (!list) byBone.set(b, (list = []));
      list.push(s.rest[v * 3], s.rest[v * 3 + 1], s.rest[v * 3 + 2]);
    }
  }
  const p = new Vector3();
  for (const [bone, pts] of byBone) {
    if (pts.length < 3 * 12) continue;
    const region = body.boneRegion.get(bone) ?? Region.Legs;
    const child = mainChild(bone);
    const a = restPos(body, bone);
    let axis = child ? restPos(body, child).sub(a) : new Vector3();
    let length = axis.length();
    if (length < 1e-4) {
      // no child: the rod runs to twice the middle of the bone's skin
      const c = new Vector3();
      for (let i = 0; i < pts.length; i += 3) c.add(p.set(pts[i], pts[i + 1], pts[i + 2]));
      axis = c.divideScalar(pts.length / 3).sub(a).multiplyScalar(2);
      length = axis.length();
    }
    if (length < 1e-4) continue;
    axis.normalize();
    // across the rod: the body's side and its facing, made square to the bone
    let u = perp(new Vector3(1, 0, 0), axis);
    if (u.lengthSq() < 1e-6) u = perp(body.forward.clone(), axis);
    u.normalize();
    const w = new Vector3().crossVectors(axis, u).normalize();
    const du: number[][] = [], dw: number[][] = [];
    for (let k = 0; k < ROD_SLICES; k++) { du.push([]); dw.push([]); }
    for (let i = 0; i < pts.length; i += 3) {
      p.set(pts[i], pts[i + 1], pts[i + 2]).sub(a);
      const t = p.dot(axis) / length;
      if (t < 0 || t > 1) continue;
      const k = Math.min(ROD_SLICES - 1, Math.floor(t * ROD_SLICES));
      du[k].push(Math.abs(p.dot(u)));
      dw[k].push(Math.abs(p.dot(w)));
    }
    for (let k = 0; k < ROD_SLICES; k++) {
      if (du[k].length < 6) continue;
      du[k].sort((x, y) => x - y);
      dw[k].sort((x, y) => x - y);
      const ru = du[k][Math.floor(du[k].length * ROD_SHARE)], rw = dw[k][Math.floor(dw[k].length * ROD_SHARE)];
      if (!(ru > 1e-3 && rw > 1e-3)) continue;
      out.push({ bone, child, region, length: child ? 0 : length, t0: k / ROD_SLICES, t1: (k + 1) / ROD_SLICES, axis, u, w, ru, rw });
    }
  }
  volumesOf.set(body, out);
  return out;
}

export interface PosedVolume {
  a: Vector3;
  b: Vector3;
  u: Vector3;
  w: Vector3;
  ru: number;
  rw: number;
  bone: Bone;
}

/** The rods where the bones are now, or at rest. */
export function posedVolumes(body: Body, pose: 'now' | 'rest'): Map<Region, PosedVolume[]> {
  const out = new Map<Region, PosedVolume[]>();
  for (const v of boneVolumes(body)) {
    const turn = pose === 'rest' ? new Quaternion() : worldDelta(body, v.bone);
    const head = pose === 'rest' ? restPos(body, v.bone) : worldPos(v.bone);
    const tail = v.child
      ? pose === 'rest' ? restPos(body, v.child) : worldPos(v.child)
      : head.clone().addScaledVector(v.axis.clone().applyQuaternion(turn), v.length);
    const a = head.clone().lerp(tail, v.t0), b = head.clone().lerp(tail, v.t1);
    let list = out.get(v.region);
    if (!list) out.set(v.region, (list = []));
    list.push({ a, b, u: v.u.clone().applyQuaternion(turn), w: v.w.clone().applyQuaternion(turn), ru: v.ru, rw: v.rw, bone: v.bone });
  }
  return out;
}

/** How deep a point is inside any of a region's rods (metres): how far in from the rod's surface, scaled to its thinner side. */
export function depthInRods(rods: PosedVolume[] | undefined, p: Vector3): number {
  if (!rods) return 0;
  let best = 0;
  for (const r of rods) {
    const abx = r.b.x - r.a.x, aby = r.b.y - r.a.y, abz = r.b.z - r.a.z;
    const l = abx * abx + aby * aby + abz * abz;
    const px = p.x - r.a.x, py = p.y - r.a.y, pz = p.z - r.a.z;
    const t = l > 1e-12 ? Math.max(0, Math.min(1, (px * abx + py * aby + pz * abz) / l)) : 0;
    const ox = px - abx * t, oy = py - aby * t, oz = pz - abz * t;
    // past either end the rod is capped round: the overshoot along the bone counts against its thinner side
    const along = l > 1e-12 ? (ox * abx + oy * aby + oz * abz) / Math.sqrt(l) : 0;
    const e = Math.hypot((ox * r.u.x + oy * r.u.y + oz * r.u.z) / r.ru, (ox * r.w.x + oy * r.w.y + oz * r.w.z) / r.rw, along / Math.min(r.ru, r.rw));
    if (e < 1) best = Math.max(best, (1 - e) * Math.min(r.ru, r.rw));
  }
  return best;
}

const restDepths = new WeakMap<Body, Map<string, Float32Array>>();

/** Which body regions must not go inside which: arms in the chest and head, hand in hand, forearm in upper arm, arm in the other arm. */
function bodyPairs(body: Body): [Region, Region, string][] {
  const out: [Region, Region, string][] = [];
  const sides = SIDES.filter((s) => body.limbs[s]);
  for (const s of sides) {
    for (const p of ['upper', 'fore', 'hand'] as const) {
      out.push([armRegion(s, p), Region.Torso, `${s} ${p === 'upper' ? 'upper arm' : p === 'fore' ? 'forearm' : 'hand'} in the chest`]);
      out.push([armRegion(s, p), Region.Head, `${s} ${p === 'upper' ? 'upper arm' : p === 'fore' ? 'forearm' : 'hand'} in the head`]);
    }
    out.push([armRegion(s, 'fore'), armRegion(s, 'upper'), `${s} forearm in its upper arm`]);
    out.push([armRegion(s, 'hand'), armRegion(s, 'upper'), `${s} hand in its upper arm`]);
  }
  if (sides.length === 2) {
    for (const p of ['fore', 'hand'] as const) for (const q of ['upper', 'fore', 'hand'] as const) {
      out.push([armRegion('right', p), armRegion('left', q), `right ${p === 'fore' ? 'forearm' : 'hand'} in the left ${q === 'upper' ? 'upper arm' : q === 'fore' ? 'forearm' : 'hand'}`]);
      out.push([armRegion('left', p), armRegion('right', q), `left ${p === 'fore' ? 'forearm' : 'hand'} in the right ${q === 'upper' ? 'upper arm' : q === 'fore' ? 'forearm' : 'hand'}`]);
    }
  }
  return out;
}

function bodyDepths(body: Body, skin: Float32Array[], rods: Map<Region, PosedVolume[]>, from: Region, into: Region): { depth: Float32Array; part: number[]; vert: number[] } {
  // an upper arm hangs from its own collarbone, and the top of the shoulder slides over it as the arm swings (the rig's collarbone
  // stays still where a body's would shrug): the arm is measured against the rest of the chest, which it must never enter
  const own = SIDES.map((s) => body.limbs[s]).find((l) => l && into === Region.Torso && armRegion(l.side, 'upper') === from)?.clavicle;
  const target = rods.get(into)?.filter((r) => r.bone !== own);
  const part: number[] = [], vert: number[] = [];
  const depth: number[] = [];
  const p = new Vector3();
  body.skin.forEach((s, pi) => {
    for (let v = 0; v < s.region.length; v++) {
      // the joint's own skin lies between the two and is allowed to touch both
      if (s.region[v] !== from || s.blend[v] === into) continue;
      part.push(pi); vert.push(v);
      if (!target) { depth.push(0); continue; }
      p.fromArray(skin[pi], v * 3);
      depth.push(depthInRods(target, p));
    }
  });
  return { depth: Float32Array.from(depth), part, vert };
}

/**
 * Nothing inside anything: the skin in each held item and each item's corners and edges in the skin; hand in hand, forearm in upper
 * arm, arms in the chest and head, arm in the other arm (measured from how far each was already in at rest, so a rest pose with the
 * arms pressed to the sides is not counted against a pose); item in item, except items declared to mate. `marks`, when given (one
 * array per skin part), gets a 1 on every vertex of one body part sunk into another, for the sheet.
 */
export function overlapChecks(body: Body, skin: Float32Array[], items: HeldItem[], marks?: Uint8Array[]): Check[] {
  const out: Check[] = [];
  const rods = posedVolumes(body, 'now');

  // body against body, relative to rest
  let rest = restDepths.get(body);
  if (!rest) {
    rest = new Map();
    const rm = posedVolumes(body, 'rest');
    for (const [a, b] of bodyPairs(body)) rest.set(`${a}-${b}`, bodyDepths(body, body.skin.map((s) => s.rest), rm, a, b).depth);
    restDepths.set(body, rest);
  }
  for (const [a, b, about] of bodyPairs(body)) {
    const now = bodyDepths(body, skin, rods, a, b);
    const was = rest.get(`${a}-${b}`)!;
    let worst = 0;
    for (let i = 0; i < now.depth.length; i++) {
      const d = now.depth[i] - (was[i] ?? 0);
      worst = Math.max(worst, d);
      if (marks && d * 1000 > DEPTH.bodyOnBody) marks[now.part[i]][now.vert[i]] = 1;
    }
    out.push(check(`body.${REGION_NAMES[a].replace(/\W+/g, '')}.in.${REGION_NAMES[b].replace(/\W+/g, '')}`, about, worst * 1000, 'mm', DEPTH.bodyOnBody));
  }

  const p = new Vector3();
  for (const item of items) {
    const inv = item.matrix.clone().invert();
    // skin in the item, by region
    const worst = new Map<Region, number>();
    body.skin.forEach((s, pi) => {
      for (let v = 0; v < s.region.length; v++) {
        p.fromArray(skin[pi], v * 3).applyMatrix4(inv);
        if (p.x < item.min.x - 0.01 || p.y < item.min.y - 0.01 || p.z < item.min.z - 0.01 || p.x > item.max.x + 0.01 || p.y > item.max.y + 0.01 || p.z > item.max.z + 0.01) continue;
        const d = depthInItem(item, p);
        if (d > (worst.get(s.region[v]) ?? 0)) worst.set(s.region[v], d);
      }
    });
    for (const [r, d] of worst) {
      const hand = r === Region.HandL || r === Region.HandR;
      out.push(check(`item.${item.name}.has.${REGION_NAMES[r].replace(/\W+/g, '')}`, `${REGION_NAMES[r]} inside ${item.name}`, d * 1000, 'mm', hand ? DEPTH.handOnItem : DEPTH.other));
    }
    // the item's corners and edges in the skin
    const inBody = new Map<Region, number>();
    const S = item.samples;
    for (let i = 0; i < S.length; i += 3) {
      p.set(S[i], S[i + 1], S[i + 2]).applyMatrix4(item.matrix);
      for (const [region, list] of rods) {
        const d = depthInRods(list, p);
        if (d > (inBody.get(region) ?? 0)) inBody.set(region, d);
      }
    }
    for (const [r, d] of inBody) {
      const hand = r === Region.HandL || r === Region.HandR;
      out.push(check(`item.${item.name}.in.${REGION_NAMES[r].replace(/\W+/g, '')}`, `${item.name} inside the ${REGION_NAMES[r]}`, d * 1000, 'mm', hand ? DEPTH.handOnItem : DEPTH.other));
    }
  }

  // item against item
  for (let i = 0; i < items.length; i++) for (let j = 0; j < items.length; j++) {
    if (i === j) continue;
    const A = items[i], B = items[j];
    if (A.mates.includes(B.name) || B.mates.includes(A.name)) continue;
    const toB = B.matrix.clone().invert().multiply(A.matrix);
    let worst = 0;
    for (let k = 0; k < A.samples.length; k += 3) {
      p.set(A.samples[k], A.samples[k + 1], A.samples[k + 2]).applyMatrix4(toB);
      if (p.x < B.min.x || p.y < B.min.y || p.z < B.min.z || p.x > B.max.x || p.y > B.max.y || p.z > B.max.z) continue;
      worst = Math.max(worst, depthInItem(B, p));
    }
    out.push(check(`item.${A.name}.in.${B.name}`, `${A.name} inside ${B.name}`, worst * 1000, 'mm', DEPTH.other));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- elbow out

/** How far an elbow may sit nearer the body's middle than the straight line from its shoulder to its wrist (mm). */
export const ELBOW_IN = 15;

/** The elbow is out from the body: it never points in at the chest, nearer the spine than the line from shoulder to wrist. */
export function elbowChecks(body: Body, limb: Limb): Check[] {
  const chest = chestFrame(body);
  const S = worldPos(limb.upper), E = worldPos(limb.fore), W = worldPos(limb.hand);
  const sw = W.clone().sub(S);
  const t = Math.max(0, Math.min(1, E.clone().sub(S).dot(sw) / Math.max(1e-9, sw.lengthSq())));
  const onLine = S.clone().addScaledVector(sw, t);
  // distance from the spine's line, square to it
  const fromSpine = (p: Vector3) => perp(p.clone().sub(chest.bottom), chest.up).length();
  const inward = fromSpine(onLine) - fromSpine(E);
  return [check(`${limb.side}.elbow.in`, `${limb.side} elbow: pointed in at the body`, inward * 1000, 'mm', ELBOW_IN)];
}

// ---------------------------------------------------------------------------------------------------------------- way up

/** A gun's top may lean this far from up, and its muzzle this far from the way the chest faces; a tool's head, this far. */
export const WAY_UP = { gunUp: 90, gunAway: 100, toolAway: 135 };

/** The item is the right way up for its style: a gun top up and muzzle away, a tool head away from the holder; a thing or a part any way. */
export function wayUpChecks(body: Body, items: HeldItem[]): Check[] {
  const chest = chestFrame(body);
  const out: Check[] = [];
  for (const it of items) {
    const q = new Quaternion();
    it.matrix.decompose(new Vector3(), q, new Vector3());
    const up = it.up.clone().applyQuaternion(q), fwd = it.forward.clone().applyQuaternion(q);
    if (it.style === 'gun') {
      out.push(check(`item.${it.name}.up`, `${it.name}: top turned from up`, up.angleTo(body.up) / DEG, 'deg', WAY_UP.gunUp));
      out.push(check(`item.${it.name}.away`, `${it.name}: muzzle turned from where the body faces`, fwd.angleTo(chest.forward) / DEG, 'deg', WAY_UP.gunAway));
    } else if (it.style === 'tool') {
      out.push(check(`item.${it.name}.away`, `${it.name}: head turned towards the holder`, fwd.angleTo(chest.forward) / DEG, 'deg', WAY_UP.toolAway));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- the grip

/** A hand that holds a grip: which hand, which item, which pieces of it are the grip, and which fingers wrap it. */
export interface GripSpec {
  side: Side;
  item: string;
  /** Piece names (or name prefixes) of the grip; empty means the whole item. */
  pieces: string[];
  wrap: FingerName[];
}

/** The palm's centre may be this far from the grip's surface past the hand's own half-thickness (mm); its facing this far from the grip (deg); a wrapped fingertip this far from the item (mm) and at least this far round the grip from the palm's side of it (deg; past 90 is past the grip's middle); the thumb no further round the fingers' way than this (deg). */
export const GRIP = { palmGap: 12, palmFacing: 65, tipGap: 10, wrap: 150, thumbSide: 30 };

/** Principal axis of a set of points (the long way of a grip). */
function longAxis(points: Vector3[]): { centre: Vector3; axis: Vector3 } {
  const c = new Vector3();
  for (const p of points) c.add(p);
  c.divideScalar(Math.max(1, points.length));
  const m = [0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    m[0] += x * x; m[1] += x * y; m[2] += x * z; m[3] += y * y; m[4] += y * z; m[5] += z * z;
  }
  let v = new Vector3(1, 1, 1).normalize();
  for (let k = 0; k < 40; k++) {
    v = new Vector3(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[1] * v.x + m[3] * v.y + m[4] * v.z, m[2] * v.x + m[4] * v.y + m[5] * v.z).normalize();
  }
  return { centre: c, axis: v };
}

/** The palm is on the grip and faces it, the fingers named wrap round it and touch it, the thumb is on the thumb's side. */
export function gripChecks(body: Body, items: HeldItem[], grips: GripSpec[]): Check[] {
  const out: Check[] = [];
  for (const g of grips) {
    const limb = body.limbs[g.side];
    const item = items.find((i) => i.name === g.item);
    if (!limb || !item) {
      out.push({ id: `${g.side}.grip`, about: `${g.side} hand on ${g.item}`, pass: false, value: NaN, unit: '', limit: 0, below: true, note: !limb ? 'no such arm' : 'no such item' });
      continue;
    }
    const pieces = g.pieces.length ? item.pieces.filter((p) => g.pieces.some((n) => p.name === n || p.name.startsWith(n))) : item.pieces;
    const grip: HeldItem = { ...item, pieces };
    const pts: Vector3[] = [];
    for (const p of pieces) for (let i = 0; i < p.positions.length; i += 3) pts.push(new Vector3(p.positions[i], p.positions[i + 1], p.positions[i + 2]).applyMatrix4(item.matrix));
    if (!pts.length) {
      out.push({ id: `${g.side}.grip`, about: `${g.side} hand on ${g.item}`, pass: false, value: NaN, unit: '', limit: 0, below: true, note: `no piece named ${g.pieces.join(', ')}` });
      continue;
    }
    const { centre, axis } = longAxis(pts);
    const inv = item.matrix.clone().invert();
    const palm = palmFrame(body, limb);
    const pl = palm.centre.clone().applyMatrix4(inv);
    // the nearest point of the grip, back in the world
    const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
    let best = Infinity;
    const near = new Vector3();
    for (const p of pieces) {
      const h = p.bvh.closestPointToPoint(pl, hit, 0, best);
      if (h && h.distance < best) { best = h.distance; near.copy(h.point); }
    }
    near.applyMatrix4(item.matrix);
    const half = body.thickness[armRegion(g.side, 'hand')] * 0.5;
    out.push(check(`${g.side}.grip.palm`, `${g.side} palm on the ${g.item} grip`, (palm.centre.distanceTo(near) - half) * 1000, 'mm', GRIP.palmGap));
    out.push(check(`${g.side}.grip.facing`, `${g.side} palm facing the ${g.item} grip`, palm.normal.angleTo(near.clone().sub(palm.centre)) / DEG, 'deg', GRIP.palmFacing));

    // round the grip's axis, from the palm
    const radial = (p: Vector3) => perp(p.clone().sub(centre), axis).normalize();
    const tips = fingerTips(body, limb);
    const tipAt = (n: FingerName) => {
      const t = tips.get(n);
      return t ? t.local.clone().applyMatrix4(t.bone.matrixWorld) : null;
    };
    // how far round the grip a finger goes, joint by joint, from the grip's side the palm is on: a straight finger lying along
    // the grip is a quarter of the way round, one closed round its far side is more than half, and it can go further
    const palmSide = perp(palm.normal.clone().negate(), axis).normalize();
    const wrapOf = (n: FingerName) => {
      const f = limb.fingers.find((x) => x.name === n);
      const t = tipAt(n);
      if (!f || !t) return null;
      const chain = [palm.centre, ...f.bones.map((b) => worldPos(b)), t];
      let a = signedAngle(palmSide, radial(palm.centre), axis);
      for (let k = 1; k < chain.length; k++) a += signedAngle(radial(chain[k - 1]), radial(chain[k]), axis);
      return { angle: a, tip: t };
    };
    let total = 0;
    for (const n of g.wrap) total += wrapOf(n)?.angle ?? 0;
    const wrapSense = total >= 0 ? 1 : -1;
    let worstWrap = Infinity, worstGap = 0, wrapAt = '', gapAt = '';
    for (const n of g.wrap) {
      const w = wrapOf(n);
      if (!w) continue;
      const a = w.angle * wrapSense;
      if (a < worstWrap) { worstWrap = a; wrapAt = n; }
      const gap = distanceToItem(grip, w.tip.clone().applyMatrix4(inv), 0.2);
      if (gap > worstGap) { worstGap = gap; gapAt = n; }
    }
    if (g.wrap.length) {
      out.push(check(`${g.side}.grip.wrap`, `${g.side} ${wrapAt || 'fingers'} wrapped round the ${g.item} grip`, worstWrap === Infinity ? 0 : worstWrap, 'deg', GRIP.wrap, false));
      out.push(check(`${g.side}.grip.touch`, `${g.side} ${gapAt || 'fingertips'} on the ${g.item}`, worstGap * 1000, 'mm', GRIP.tipGap));
    }
    const thumb = wrapOf('thumb');
    if (thumb && g.wrap.length) {
      out.push(check(`${g.side}.grip.thumb`, `${g.side} thumb on the thumb side of the ${g.item} grip`, thumb.angle * wrapSense, 'deg', GRIP.thumbSide));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- shown is true

/** What is shown may differ from what is exported by this much (mm). */
export const TRUTH = 1;

/** Two skins of the same mesh (vertex for vertex) as close as this: what is drawn against what the exported pose draws. */
export function sameSkin(id: string, about: string, shown: Float32Array[], exported: Float32Array[]): Check {
  let worst = 0;
  for (let k = 0; k < shown.length; k++) {
    const a = shown[k], b = exported[k];
    if (!b || a.length !== b.length) return { id, about, pass: false, value: NaN, unit: 'mm', limit: TRUTH, below: true, note: 'not the same mesh' };
    for (let i = 0; i < a.length; i += 3) worst = Math.max(worst, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
  }
  return check(id, about, worst * 1000, 'mm', TRUTH);
}

// ---------------------------------------------------------------------------------------------------------------- the lot

export interface PoseScene {
  body: Body;
  items: HeldItem[];
  grips?: GripSpec[];
  /** Arms to check; both by default. */
  sides?: Side[];
}

/** Every check of one pose, as the bones are now. */
export function checkPose(scene: PoseScene): Check[] {
  const { body, items } = scene;
  body.root.updateMatrixWorld(true);
  const skin = posedSkin(body);
  const out: Check[] = [];
  for (const s of scene.sides ?? SIDES) {
    const limb = body.limbs[s];
    if (!limb) continue;
    out.push(...jointChecks(body, limb), ...elbowChecks(body, limb));
  }
  out.push(...skinChecks(body, skin), ...overlapChecks(body, skin, items), ...wayUpChecks(body, items));
  if (scene.grips?.length) out.push(...gripChecks(body, items, scene.grips));
  return out;
}

export const failing = (checks: Check[]) => checks.filter((c) => !c.pass);

/** One line per check, failures first. */
export function describe(checks: Check[]): string {
  return [...checks].sort((a, b) => Number(a.pass) - Number(b.pass))
    .map((c) => `${c.pass ? 'ok  ' : 'FAIL'} ${c.id}  ${c.value}${c.unit} (${c.below ? '<=' : '>='} ${c.limit})  ${c.about}${c.note ? ` -- ${c.note}` : ''}`)
    .join('\n');
}
