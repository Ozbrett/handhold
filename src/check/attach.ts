import { Matrix4, Quaternion, Vector3 } from 'three';
import type { WristReport } from '../app/armIk';
import { solveArm } from '../app/armIk';
import { type Body, type Side, restPose, worldPos } from './body';
import { type HeldItem, makeItem } from './items';
import { type PoseFileBone, applyFingerDeltas } from './poseFile';
import { armOf, bodyCapsules } from './scene';

/**
 * Animations with attachments: a clip is told which hand is on which part over which span of time, and where each moving part
 * is (in its item's own space) at a few keys. A hand on a part goes wherever the part goes, its fingers unchanged, so it cannot
 * slip; between spans the hand is free and blends from where it let go to where it takes hold next. Every key, span and blend
 * eases in and out (a quintic: no jump in position, speed or acceleration), so a clip that starts and ends on the hold leaves and
 * lands on it without a jerk. Each frame is posed by the site's own whole-arm solver.
 */

/** Eases 0..1 with no speed and no acceleration at either end. */
export const ease = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (10 + x * (6 * x - 15));
};

export interface PartKey {
  t: number;
  /** The part's place in its item's own space, from where it sits at rest. */
  offset: Matrix4;
}

/** A piece (or pieces) of an item that moves on its own: a magazine, a bolt, a lever. */
export interface MovingPart {
  name: string;
  pieces: string[];
  keys: PartKey[];
}

/** A span of time in which a hand is on a thing. */
export interface Span {
  from: number;
  to: number;
  /** 'item' for the item itself, or the name of a moving part. */
  on: string;
  /** The hand bone's matrix in the space of what it is on, held for the whole span. */
  place: Matrix4;
  /** The fingers' turns from rest (a pose file's bones), held for the whole span. */
  fingers: PoseFileBone[];
}

export interface HandTrack {
  side: Side;
  handBone: string;
  /** Sorted by time and not overlapping. Before the first span and after the last the hand stays where that span has it. */
  spans: Span[];
}

export interface AttachClip {
  name: string;
  duration: number;
  fps: number;
  item: HeldItem;
  /** Where the item is: one matrix for the whole clip, or keys eased like a part's. */
  at: Matrix4 | PartKey[];
  parts: MovingPart[];
  hands: HandTrack[];
}

function lerpMatrix(a: Matrix4, b: Matrix4, u: number): Matrix4 {
  const pa = new Vector3(), qa = new Quaternion(), sa = new Vector3(), pb = new Vector3(), qb = new Quaternion(), sb = new Vector3();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  return new Matrix4().compose(pa.lerp(pb, u), qa.slerp(qb, u), sa.lerp(sb, u));
}

/** A keyed matrix at time t: eased from key to key, held before the first and after the last. */
export function keyed(keys: PartKey[], t: number): Matrix4 {
  if (!keys.length) return new Matrix4();
  if (t <= keys[0].t) return keys[0].offset.clone();
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) return lerpMatrix(keys[i - 1].offset, keys[i].offset, ease((t - keys[i - 1].t) / Math.max(1e-9, keys[i].t - keys[i - 1].t)));
  }
  return keys[keys.length - 1].offset.clone();
}

export function itemAt(clip: AttachClip, t: number): Matrix4 {
  return Array.isArray(clip.at) ? keyed(clip.at, t) : clip.at.clone();
}

/** Where a part (or the item, for 'item') is in the item's own space at time t. */
export function partOffset(clip: AttachClip, on: string, t: number): Matrix4 {
  if (on === 'item') return new Matrix4();
  const p = clip.parts.find((x) => x.name === on);
  if (!p) throw new Error(`${clip.name}: no moving part ${on}`);
  return keyed(p.keys, t);
}

function blendFingers(a: PoseFileBone[], b: PoseFileBone[], u: number): PoseFileBone[] {
  return a.map((x) => {
    const y = b.find((z) => z.name === x.name);
    if (!y) return x;
    return { ...x, delta: new Quaternion().fromArray(x.delta).slerp(new Quaternion().fromArray(y.delta), u).toArray() };
  });
}

/** Where a hand bone is wanted at time t, in the item's own space, and the fingers' turns; with the span it is on, if any. */
export function handAt(clip: AttachClip, track: HandTrack, t: number): { inItem: Matrix4; fingers: PoseFileBone[]; span: Span | null } {
  const S = track.spans;
  const placed = (s: Span, when: number) => partOffset(clip, s.on, when).multiply(s.place);
  const on = S.find((s) => t >= s.from && t <= s.to);
  if (on) return { inItem: placed(on, t), fingers: on.fingers, span: on };
  const before = [...S].reverse().find((s) => s.to < t), after = S.find((s) => s.from > t);
  if (before && after) {
    const u = ease((t - before.to) / Math.max(1e-9, after.from - before.to));
    return { inItem: lerpMatrix(placed(before, before.to), placed(after, after.from), u), fingers: blendFingers(before.fingers, after.fingers, u), span: null };
  }
  const only = before ?? after!;
  const when = before ? only.to : only.from;
  return { inItem: placed(only, when), fingers: only.fingers, span: null };
}

/** Whether a part names this piece: by its name, or as `#<n>` by its place in the item (an OBJ may repeat a name). */
const names = (part: MovingPart, piece: { name: string }, i: number) => part.pieces.includes(piece.name) || part.pieces.includes(`#${i}`);

/** The item cut into what moves on its own and what does not: the item without its moving parts, then each part. */
export function splitItem(item: HeldItem, parts: MovingPart[]): HeldItem[] {
  for (const part of parts) {
    const missing = part.pieces.filter((n) => !item.pieces.some((p, i) => p.name === n || `#${i}` === n));
    if (missing.length) throw new Error(`${item.name}: no pieces ${missing.join(', ')} for ${part.name}`);
  }
  const as = (pieces: typeof item.pieces) => pieces.map((p) => ({ name: p.name, positions: p.positions, index: p.index }));
  const still = item.pieces.filter((p, i) => !parts.some((part) => names(part, p, i)));
  const base = makeItem(item.name, as(still), { style: item.style, forward: item.forward, up: item.up, mates: item.mates });
  return [base, ...parts.map((part) => makeItem(`${item.name}_${part.name}`, as(item.pieces.filter((p, i) => names(part, p, i))), { style: 'part', mates: [item.name] }))];
}

export interface Frame {
  t: number;
  /** Every bone's world position and turn. */
  bones: { position: Vector3; quaternion: Quaternion }[];
  /** World matrix of each of `splitItem`'s items. */
  items: Matrix4[];
  /** How far each hand bone ended from where it was wanted (metres). */
  gaps: Partial<Record<Side, number>>;
}

/** Puts the body in the clip's pose at time t (the item and its parts placed in `items`, each from `splitItem`). */
export function poseAt(body: Body, clip: AttachClip, items: HeldItem[], t: number): Partial<Record<Side, number>> {
  restPose(body);
  const m = itemAt(clip, t);
  items[0].matrix.copy(m);
  clip.parts.forEach((p, i) => items[i + 1].matrix.copy(m.clone().multiply(keyed(p.keys, t))));
  const gaps: Partial<Record<Side, number>> = {};
  for (const track of clip.hands) {
    const limb = body.limbs[track.side];
    const arm = armOf(body, track.side);
    if (!limb || !arm) continue;
    arm.avoid = bodyCapsules(body);
    const { inItem, fingers } = handAt(clip, track, t);
    const p = new Vector3(), q = new Quaternion();
    m.clone().multiply(inItem).decompose(p, q, new Vector3());
    const rest = new Quaternion();
    body.restWorld.get(limb.hand)!.decompose(new Vector3(), rest, new Vector3());
    const r: WristReport = { flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 };
    solveArm(arm, { position: p, turn: [0, 0, 0], handTurn: q.clone().multiply(rest.invert()) }, r);
    applyFingerDeltas(body, fingers, track.handBone);
    body.root.updateMatrixWorld(true);
    gaps[track.side] = worldPos(limb.hand).distanceTo(p);
  }
  return gaps;
}

/** Samples the whole clip, first frame at 0 and last exactly at its end. */
export function sample(body: Body, clip: AttachClip): { items: HeldItem[]; frames: Frame[] } {
  const items = splitItem(clip.item, clip.parts);
  const n = Math.max(1, Math.round(clip.duration * clip.fps));
  const frames: Frame[] = [];
  for (let f = 0; f <= n; f++) {
    const t = (f / n) * clip.duration;
    const gaps = poseAt(body, clip, items, t);
    frames.push({
      t,
      bones: body.bones.map((b) => {
        b.updateWorldMatrix(true, false);
        const position = new Vector3(), quaternion = new Quaternion();
        b.matrixWorld.decompose(position, quaternion, new Vector3());
        return { position, quaternion };
      }),
      items: items.map((it) => it.matrix.clone()),
      gaps,
    });
  }
  restPose(body);
  return { items, frames };
}

/** The spans in a clip as motion-file contacts: which hand stays on which (split) item, when. */
export function contactsOf(clip: AttachClip): { hand: Side; item: string; from: number; to: number }[] {
  return clip.hands.flatMap((h) => h.spans.map((s) => ({ hand: h.side, item: s.on === 'item' ? clip.item.name : `${clip.item.name}_${s.on}`, from: s.from, to: s.to })));
}
