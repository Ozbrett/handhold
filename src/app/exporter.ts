import {
  AnimationClip,
  type KeyframeTrack,
  Matrix4,
  type Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Grasp } from '../core/grasp/solver';
import type { HandModel } from '../core/hand/model';
import { type ArmRig, type HoldPose, letGo, meetHold, mixHold, solveArm } from './armIk';
import { type CharacterRig, poseCharacter } from './characterRig';
import { type HandPose, type RiggedHand, setHandPose } from './handRig';
import { type ClipFrame, type SavedLook, frameAt, lookHold } from './animations';

export interface ExportOptions {
  includeObject: boolean;
  includeAnimation: boolean;
}

/**
 * Writes the rigged hand, held in the grip, as a binary glTF file.
 * Optionally includes the object and a one-second "Grip" animation that
 * closes the fingers from the open pose.
 */
export async function exportGlb(
  hand: RiggedHand,
  object: Object3D | null,
  open: HandPose,
  grip: HandPose,
  options: ExportOptions,
): Promise<Blob> {
  const animations: AnimationClip[] = [];
  if (options.includeAnimation) {
    const sample = (pose: HandPose) => {
      setHandPose(hand, { wrist: grip.wrist, angles: pose.angles });
      return hand.bones.map((b) => b.quaternion.toArray());
    };
    const a = sample(open), b = sample(grip);
    const tracks = hand.bones
      .slice(1)
      .map((bone, i) => new QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, 1], [...a[i + 1], ...b[i + 1]]));
    animations.push(new AnimationClip('Grip', 1, tracks));
  }
  setHandPose(hand, grip);
  const input: Object3D[] = [hand.root];
  if (options.includeObject && object) input.push(object);
  const result = await withoutBrokenTextures(input, () => new GLTFExporter().parseAsync(input, { binary: true, animations, onlyVisible: true }));
  return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

/**
 * Runs an export with every texture whose picture never loaded taken off its material (an FBX often names image files that are
 * not beside it). The GLB exporter throws on those and the whole export was lost; the model goes out untextured there instead.
 */
async function withoutBrokenTextures<T>(roots: Object3D[], run: () => Promise<T>): Promise<T> {
  const removed: { material: Record<string, unknown>; key: string; value: unknown }[] = [];
  const usable = (img: unknown) => {
    const i = img as { width?: number; height?: number; data?: unknown } | null | undefined;
    return !!i && (i.width ?? 0) > 0 && (i.height ?? 0) > 0;
  };
  for (const root of roots)
    root.traverse((o) => {
      const mats = (o as { material?: unknown }).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        const mat = m as Record<string, unknown>;
        for (const key of Object.keys(mat)) {
          const v = mat[key] as { isTexture?: boolean; image?: unknown } | null;
          if (v && v.isTexture && !usable(v.image)) {
            removed.push({ material: mat, key, value: v });
            mat[key] = null;
          }
        }
      }
    });
  try {
    return await run();
  } finally {
    for (const r of removed) r.material[r.key] = r.value;
  }
}

/**
 * The grip as data for game code, for the freshly rigged hand (bones named
 * Wrist, Thumb1, Index1 ...). Same layout as the file written for a model's
 * own skeleton, so the same engine scripts read both.
 */
export function poseJson(hand: RiggedHand, grasp: Grasp, objectName: string | null, object: Object3D | null = null) {
  const round = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);
  const identity = new Matrix4();
  const world = () => {
    hand.root.updateMatrixWorld(true);
    return hand.bones.map((b) => {
      const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
      b.matrixWorld.decompose(p, q, sc);
      return { p, q };
    });
  };
  setHandPose(hand, { wrist: identity, angles: new Float32Array(hand.model.dofCount) });
  const rest = world();
  setHandPose(hand, { wrist: identity, angles: grasp.angles });
  const posed = world();
  const local = hand.bones.map((b) => b.quaternion.clone());
  let objectAtRest: { position: number[]; quaternion: number[]; scale: number[] } | null = null;
  if (object) {
    object.updateMatrix();
    const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
    new Matrix4().copy(grasp.wrist).invert().multiply(object.matrix).decompose(p, q, sc);
    objectAtRest = { position: round(p.toArray()), quaternion: round(q.toArray()), scale: round(sc.toArray()) };
  }
  setHandPose(hand, { wrist: grasp.wrist, angles: grasp.angles });
  return {
    format: 'handhold-pose',
    version: 3,
    skeleton: 'handhold',
    handedness: hand.model.handedness,
    object: objectName,
    stable: grasp.stable,
    gripForcePerWeight: Number.isFinite(grasp.effort) ? Math.round(grasp.effort * 1000) / 1000 : null,
    fingerSegmentsTouching: grasp.segmentsTouching,
    fingerSegments: grasp.segmentsTotal,
    handBone: hand.bones[0].name,
    objectAtRest,
    objectInHandBone: objectAtRest,
    bones: hand.bones.slice(1).map((b, k) => ({
      name: b.name,
      restQuaternion: round(hand.restLocal[k + 1].toArray()),
      quaternion: round(local[k + 1].toArray()),
      delta: round(posed[k + 1].q.clone().multiply(rest[k + 1].q.clone().invert()).toArray()),
    })),
    restPoints: hand.bones.map((b, k) => ({ name: b.name, position: round(rest[k].p.toArray()) })),
    arm: null,
    contacts: grasp.contacts.map((c) => ({
      point: round(c.point.toArray()),
      normal: round(c.normal.toArray()),
      finger: c.finger < 0 ? 'palm' : hand.model.fingers[c.finger].name,
    })),
  };
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * How the arm is meant to move in the game:
 * 'animation' - an animation (walk, run, idle) moves it, and only the fingers and the prop are added;
 * 'hold' - it stays at the exported hold position while the rest of the body animates;
 * 'camera' - it follows where the camera looks, along the exported sweep.
 */
export type ArmMode = 'animation' | 'hold' | 'camera';

/** An arm pose (and optional sweep between two poses) to export along with a grip. */
export interface ArmExport {
  arm: ArmRig;
  hold: HoldPose;
  sweep: { from: HoldPose; to: HoldPose } | null;
  mode: ArmMode;
  /** A second hand on the same object: its own rig, grip and arm. It follows the first hand wherever that goes. */
  support?: SupportExport | null;
  /** Saved animations, each written as an animation of its own. */
  clips?: ExportClip[];
  /** Saved still positions of the arm. */
  poses?: ExportPose[];
  /** Saved looks: the arm follows where the player looks. */
  looks?: SavedLook[];
}

/** A named arm motion: where the hand is held over time, and how far the second hand lets go. */
export interface ExportClip {
  name: string;
  frames: ClipFrame[];
  /** True for a cycle (idle, walk, run) that should repeat. */
  loops?: boolean;
}

/** A named still position of the arm. */
export interface ExportPose {
  name: string;
  hold: HoldPose;
}

/** A look is written as a grid of arm poses: this many across (left to right) and up (down to up). */
export const LOOK_COLUMNS = 5;
export const LOOK_ROWS = 5;
/** Keys in each of a look's two animations (down to up, left to right). */
const LOOK_KEYS = 9;

/** The view direction at a grid point of a look: yaw from left to right, pitch from down to up. */
function lookAngles(look: SavedLook, column: number, row: number, columns = LOOK_COLUMNS, rows = LOOK_ROWS) {
  return {
    yaw: -look.left + ((look.left + look.right) * column) / (columns - 1),
    pitch: -look.down + ((look.down + look.up) * row) / (rows - 1),
  };
}

/** Clips are written at this many keys per second. */
export const CLIP_FPS = 30;

/** Calls `visit` for each key of a clip, at CLIP_FPS, after placing both arms (and the second hand's fingers) for it. */
function sampleClip(armExport: ArmExport, grasp: Grasp, clip: ExportClip, visit: (t: number, away: number) => void) {
  const duration = clip.frames[clip.frames.length - 1].t;
  const n = Math.max(1, Math.round(duration * CLIP_FPS));
  const s = armExport.support;
  for (let k = 0; k <= n; k++) {
    const t = Math.min(duration, k / CLIP_FPS);
    const f = frameAt(clip.frames, t);
    placeArms(armExport, grasp, f.hold);
    if (s) {
      if (f.away > 0) solveArm(s.arm, letGo(s.arm, meetHold(armExport.arm, grasp.wrist, s.arm, s.grasp.wrist), f.away));
      poseCharacter(s.char, s.model, f.away > 0 ? s.grasp.angles.map((v) => v * (1 - f.away)) : s.grasp.angles);
    }
    visit(Math.round(t * 1e4) / 1e4, f.away);
  }
  if (s) poseCharacter(s.char, s.model, s.grasp.angles);
}

export interface SupportExport {
  char: CharacterRig;
  model: HandModel;
  grasp: Grasp;
  arm: ArmRig;
}

/** Places the first arm at a hold and the second hand (if any) on its own grip. */
function placeArms(armExport: ArmExport, grasp: Grasp, hold: HoldPose) {
  solveArm(armExport.arm, hold);
  const s = armExport.support;
  if (s) solveArm(s.arm, meetHold(armExport.arm, grasp.wrist, s.arm, s.grasp.wrist));
}

function restArms(armExport: ArmExport | null) {
  if (!armExport) return;
  solveArm(armExport.arm, null);
  if (armExport.support) solveArm(armExport.support.arm, null);
}

function fingerTracks(char: CharacterRig): KeyframeTrack[] {
  const tracks: KeyframeTrack[] = [];
  char.bones.forEach((bone, i) => {
    if (char.jointOf[i] === 0) return;
    tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, 1], [...char.restLocal[i].toArray(), ...bone.quaternion.toArray()]));
    if (char.free[i]) {
      tracks.push(new VectorKeyframeTrack(`${bone.name}.position`, [0, 1], [...char.restPosition[i].toArray(), ...bone.position.toArray()]));
    }
  });
  return tracks;
}

/**
 * Each finger bone as the grip holds it now, as tracks that keep it there for a whole clip. Every clip carries them: an engine
 * puts a bone that a clip leaves out back at its rest pose (Unreal does), which would open the hand.
 */
function heldFingers(char: CharacterRig): (duration: number) => KeyframeTrack[] {
  const held = char.bones.flatMap((bone, i) =>
    char.jointOf[i] === 0 ? [] : [{ name: bone.name, q: bone.quaternion.toArray(), p: char.free[i] ? bone.position.toArray() : null }],
  );
  return (duration) =>
    held.flatMap(({ name, q, p }) => [
      new QuaternionKeyframeTrack(`${name}.quaternion`, [0, duration], [...q, ...q]),
      ...(p ? [new VectorKeyframeTrack(`${name}.position`, [0, duration], [...p, ...p])] : []),
    ]);
}

const SWEEP_KEYS = 13;

/** Where the object sits relative to the character's hand bone for a grip (hand bone in its rest pose). */
function objectInHandBone(char: CharacterRig, grasp: Grasp, object: Object3D): Matrix4 {
  object.updateMatrix();
  // the solver moved the hand to the object; on a character the object comes to the hand instead
  return new Matrix4()
    .copy(char.handBone.matrixWorld)
    .invert()
    .multiply(new Matrix4().copy(grasp.wrist).invert())
    .multiply(object.matrix);
}

/** Unreal's FRotator::NormalizeAxis: an angle in degrees brought into (-180, 180]. */
function normalizeAxis(a: number): number {
  a %= 360;
  if (a > 180) a -= 360;
  else if (a <= -180) a += 360;
  return a;
}

/**
 * Where the prop goes on the hand bone, as an Unreal socket's relative location (cm), rotation (roll, pitch, yaw in degrees) and
 * scale. Unreal's glTF importer turns a position (x, y, z) into (x, z, y) and metres into centimetres, and a turn (x, y, z, w) into
 * (-x, -z, -y, w); the rotation is then read off the way FQuat::Rotator does. `boneScale` is the hand bone's own scale in the file.
 */
export function unrealSocket(inHand: Matrix4, boneScale: number) {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  inHand.decompose(p, q, s);
  const cm = 100 * boneScale;
  const x = -q.x, y = -q.z, z = -q.y, w = q.w;
  const deg = 180 / Math.PI;
  const test = z * x - w * y;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * deg;
  let pitch: number, roll: number;
  if (test < -0.4999995) {
    pitch = -90;
    roll = normalizeAxis(-yaw - 2 * Math.atan2(x, w) * deg);
  } else if (test > 0.4999995) {
    pitch = 90;
    roll = normalizeAxis(yaw - 2 * Math.atan2(x, w) * deg);
  } else {
    pitch = Math.asin(2 * test) * deg;
    roll = Math.atan2(-2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * deg;
  }
  const r = (v: number, k = 1e4) => Math.round(v * k) / k;
  return {
    location: [r(p.x * cm), r(p.z * cm), r(p.y * cm)],
    rotation: { roll: r(roll), pitch: r(pitch), yaw: r(yaw) },
    scale: [r(s.x * boneScale, 1e6), r(s.z * boneScale, 1e6), r(s.y * boneScale, 1e6)],
  };
}

/**
 * The name a bone had in the file it was loaded from. Loaders tidy names up
 * (the colon in "mixamorig:RightHand" is dropped, for one), but other
 * programs that open the same file keep the original, so that is what a pose
 * file should say.
 */
export function fileName(o: Object3D): string {
  const given = (o.userData?.name ?? o.userData?.originalName) as unknown;
  return typeof given === 'string' && given ? given : o.name;
}

const _wp = new Vector3(), _ws = new Vector3();
const worldQuat = (o: Object3D) => {
  const q = new Quaternion();
  o.matrixWorld.decompose(_wp, q, _ws);
  return q;
};

/**
 * Writes the original model, with its own skeleton, holding the object: its
 * finger bones are turned into the grip, the object is attached to its hand
 * bone and, if an arm pose is given, the arm is placed too. Adds a "Grip"
 * animation on the finger bones and a "Sweep" animation on the arm bones.
 */
export async function exportCharacterGlb(
  char: CharacterRig,
  model: HandModel,
  grasp: Grasp,
  object: Object3D | null,
  options: ExportOptions,
  armExport: ArmExport | null = null,
): Promise<Blob> {
  restArms(armExport);
  poseCharacter(char, model, grasp.angles);
  const support = armExport?.support ?? null;
  if (support) poseCharacter(support.char, support.model, support.grasp.angles);
  const held = heldFingers(char);
  const supportHeld = support ? heldFingers(support.char) : () => [];
  const animations: AnimationClip[] = [];
  if (options.includeAnimation) {
    animations.push(new AnimationClip('Grip', 1, [...fingerTracks(char), ...(support ? fingerTracks(support.char) : [])]));
  }
  let carried: Object3D | null = null;
  if (options.includeObject && object) {
    carried = object.clone(true);
    objectInHandBone(char, grasp, object).decompose(carried.position, carried.quaternion, carried.scale);
    char.handBone.add(carried);
  }
  if (armExport) {
    const { arm, hold, sweep } = armExport;
    const bones = [arm.upper, arm.fore, arm.hand];
    if (support) bones.push(support.arm.upper, support.arm.fore, support.arm.hand);
    if (sweep && options.includeAnimation) {
      const times: number[] = [];
      const values: number[][] = bones.map(() => []);
      for (let k = 0; k < SWEEP_KEYS; k++) {
        const t = k / (SWEEP_KEYS - 1);
        placeArms(armExport, grasp, mixHold(arm, sweep.from, sweep.to, t));
        times.push(t);
        bones.forEach((b, i) => values[i].push(...b.quaternion.toArray()));
      }
      animations.push(
        new AnimationClip(
          'Sweep',
          1,
          [...bones.map((b, i) => new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values[i])), ...held(1), ...supportHeld(1)],
        ),
      );
    }
    for (const clip of armExport.clips ?? []) {
      if (clip.frames.length < 2) continue;
      // the second hand's fingers only get keys when it lets go somewhere in the clip
      const fingers = support && clip.frames.some((f) => f.away > 0) ? support.char.bones.filter((_, i) => support.char.jointOf[i] > 0) : [];
      const times: number[] = [];
      const values: number[][] = bones.map(() => []);
      const fingerValues: number[][] = fingers.map(() => []);
      sampleClip(armExport, grasp, clip, (t) => {
        times.push(t);
        bones.forEach((b, i) => values[i].push(...b.quaternion.toArray()));
        fingers.forEach((b, i) => fingerValues[i].push(...b.quaternion.toArray()));
      });
      const duration = times[times.length - 1];
      animations.push(
        new AnimationClip(clip.name, duration, [
          ...bones.map((b, i) => new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values[i])),
          ...held(duration),
          ...(fingers.length ? fingers.map((b, i) => new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, fingerValues[i])) : supportHeld(duration)),
        ]),
      );
    }
    const armTracks = (times: number[], values: number[][]) => bones.map((b, i) => new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values[i]));
    // a still pose: the same key twice, one frame apart, so every program reads it as an animation
    for (const pose of armExport.poses ?? []) {
      placeArms(armExport, grasp, pose.hold);
      const values = bones.map((b) => [...b.quaternion.toArray(), ...b.quaternion.toArray()]);
      animations.push(new AnimationClip(pose.name, 1 / CLIP_FPS, [...armTracks([0, 1 / CLIP_FPS], values), ...held(1 / CLIP_FPS), ...supportHeld(1 / CLIP_FPS)]));
    }
    // a look: two one-second animations to blend by the view's pitch and yaw
    for (const look of armExport.looks ?? []) {
      for (const [suffix, across] of [['Down-Up', false], ['Left-Right', true]] as const) {
        const times: number[] = [];
        const values: number[][] = bones.map(() => []);
        for (let k = 0; k < LOOK_KEYS; k++) {
          const at = across ? lookAngles(look, k, 0, LOOK_KEYS, 2) : lookAngles(look, 0, k, 2, LOOK_KEYS);
          placeArms(armExport, grasp, lookHold(arm, look, across ? at.yaw : 0, across ? 0 : at.pitch));
          times.push(k / (LOOK_KEYS - 1));
          bones.forEach((b, i) => values[i].push(...b.quaternion.toArray()));
        }
        animations.push(new AnimationClip(`${look.name} ${suffix}`, 1, [...armTracks(times, values), ...held(1), ...supportHeld(1)]));
      }
    }
    placeArms(armExport, grasp, hold);
  }
  char.root.updateMatrixWorld(true);
  const wasVisible = char.root.visible;
  char.root.visible = true;
  try {
    const result = await withoutBrokenTextures([char.root], () => new GLTFExporter().parseAsync(char.root, { binary: true, animations, onlyVisible: false }));
    return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
  } finally {
    char.root.visible = wasVisible;
    if (carried) char.handBone.remove(carried);
  }
}

/**
 * The grip as data for game code. Everything is given two ways: as each
 * bone's own local rotation (for the exact same skeleton), and as a turn from
 * the rest pose measured in the model's space (`delta`), which stays valid
 * when another program has given the bones different local axes.
 */
export function characterPoseJson(
  char: CharacterRig,
  model: HandModel,
  grasp: Grasp,
  objectName: string | null,
  object: Object3D | null,
  armExport: ArmExport | null = null,
) {
  restArms(armExport);
  poseCharacter(char, model, grasp.angles);
  const support = armExport?.support ?? null;
  if (support) poseCharacter(support.char, support.model, support.grasp.angles);
  const round = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);
  const trs = (m: Matrix4) => {
    const p = new Vector3(), q = new Quaternion(), s = new Vector3();
    m.decompose(p, q, s);
    return { position: round(p.toArray()), quaternion: round(q.toArray()), scale: round(s.toArray()) };
  };
  const fingerBones = (char: CharacterRig) => char.bones
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => char.jointOf[i] > 0)
    .map(({ b, i }) => ({
      name: fileName(b),
      restQuaternion: round(char.restLocal[i].toArray()),
      quaternion: round(b.quaternion.toArray()),
      delta: round(worldQuat(b).multiply(char.restWorld[i].clone().invert()).toArray()),
      // only for bones with no parent bone in the hand, which have to be moved too
      ...(char.free[i] ? { position: round(b.position.toArray()) } : {}),
    }));
  const bones = fingerBones(char);
  // read while both arms are still at rest: a delta is the finger's own turn, not the arm's
  const secondBones = support ? fingerBones(support.char) : null;
  let objectAtRest: ReturnType<typeof trs> | null = null;
  let objectInHand: ReturnType<typeof trs> | null = null;
  let unreal: ({ socketBone: string } & ReturnType<typeof unrealSocket>) | null = null;
  if (object) {
    object.updateMatrix();
    objectAtRest = trs(new Matrix4().copy(grasp.wrist).invert().multiply(object.matrix));
    const inHand = objectInHandBone(char, grasp, object);
    objectInHand = trs(inHand);
    // the hand bone's scale in the exported file, whose root is the model's root
    char.root.updateMatrixWorld(true);
    const boneScale = new Vector3();
    new Matrix4().copy(char.root.parent?.matrixWorld ?? new Matrix4()).invert().multiply(char.handBone.matrixWorld).decompose(new Vector3(), new Quaternion(), boneScale);
    unreal = { socketBone: fileName(char.handBone), ...unrealSocket(inHand, boneScale.x) };
  }
  let arm: Record<string, unknown> | null = null;
  let secondHand: Record<string, unknown> | null = null;
  if (armExport) {
    const a = armExport.arm;
    const deltasOf = (r: ArmRig) => [r.upper, r.fore, r.hand].map((b, i) => round(worldQuat(b).multiply(r.restWorld[i].clone().invert()).toArray()));
    const deltas = (hold: HoldPose) => {
      placeArms(armExport, grasp, hold);
      return { first: deltasOf(a), second: support ? deltasOf(support.arm) : null };
    };
    const h = deltas(armExport.hold);
    const sweep: { t: number; upperArm: number[]; forearm: number[]; hand: number[] }[] = [];
    const supportSweep: typeof sweep = [];
    if (armExport.sweep) {
      for (let k = 0; k < SWEEP_KEYS; k++) {
        const t = k / (SWEEP_KEYS - 1);
        const d = deltas(mixHold(a, armExport.sweep.from, armExport.sweep.to, t));
        const at = Math.round(t * 1e4) / 1e4;
        sweep.push({ t: at, upperArm: d.first[0], forearm: d.first[1], hand: d.first[2] });
        if (d.second) supportSweep.push({ t: at, upperArm: d.second[0], forearm: d.second[1], hand: d.second[2] });
      }
    }
    // saved animations: the arm's turn from rest at each key, for both arms
    const clips = (armExport.clips ?? [])
      .filter((c) => c.frames.length > 1)
      .map((clip) => {
        const frames: { t: number; away: number; upperArm: number[]; forearm: number[]; hand: number[]; second?: { upperArm: number[]; forearm: number[]; hand: number[] } }[] = [];
        sampleClip(armExport, grasp, clip, (t, away) => {
          const first = deltasOf(a);
          const second = support ? deltasOf(support.arm) : null;
          frames.push({
            t,
            away: Math.round(away * 1e4) / 1e4,
            upperArm: first[0],
            forearm: first[1],
            hand: first[2],
            ...(second ? { second: { upperArm: second[0], forearm: second[1], hand: second[2] } } : {}),
          });
        });
        return { name: clip.name, fps: CLIP_FPS, duration: frames[frames.length - 1].t, loops: !!clip.loops, frames };
      });
    type ArmTurns = { upperArm: number[]; forearm: number[]; hand: number[] };
    const turnsAt = (hold: HoldPose): ArmTurns & { second?: ArmTurns } => {
      const d = deltas(hold);
      return {
        upperArm: d.first[0],
        forearm: d.first[1],
        hand: d.first[2],
        ...(d.second ? { second: { upperArm: d.second[0], forearm: d.second[1], hand: d.second[2] } } : {}),
      };
    };
    // saved still positions, by name
    const poses = (armExport.poses ?? []).map((p) => ({ name: p.name, ...turnsAt(p.hold) }));
    // saved looks: a grid of arm poses over the view's yaw (left to right) and pitch (down to up), row by row from the lowest
    const looks = (armExport.looks ?? []).map((look) => {
      const grid: ({ yaw: number; pitch: number } & ReturnType<typeof turnsAt>)[] = [];
      for (let r = 0; r < LOOK_ROWS; r++)
        for (let c = 0; c < LOOK_COLUMNS; c++) {
          const at = lookAngles(look, c, r);
          grid.push({ yaw: Math.round(at.yaw * 100) / 100, pitch: Math.round(at.pitch * 100) / 100, ...turnsAt(lookHold(a, look, at.yaw, at.pitch)) });
        }
      return { name: look.name, yaw: [-look.left, look.right], pitch: [-look.down, look.up], columns: LOOK_COLUMNS, rows: LOOK_ROWS, grid };
    });
    placeArms(armExport, grasp, armExport.hold);
    if (support) {
      const s = support.arm;
      // the second hand bone's place on the object, for an engine's own IK to aim at
      const handOnObject = new Matrix4().copy(support.grasp.wrist).multiply(s.handRestMatrix);
      // Where the second hand bone is while the first hand bone is at rest, and how far it has
      // turned from its own rest. Wherever the first hand goes, carry this along with it.
      const atFirstRest = new Matrix4().copy(grasp.wrist).invert().multiply(handOnObject);
      const reachAt = new Vector3(), reachTurn = new Quaternion(), restTurn = new Quaternion();
      atFirstRest.decompose(reachAt, reachTurn, new Vector3());
      s.handRestMatrix.decompose(new Vector3(), restTurn, new Vector3());
      secondHand = {
        handedness: support.model.handedness,
        handBone: fileName(s.hand),
        bones: secondBones,
        reach: { position: round(reachAt.toArray()), delta: round(reachTurn.multiply(restTurn.invert()).toArray()) },
        handBoneInObject: trs(object ? new Matrix4().copy(object.matrix).invert().multiply(handOnObject) : handOnObject),
        arm: {
          upperArm: fileName(s.upper),
          forearm: fileName(s.fore),
          hand: fileName(s.hand),
          forearmLength: Math.round(s.foreLength * 1e6) / 1e6,
          hold: { upperArm: h.second![0], forearm: h.second![1], hand: h.second![2] },
          sweep: supportSweep,
        },
      };
    }
    arm = {
      mode: armExport.mode,
      upperArm: fileName(a.upper),
      forearm: fileName(a.fore),
      hand: fileName(a.hand),
      forearmLength: Math.round(a.foreLength * 1e6) / 1e6,
      // the way the character faces, in the model's space: a look's yaw is measured from here
      forward: round(a.forward.toArray()),
      hold: { upperArm: h.first[0], forearm: h.first[1], hand: h.first[2] },
      sweep,
      clips,
      poses,
      looks,
    };
  }
  // Rest positions of every bone this file names, in the model's space. An
  // importer lines these up with the same bones in its own scene to find the
  // turn and scale between the two, whatever axes or units its loader chose.
  const points = new Map<string, Vector3>();
  char.bones.forEach((b, i) => points.set(fileName(b), char.restHead[i]));
  if (armExport) {
    const a = armExport.arm;
    points.set(fileName(a.upper), a.shoulder);
    points.set(fileName(a.fore), a.elbow);
    points.set(fileName(a.hand), a.wrist);
    if (support) {
      support.char.bones.forEach((b, i) => points.set(fileName(b), support.char.restHead[i]));
      points.set(fileName(support.arm.upper), support.arm.shoulder);
      points.set(fileName(support.arm.fore), support.arm.elbow);
      points.set(fileName(support.arm.hand), support.arm.wrist);
    }
  }
  const restPoints = [...points].map(([name, at]) => ({ name, position: round(at.toArray()) }));
  return {
    format: 'handhold-pose',
    version: 3,
    skeleton: 'original',
    handedness: model.handedness,
    object: objectName,
    stable: grasp.stable,
    gripForcePerWeight: Number.isFinite(grasp.effort) ? Math.round(grasp.effort * 1000) / 1000 : null,
    handBone: fileName(char.handBone),
    // where the object is, in the model's space, while the hand is in its rest pose
    objectAtRest,
    // the same thing relative to the hand bone's own axes
    objectInHandBone: objectInHand,
    // the same again as an Unreal socket on the hand bone, for the prop imported from its own glTF file
    unreal,
    bones,
    restPoints,
    arm,
    // a second hand on the same object (two-handed grips), or null
    secondHand,
    fingerSegmentsTouching: grasp.segmentsTouching,
    fingerSegments: grasp.segmentsTotal,
  };
}
