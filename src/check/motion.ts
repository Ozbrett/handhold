import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type Bone, Matrix4, Quaternion, Vector3 } from 'three';
import type { Frame } from './attach';
import { type Body, Region, type Side, key, posedSkin, restPose, restQuat, setWorld, worldPos } from './body';
import { bodyFor, faultMarks } from './holdCheck';
import type { HeldItem, ItemStyle } from './items';
import { encodePng } from './png';
import { type Check, checkPose } from './poseCheck';
import { type Review, fingerprint, record } from './review';
import { loadItem } from './scene';
import { poseRow, stack } from './sheet';

/**
 * The motion file (docs/motion-check.md): a game's animation, or one of Handhold's own, as world transforms per frame for the
 * bones and the held items. Read back onto Handhold's own copy of the character, every frame gets the whole-pose checks, and
 * the clip as a whole is checked for hands that slip off what they hold, joints that pop, and ends that do not meet the hold.
 */

export type Xform = number[]; // [px, py, pz, qx, qy, qz, qw]

export interface MotionItem {
  name: string;
  file: string;
  style?: ItemStyle;
  forward?: number[];
  up?: number[];
  mates?: string[] | string;
  mirrored?: boolean;
}

export interface Contact {
  hand: Side;
  item: string;
  from: number;
  to: number;
  maxSlipMm?: number;
}

export interface MotionClip {
  name: string;
  fps: number;
  view?: 'first' | 'third';
  loops?: boolean;
  hold?: string;
  contacts?: Contact[];
  frames: { t: number; bones: Xform[]; items: (Xform | null)[]; camera?: Xform }[];
}

export interface MotionFile {
  format: 'handhold-motion';
  version: 1;
  character: string;
  axes: 'unity' | 'gltf';
  bones: string[];
  rest: Xform[];
  items: MotionItem[];
  clips: MotionClip[];
}

/** How fast a joint may turn, degrees a second: quicker than a hand flicks a magazine out; a joint turning faster has popped. */
export const JOINT_SPEED = 1000;
/** How near a clip's ends must be to the hold (or to each other, for a loop): bone positions in mm, turns in degrees, speed in degrees a second. */
export const ENDS = { mm: 1, deg: 1, speed: 30 };
/** How many moments of a clip go on its sheet. */
export const MOMENTS = 8;

const xf = (p: Vector3, q: Quaternion): Xform => [...p.toArray(), ...q.toArray()].map((v) => Math.round(v * 1e6) / 1e6);

// ---------------------------------------------------------------------------------------------------------------- writing

/** A sampled clip (from `attach.sample`) as a motion clip; bones in the body's order, items in `items`' order. */
export function clipOf(name: string, fps: number, frames: Frame[], extra: Partial<MotionClip> = {}): MotionClip {
  return { name, fps, view: 'first', loops: false, ...extra, frames: frames.map((f) => ({ t: Math.round(f.t * 1e6) / 1e6, bones: f.bones.map((b) => xf(b.position, b.quaternion)), items: f.items.map((m) => { const p = new Vector3(), q = new Quaternion(); m.decompose(p, q, new Vector3()); return xf(p, q); }) })) };
}

/** An item's pieces as OBJ text, in its own space; `mirror` writes it in Unity's axes (X flipped, winding turned with it). */
export function objText(item: HeldItem, mirror = false): string {
  const out: string[] = [];
  let base = 1;
  for (const p of item.pieces) {
    out.push(`o ${p.name}`);
    for (let i = 0; i < p.positions.length; i += 3) out.push(`v ${mirror ? -p.positions[i] : p.positions[i]} ${p.positions[i + 1]} ${p.positions[i + 2]}`);
    for (let i = 0; i < p.index.length; i += 3) out.push(mirror ? `f ${p.index[i] + base} ${p.index[i + 2] + base} ${p.index[i + 1] + base}` : `f ${p.index[i] + base} ${p.index[i + 1] + base} ${p.index[i + 2] + base}`);
    base += p.positions.length / 3;
  }
  return out.join('\n') + '\n';
}

/**
 * Writes `<dir>/motion.json` and an OBJ per item beside it. Handhold's own space is glTF's, so by default nothing is mirrored;
 * `axes: 'unity'` writes everything the way a Unity exporter would (X flipped), which is how the reader's mirroring is tested.
 */
export function writeMotion(dir: string, body: Body, character: string, items: HeldItem[], clips: MotionClip[], axes: MotionFile['axes'] = 'gltf'): string {
  mkdirSync(dir, { recursive: true });
  const u = axes === 'unity';
  for (const it of items) writeFileSync(join(dir, `${it.name}.obj`), objText(it, u));
  const flip = (t: Xform): Xform => (u ? [-t[0], t[1], t[2], t[3], -t[4], -t[5], t[6]] : t);
  clips = clips.map((c) => ({ ...c, frames: c.frames.map((f) => ({ ...f, bones: f.bones.map(flip), items: f.items.map((x) => (x ? flip(x) : null)), camera: f.camera ? flip(f.camera) : undefined })) }));
  const file: MotionFile = {
    format: 'handhold-motion',
    version: 1,
    character,
    axes,
    bones: body.bones.map((b) => b.name),
    rest: body.bones.map((b) => { const p = new Vector3(), q = new Quaternion(); body.restWorld.get(b)!.decompose(p, q, new Vector3()); return flip(xf(p, q)); }),
    items: items.map((it) => ({ name: it.name, file: `${it.name}.obj`, style: it.style, forward: flip([...it.forward.toArray(), 0, 0, 0, 1]).slice(0, 3), up: flip([...it.up.toArray(), 0, 0, 0, 1]).slice(0, 3), mates: it.mates, mirrored: false })),
    clips,
  };
  const path = join(dir, 'motion.json');
  writeFileSync(path, JSON.stringify(file));
  return path;
}

// ---------------------------------------------------------------------------------------------------------------- reading

/** Unity is left-handed: X is mirrored on the way in, a position (x, y, z) to (-x, y, z) and a turn (x, y, z, w) to (x, -y, -z, w). */
function into(axes: MotionFile['axes'], t: Xform): { p: Vector3; q: Quaternion } {
  const m = axes === 'unity';
  return { p: new Vector3(m ? -t[0] : t[0], t[1], t[2]), q: new Quaternion(t[3], m ? -t[4] : t[4], m ? -t[5] : t[5], t[6]).normalize() };
}

/**
 * The best-fit turn, scale and move that takes points `a` onto points `b` (Horn's quaternion method): how the file's skeleton
 * lies against Handhold's own copy of the character, whatever either program did on import.
 */
export function lineUp(a: Vector3[], b: Vector3[]): { turn: Quaternion; scale: number; move: Vector3; rms: number } {
  const n = a.length;
  const ca = a.reduce((s, p) => s.add(p), new Vector3()).divideScalar(n), cb = b.reduce((s, p) => s.add(p), new Vector3()).divideScalar(n);
  const A = a.map((p) => p.clone().sub(ca)), B = b.map((p) => p.clone().sub(cb));
  const scale = Math.sqrt(B.reduce((s, p) => s + p.lengthSq(), 0) / Math.max(1e-12, A.reduce((s, p) => s + p.lengthSq(), 0)));
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = A[i].toArray(), y = B[i].toArray();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += x[r] * y[c];
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  // the largest eigenvector, by power iteration on N shifted to be positive
  const shift = N.reduce((s, r) => s + r.reduce((t, v) => t + Math.abs(v), 0), 0);
  let v = [1, 0, 0, 0];
  for (let it = 0; it < 500; it++) {
    const w = N.map((r, i) => r.reduce((s, x, j) => s + x * v[j], 0) + shift * v[i]);
    const l = Math.hypot(...w);
    v = w.map((x) => x / l);
  }
  const turn = new Quaternion(v[1], v[2], v[3], v[0]).normalize();
  const move = cb.clone().sub(ca.clone().applyQuaternion(turn).multiplyScalar(scale));
  const rms = Math.sqrt(a.reduce((s, p, i) => s + p.clone().applyQuaternion(turn).multiplyScalar(scale).add(move).distanceToSquared(b[i]), 0) / n);
  return { turn, scale, move, rms };
}

export interface LoadedMotion {
  file: MotionFile;
  body: Body;
  items: HeldItem[];
  /** For each of the file's bones, Handhold's bone (or null when the character has none by that name). */
  bones: (Bone | null)[];
  fit: ReturnType<typeof lineUp>;
}

export async function loadMotion(path: string, body?: Body): Promise<LoadedMotion> {
  const file = JSON.parse(readFileSync(path, 'utf8')) as MotionFile;
  if (file.format !== 'handhold-motion') throw new Error(`${path}: not a handhold-motion file`);
  const here = dirname(resolve(path));
  const at = (p: string) => (p === 'sample' || isAbsolute(p) ? p : resolve(here, p));
  const b = body ?? (await bodyFor(at(file.character)));
  const items = file.items.map((it) => loadItem({ name: it.name, obj: at(it.file), mirrored: file.axes === 'unity' ? it.mirrored === true : true, style: it.style ?? 'thing', forward: it.forward && into(file.axes, [...it.forward, 0, 0, 0, 1]).p.toArray(), up: it.up && into(file.axes, [...it.up, 0, 0, 0, 1]).p.toArray(), mates: typeof it.mates === 'string' ? [it.mates] : it.mates }));
  return { file, body: b, items, ...lineUpBones(file, b) };
}

export function lineUpBones(file: MotionFile, body: Body) {
  const byKey = new Map(body.bones.map((x) => [key(x.name), x]));
  const bones = file.bones.map((n) => byKey.get(key(n)) ?? null);
  const a: Vector3[] = [], b: Vector3[] = [];
  bones.forEach((bone, i) => { if (bone) { a.push(into(file.axes, file.rest[i]).p); b.push(new Vector3().setFromMatrixPosition(body.restWorld.get(bone)!)); } });
  if (a.length < 4) throw new Error(`only ${a.length} of the motion's bones are on the character`);
  return { bones, fit: lineUp(a, b) };
}

const depth = (b: Bone) => { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; };

/** Puts the body and items in one frame of a clip. */
export function poseFrame(m: LoadedMotion, clip: MotionClip, f: number) {
  const { file, body, bones, fit } = m;
  const frame = clip.frames[f];
  restPose(body);
  const inv = fit.turn.clone().invert();
  const order = bones.map((b, i) => ({ b, i })).filter((x) => x.b).sort((x, y) => depth(x.b!) - depth(y.b!));
  const top = order.length ? depth(order[0].b!) : 0;
  for (const { b, i } of order) {
    const now = into(file.axes, frame.bones[i]), rest = into(file.axes, file.rest[i]);
    // the bone's turn from rest in the file, carried into Handhold's space and put on Handhold's own rest turn
    const delta = fit.turn.clone().multiply(now.q).multiply(rest.q.clone().invert()).multiply(inv);
    const q = delta.multiply(restQuat(body, b!));
    const p = depth(b!) === top ? now.p.clone().applyQuaternion(fit.turn).multiplyScalar(fit.scale).add(fit.move) : worldPos(b!);
    setWorld(b!, p, q);
  }
  body.root.updateMatrixWorld(true);
  const fitM = new Matrix4().compose(fit.move, fit.turn, new Vector3(fit.scale, fit.scale, fit.scale));
  const shown: HeldItem[] = [];
  m.items.forEach((it, k) => {
    const x = frame.items[k];
    if (!x) return;
    const { p, q } = into(file.axes, x);
    it.matrix.copy(fitM.clone().multiply(new Matrix4().compose(p, q, new Vector3(1, 1, 1))));
    shown.push(it);
  });
  return shown;
}

// ---------------------------------------------------------------------------------------------------------------- checking

const worse = (c: Check, d: Check) => (c.below ? d.value > c.value : d.value < c.value);

/** The hand's own skin: the wrist's, shared with the forearm, follows the forearm as the arm moves and is not where the hand holds. */
function handVerts(body: Body, side: Side) {
  const r = side === 'right' ? Region.HandR : Region.HandL;
  const out: { part: number; v: number }[] = [];
  body.skin.forEach((s, pi) => { for (let v = 0; v < s.region.length; v++) if (s.region[v] === r && s.blend[v] === 255) out.push({ part: pi, v }); });
  return out;
}

/** Every check of one clip: the worst frame of each whole-pose check, then slip, joint speed and the ends. */
export function checkClip(m: LoadedMotion, clip: MotionClip): Check[] {
  const { body, file } = m;
  const n = clip.frames.length;
  const worst = new Map<string, Check>();
  const sides = [...new Set((clip.contacts ?? []).map((c) => c.hand))];
  const contacts = (clip.contacts ?? []).map((c) => ({ c, item: m.items.find((x) => x.name === c.item), verts: handVerts(body, c.hand), start: null as Vector3[] | null, slip: 0, frame: 0 }));
  for (const c of contacts) if (!c.item) throw new Error(`${clip.name}: contact on ${c.c.item}, which is not an item`);
  const local: Quaternion[][] = [];
  const p = new Vector3();
  for (let f = 0; f < n; f++) {
    const items = poseFrame(m, clip, f);
    for (const c of checkPose({ body, items, sides: sides.length ? sides : undefined })) {
      const d = { ...c, frame: f };
      const old = worst.get(c.id);
      if (!old || worse(old, d)) worst.set(c.id, d);
    }
    const t = clip.frames[f].t;
    const skin = contacts.some((c) => t >= c.c.from - 1e-9 && t <= c.c.to + 1e-9) ? posedSkin(body) : null;
    for (const c of contacts) {
      if (!skin || t < c.c.from - 1e-9 || t > c.c.to + 1e-9) continue;
      // the hand's skin in the held thing's own space: it must stay where it was when the span began
      const inv = c.item!.matrix.clone().invert();
      const now = c.verts.map(({ part, v }) => p.fromArray(skin[part], v * 3).applyMatrix4(inv).clone());
      if (!c.start) c.start = now;
      else now.forEach((x, i) => { const d = x.distanceTo(c.start![i]); if (d > c.slip) { c.slip = d; c.frame = f; } });
    }
    local.push(m.bones.map((b) => (b ? b.quaternion.clone() : new Quaternion())));
  }
  const out = [...worst.values()];
  for (const c of contacts) {
    const mm = Math.round(c.slip * 10000) / 10, lim = c.c.maxSlipMm ?? 1;
    out.push({ id: `contact.${c.c.hand}.${c.c.item}`, about: `${c.c.hand} hand stays on ${c.c.item} from ${c.c.from} s to ${c.c.to} s`, value: mm, unit: 'mm', limit: lim, below: true, pass: mm <= lim, frame: c.frame, note: c.start ? undefined : 'no frame inside the span' });
  }
  // joint speed: each bone's own turn (from its parent) between frames
  let fast = 0, fastBone = '', fastFrame = 0;
  for (let f = 1; f < n; f++) {
    const dt = clip.frames[f].t - clip.frames[f - 1].t;
    if (dt <= 0) continue;
    m.bones.forEach((b, i) => {
      if (!b) return;
      const deg = (local[f][i].angleTo(local[f - 1][i]) * 180) / Math.PI / dt;
      if (deg > fast) { fast = deg; fastBone = b.name; fastFrame = f; }
    });
  }
  out.push({ id: 'speed', about: `no joint turns faster than ${JOINT_SPEED} deg/s (fastest: ${fastBone || 'none'})`, value: Math.round(fast), unit: 'deg', limit: JOINT_SPEED, below: true, pass: fast <= JOINT_SPEED, frame: fastFrame, note: 'degrees a second' });
  out.push(...endChecks(m, clip, local));
  return out;
}

/** The ends: a loop's last frame against its first; a clip with a hold, both ends against the hold, and still. */
function endChecks(m: LoadedMotion, clip: MotionClip, local: Quaternion[][]): Check[] {
  const hold = clip.hold ? m.file.clips.find((c) => c.name === clip.hold) : null;
  if (!clip.loops && !hold) return [];
  const { file } = m;
  const pairs: [string, MotionClip['frames'][number], MotionClip['frames'][number]][] = clip.loops
    ? [['end', clip.frames[clip.frames.length - 1], clip.frames[0]]]
    : [['start', clip.frames[0], hold!.frames[0]], ['end', clip.frames[clip.frames.length - 1], hold!.frames[0]]];
  const out: Check[] = [];
  for (const [which, a, b] of pairs) {
    let mm = 0, deg = 0;
    m.bones.forEach((bone, i) => {
      if (!bone) return;
      const x = into(file.axes, a.bones[i]), y = into(file.axes, b.bones[i]);
      mm = Math.max(mm, x.p.distanceTo(y.p) * 1000 * m.fit.scale);
      deg = Math.max(deg, (x.q.angleTo(y.q) * 180) / Math.PI);
    });
    out.push({ id: `ends.${which}.place`, about: `the clip's ${which} is where ${clip.loops ? 'its start is' : `the hold (${clip.hold})`} has the bones`, value: Math.round(mm * 10) / 10, unit: 'mm', limit: ENDS.mm, below: true, pass: mm <= ENDS.mm });
    out.push({ id: `ends.${which}.turn`, about: `the clip's ${which} turns the bones as ${clip.loops ? 'its start does' : `the hold (${clip.hold})`} does`, value: Math.round(deg * 10) / 10, unit: 'deg', limit: ENDS.deg, below: true, pass: deg <= ENDS.deg });
  }
  // speed at the ends: a loop runs on at the speed it started with; a clip from a hold leaves it and lands on it from still
  const n = clip.frames.length;
  if (n >= 3) {
    const speed = (f: number) => local[f].map((q, i) => (q.angleTo(local[f - 1][i]) * 180) / Math.PI / Math.max(1e-9, clip.frames[f].t - clip.frames[f - 1].t));
    const s0 = speed(1), s1 = speed(n - 1);
    const jump = clip.loops ? Math.max(...s0.map((v, i) => Math.abs(v - s1[i]))) : Math.max(...s0, ...s1);
    out.push({ id: 'ends.speed', about: clip.loops ? 'the loop runs on at the speed it started with' : 'the clip leaves the hold and lands on it from still', value: Math.round(jump), unit: 'deg', limit: ENDS.speed, below: true, pass: jump <= ENDS.speed, note: 'degrees a second' });
  }
  return out;
}

/** The sheet for a clip: MOMENTS rows, each the clip at one moment from every view. */
export function clipSheet(m: LoadedMotion, clip: MotionClip, bad: number, size = 220) {
  const n = clip.frames.length;
  const picks = [...new Set(Array.from({ length: Math.min(MOMENTS, n) }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, Math.min(MOMENTS, n) - 1))))];
  const rows = picks.map((f) => {
    const items = poseFrame(m, clip, f);
    return poseRow({ body: m.body, items, marks: faultMarks(m.body, items) }, size, { caption: `${clip.name} ${clip.frames[f].t.toFixed(2)}S`, warn: bad ? `${bad} FAIL` : undefined });
  });
  restPose(m.body);
  return encodePng(stack(rows));
}

/** Checks every clip of a motion file, writes a sheet per clip and records each in the review. */
export async function checkMotion(path: string, outDir: string, review: Review, body?: Body): Promise<{ clip: string; checks: Check[]; sheet: string }[]> {
  const m = await loadMotion(path, body);
  const text = readFileSync(path, 'utf8');
  const out = [];
  for (const clip of m.file.clips) {
    const checks = [
      { id: 'lineup', about: `the motion's rest skeleton lies on the character (best fit)`, value: Math.round(m.fit.rms * 10000) / 10, unit: 'mm' as const, limit: 10, below: true, pass: m.fit.rms <= 0.01 },
      ...checkClip(m, clip),
    ];
    const bad = checks.filter((c) => !c.pass).length;
    const dir = join(outDir, clip.name);
    mkdirSync(dir, { recursive: true });
    const sheet = join(dir, 'sheet.png');
    writeFileSync(sheet, clipSheet(m, clip, bad));
    record(review, { name: clip.name, kind: 'motion', sheet: `${clip.name}/sheet.png`, pass: bad === 0, checks, fingerprint: fingerprint([text], checks) });
    out.push({ clip: clip.name, checks, sheet });
  }
  return out;
}
