import { type Bone, Matrix4, Quaternion, Vector3 } from 'three';
import { type ArmRig, type WristReport, buildArmRig, reachOf, solveArm } from '../app/armIk';
import type { CharacterRig } from '../app/characterRig';
import { type Body, Region, type Side, restPose, worldPos } from './body';
import { type HeldItem, type ItemStyle, makeItem } from './items';
import { loadObj } from './load';
import { depthInRods, posedVolumes } from './poseCheck';
import { type PoseFile, applyFingerDeltas, handInItem } from './poseFile';

/**
 * Putting a character in a hold the way the game does: the held thing goes where it is aimed or carried, each hand's bone goes
 * where its pose file puts it on the thing, the arms are solved by the site's own whole-arm solver to get each hand there, and
 * the fingers take the pose file's turns. What is then drawn and checked is what the game would draw.
 */

export interface ItemSpec {
  name: string;
  obj: string;
  /** True when the OBJ is already in this character's space (the game's export is mirrored into it). */
  mirrored?: boolean;
  style?: ItemStyle;
  forward?: number[];
  up?: number[];
  mates?: string[];
}

export function loadItem(spec: ItemSpec): HeldItem {
  return makeItem(spec.name, loadObj(spec.obj, spec.mirrored === false), {
    style: spec.style ?? 'gun',
    forward: spec.forward ? new Vector3().fromArray(spec.forward) : undefined,
    up: spec.up ? new Vector3().fromArray(spec.up) : undefined,
    mates: spec.mates,
  });
}

const arms = new WeakMap<Body, Map<Side, ArmRig | null>>();

/** The site's arm solver on one of the body's arms (built once per body, at rest). */
export function armOf(body: Body, side: Side): ArmRig | null {
  let m = arms.get(body);
  if (!m) arms.set(body, (m = new Map()));
  if (!m.has(side)) {
    const limb = body.limbs[side];
    let arm: ArmRig | null = null;
    if (limb) {
      // the solver drives hand, its parent and that one's parent: a rig with a twist bone in between is driven through it
      arm = buildArmRig({ handBone: limb.hand, root: body.root } as unknown as CharacterRig);
      if (arm && (arm.fore !== limb.fore || arm.upper !== limb.upper)) arm = null;
    }
    m.set(side, arm);
  }
  return m.get(side)!;
}

/** Where the game aims a held gun: its sight line from the eye, this far ahead and this far below. */
export const AIM = { ahead: 0.42, below: 0.035 };

/** How far short of a straight arm a hand's place must be, as a share of the arm's length: an aimed arm keeps some bend. */
export const AIM_BEND = 0.95;

/**
 * Where an aimed item can be held by this body: the distance ahead of the eye nearest `AIM.ahead` at which every hand's place on
 * the item lies within its arm's reach and the item is clear of the head and chest. A pistol sits at arm's length; a rifle comes
 * back until the support hand reaches its handguard, the way a shouldered rifle sits. When no distance does both, the item kept
 * out of the body counts first (a hand short of its place shows as a reach failure; a gun through the face hides everything
 * else), then the hands least short.
 */
export function aimFor(body: Body, item: HeldItem, hands: HandOn[]): Matrix4 {
  restPose(body);
  const rods = posedVolumes(body, 'rest');
  const body3 = [rods.get(Region.Head), rods.get(Region.Torso)];
  const p = new Vector3();
  let best: { m: Matrix4; short: number; off: number } | null = null;
  for (let cm = 10; cm <= 60; cm++) {
    const ahead = cm / 100;
    const m = aimedMatrix(body, item, 0, ahead);
    let short = 0;
    for (const h of hands) {
      const arm = armOf(body, h.side);
      const inItem = handInItem(h.pose);
      if (!arm || !inItem) continue;
      const wrist = new Vector3().setFromMatrixPosition(m.clone().multiply(inItem));
      const { min, max } = reachOf(arm);
      const d = wrist.distanceTo(arm.shoulder);
      short += Math.max(0, d - max * AIM_BEND) + Math.max(0, min - d);
    }
    let inside = 0;
    for (let i = 0; i < item.samples.length; i += 3) {
      p.fromArray(item.samples, i).applyMatrix4(m);
      for (const r of body3) inside = Math.max(inside, depthInRods(r, p));
    }
    short += inside * 10;
    const off = Math.abs(ahead - AIM.ahead);
    if (!best || short < best.short - 1e-6 || (Math.abs(short - best.short) <= 1e-6 && off < best.off)) best = { m, short, off };
  }
  return best!.m;
}

/** The body's eye, facing and up at rest. */
export function eyeOf(body: Body) {
  const head = body.head ? worldPos(body.head) : new Vector3(0, body.height * 0.93, 0);
  return { eye: head.clone().add(new Vector3(0, 0.08, 0)).addScaledVector(body.forward, 0.09), forward: body.forward.clone(), up: body.up.clone() };
}

/** A gun aimed straight ahead from the eye: its top up, its muzzle along the body's facing, its sight line just under the eye. */
export function aimedMatrix(body: Body, item: HeldItem, sideOffset = 0, ahead = AIM.ahead): Matrix4 {
  const { eye, forward, up } = eyeOf(body);
  const right = new Vector3().crossVectors(forward, up).normalize();
  // the item's own forward and up onto the body's
  const from = new Matrix4().makeBasis(new Vector3().crossVectors(item.up, item.forward), item.up, item.forward);
  const to = new Matrix4().makeBasis(new Vector3().crossVectors(up, forward), up, forward);
  const q = new Quaternion().setFromRotationMatrix(to.multiply(from.invert()));
  // the top of the gun is the sight line: put the top at the eye's height less `below`
  const top = item.max.y;
  const at = eye.clone().addScaledVector(forward, ahead).addScaledVector(up, -AIM.below - top).addScaledVector(right, sideOffset);
  return new Matrix4().compose(at, q, new Vector3(1, 1, 1));
}

export interface HandOn {
  pose: PoseFile;
  side: Side;
}

export interface HoldResult {
  reports: Partial<Record<Side, WristReport>>;
  /** How far each hand bone ended from where its pose file puts it on the item (metres). */
  gaps: Partial<Record<Side, number>>;
}

/**
 * Puts the body in a hold: the item at `matrix`, each hand solved onto it from its pose file and its fingers set. The arms keep
 * clear of the chest and head (as capsules from the rest skeleton). Returns what the solver reported.
 */
export function holdOn(body: Body, item: HeldItem, matrix: Matrix4, hands: HandOn[]): HoldResult {
  restPose(body);
  item.matrix.copy(matrix);
  const out: HoldResult = { reports: {}, gaps: {} };
  for (const h of hands) {
    const limb = body.limbs[h.side];
    const arm = armOf(body, h.side);
    const inItem = handInItem(h.pose);
    if (!limb || !arm || !inItem) continue;
    arm.avoid = bodyCapsules(body);
    const want = matrix.clone().multiply(inItem);
    const p = new Vector3(), q = new Quaternion();
    want.decompose(p, q, new Vector3());
    const rest = new Quaternion();
    body.restWorld.get(limb.hand)!.decompose(new Vector3(), rest, new Vector3());
    const r: WristReport = { flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 };
    solveArm(arm, { position: p, turn: [0, 0, 0], handTurn: q.clone().multiply(rest.invert()) }, r);
    applyFingerDeltas(body, h.pose.bones, h.pose.handBone);
    body.root.updateMatrixWorld(true);
    out.reports[h.side] = r;
    out.gaps[h.side] = worldPos(limb.hand).distanceTo(p);
  }
  return out;
}

/** The chest and head as capsules the arms keep out of, from the bones at rest (radius from the skin's thickness). */
export function bodyCapsules(body: Body) {
  const out: { a: Vector3; b: Vector3; radius: number }[] = [];
  const pos = (b: Bone | null) => (b ? new Vector3().setFromMatrixPosition(body.restWorld.get(b)!) : null);
  const bottom = pos(body.spine[0] ?? body.pelvis), top = pos(body.neck ?? body.spine[body.spine.length - 1] ?? null);
  if (bottom && top) out.push({ a: bottom, b: top, radius: body.thickness[0] * 0.8 });
  const head = pos(body.head);
  if (head) out.push({ a: head, b: head.clone().add(new Vector3(0, 0.12, 0)), radius: body.thickness[1] * 0.9 });
  return out;
}
