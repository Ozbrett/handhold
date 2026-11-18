import { Matrix4, Quaternion, Vector3 } from 'three';
import { type AttachClip, type HandTrack, type MovingPart, type Span, contactsOf, sample } from './attach';
import type { Body, Side } from './body';
import type { HeldItem } from './items';
import { type MotionClip, clipOf } from './motion';
import { type PoseFile, handInItem } from './poseFile';
import { aimFor } from './scene';

/**
 * A reload built from attachments: the shooting hand never leaves the grip; the other hand goes from where it holds the gun to
 * the magazine, takes it, draws it out and puts it back without letting go, and returns. The clip leaves the hold from still
 * and lands on it from still.
 */

/** How the magazine comes out, in the gun's own space. */
export type MagOut = { slide: Vector3 } | { pivot: Vector3; axis: Vector3; deg: number; slide: Vector3 };

export interface ReloadSpec {
  name: string;
  gun: HeldItem;
  /** The hand that stays on the grip. */
  grip: { side: Side; pose: PoseFile };
  /** The other hand on the gun in the hold (a rifle's handguard); left out, it waits just under the magazine. */
  support?: PoseFile;
  /** The other hand on the magazine, and which pieces are the magazine. */
  mag: { pose: PoseFile; pieces: string[]; out: MagOut };
  /** How far under the eye the gun is held for the reload (metres): lowered in front of the chest. */
  below?: number;
}

/** The reload's moments, in seconds: still, reach, draw out, hold out, push home, let go, return, still. */
export const RELOAD_TIMES = { reach: 0.15, take: 0.5, out: 0.85, back: 1.1, home: 1.45, leave: 1.5, done: 1.85, end: 2.0 };
export const RELOAD_BELOW = 0.2;
/** Where the free hand waits when the hold has no place for it: this far past the magazine's base the way it comes out, and this far out to its own side. */
export const WAIT_UNDER = 0.08;
export const WAIT_ASIDE = 0.04;

function outMatrix(o: MagOut): Matrix4 {
  const slide = new Matrix4().makeTranslation(o.slide.x, o.slide.y, o.slide.z);
  if (!('pivot' in o)) return slide;
  const p = o.pivot;
  const turn = new Matrix4().makeRotationAxis(o.axis.clone().normalize(), (o.deg * Math.PI) / 180);
  return slide.multiply(new Matrix4().makeTranslation(p.x, p.y, p.z)).multiply(turn).multiply(new Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}

/** The long axis of a set of pieces (power iteration on the spread of their points), turned to run down the gun. */
export function longAxis(item: HeldItem, pieces: string[]): Vector3 {
  const pts: Vector3[] = [];
  item.pieces.forEach((p, i) => {
    if (!pieces.includes(p.name) && !pieces.includes(`#${i}`)) return;
    for (let k = 0; k < p.positions.length; k += 3) pts.push(new Vector3(p.positions[k], p.positions[k + 1], p.positions[k + 2]));
  });
  const c = pts.reduce((s, p) => s.add(p), new Vector3()).divideScalar(pts.length);
  let v = item.up.clone().negate();
  for (let it = 0; it < 50; it++) {
    const w = new Vector3();
    for (const p of pts) { const d = p.clone().sub(c); w.addScaledVector(d, d.dot(v)); }
    v = w.normalize();
  }
  return v.dot(item.up) > 0 ? v.negate() : v;
}

export function reloadClip(body: Body, spec: ReloadSpec): AttachClip {
  const T = RELOAD_TIMES;
  const other: Side = spec.grip.side === 'right' ? 'left' : 'right';
  const gripAt = handInItem(spec.grip.pose), magAt = handInItem(spec.mag.pose);
  if (!gripAt || !magAt) throw new Error(`${spec.name}: a pose file has no objectInHandBone`);
  const out = outMatrix(spec.mag.out);
  const pull = new Vector3().setFromMatrixPosition(out).normalize();
  const supportAt = spec.support ? handInItem(spec.support) : null;
  // with nowhere to hold the gun, the free hand waits under the magazine and out to its own side, clear of the grip hand
  const aside = new Vector3().crossVectors(spec.gun.up, spec.gun.forward).normalize().multiplyScalar(other === 'left' ? WAIT_ASIDE : -WAIT_ASIDE);
  const wait = supportAt ?? new Matrix4().makeTranslation(pull.x * WAIT_UNDER + aside.x, pull.y * WAIT_UNDER + aside.y, pull.z * WAIT_UNDER + aside.z).multiply(magAt);
  const waitFingers = (spec.support ?? spec.mag.pose).bones;
  const part: MovingPart = { name: 'mag', pieces: spec.mag.pieces, keys: [{ t: T.take, offset: new Matrix4() }, { t: T.out, offset: out }, { t: T.back, offset: out }, { t: T.home, offset: new Matrix4() }] };
  const span = (from: number, to: number, on: string, place: Matrix4, fingers: Span['fingers']): Span => ({ from, to, on, place, fingers });
  const hands: HandTrack[] = [
    { side: spec.grip.side, handBone: spec.grip.pose.handBone, spans: [span(0, T.end, 'item', gripAt, spec.grip.pose.bones)] },
    {
      side: other,
      handBone: spec.mag.pose.handBone,
      spans: [
        // waiting on the gun (or under the magazine) is a span too: before the reach and after the return the hand is still
        span(0, T.reach, 'item', wait, waitFingers),
        span(T.take, T.leave, 'mag', magAt, spec.mag.pose.bones),
        span(T.done, T.end, 'item', wait, waitFingers),
      ],
    },
  ];
  // the gun is placed so every place a hand must reach is in reach: the magazine's hand both with it home and with it drawn out
  const drawn = out.clone().multiply(magAt).invert();
  const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
  drawn.decompose(p, q, sc);
  const magOut: PoseFile = { ...spec.mag.pose, objectInHandBone: { position: p.toArray(), quaternion: q.toArray(), scale: sc.toArray() } };
  const holdHands = [{ side: spec.grip.side, pose: spec.grip.pose }, { side: other, pose: spec.mag.pose }, { side: other, pose: magOut }, ...(spec.support ? [{ side: other, pose: spec.support }] : [])];
  return { name: spec.name, duration: T.end, fps: 30, item: spec.gun, at: aimFor(body, spec.gun, holdHands, spec.below ?? RELOAD_BELOW), parts: [part], hands };
}

/** The hold the reload leaves from and returns to, as a still clip: the reload's first moment, held. */
export function holdClip(clip: AttachClip): AttachClip {
  return { ...clip, name: `${clip.name}_hold`, duration: 0.2, hands: clip.hands.map((h) => ({ ...h, spans: [{ ...h.spans[0], from: 0, to: 0.2 }] })) };
}

/** The hold and the reload, sampled, as motion clips (the reload names the hold, so its ends are checked against it). */
export function reloadMotion(body: Body, spec: ReloadSpec): { items: HeldItem[]; clips: MotionClip[] } {
  const clip = reloadClip(body, spec);
  const hold = holdClip(clip);
  const h = sample(body, hold), r = sample(body, clip);
  return {
    items: r.items,
    clips: [clipOf(hold.name, hold.fps, h.frames, { contacts: contactsOf(hold) }), clipOf(clip.name, clip.fps, r.frames, { contacts: contactsOf(clip), hold: hold.name })],
  };
}
