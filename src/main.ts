import './styles.css';
import { Box3, Euler, Group, Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import { fitPoints } from './core/fit';
import { GraspObject } from './core/grasp/object';
import { type Grasp, solveGrasp } from './core/grasp/solver';
import { pairGrasps } from './core/grasp/twoHands';
import { type HandAnalysis, analyzeHandMesh } from './core/hand/analyze';
import { type LocatedHand, locateHands } from './core/hand/locate';
import { type HandModel, type JointDof, openPose } from './core/hand/model';
import { type ArmRig, BODY_LIMITS, type FreeArm, findOtherArm, hangArm, type BodyLimits, type HoldPose, type WristReport, buildArmRig, setBodyLimits, clampToReach, defaultHold, holdGap, letGo, meetHold, mixHold, reachOf, solveArm } from './app/armIk';
import { type BoneHinge, type CharacterRig, buildCharacterRig, poseCharacter, transferError, useHinges } from './app/characterRig';
import { reachFingertip } from './core/grasp/pin';
import { graspQuality } from './core/grasp/quality';
import { type ArmExport, type ArmMode, characterPoseJson, download, exportCharacterGlb, exportGlb, poseJson } from './app/exporter';
import { type Engine, type EnginePackage, blenderPackage, godotPackage, unityPackage } from './app/packages';
import { type HandPose, type RiggedHand, buildRiggedHand } from './app/handRig';
import { onOwnSkeleton } from './app/ownSkeleton';
import { type Baked, bakeToTriMesh, loadModelFile, looksLikeCharacter, subsetBaked } from './app/loaders';
import { SAMPLE_OBJECTS, sampleCharacter, sampleHand } from './app/samples';
import { Panel, type PanelActions, type PanelState, type StepId } from './app/ui';
import {
  ClipPlayer,
  type ItemStyle,
  LOOK_DEFAULTS,
  MOTIONS,
  type MotionKind,
  type Saved,
  type SavedClip,
  type SavedLook,
  type SavedPose,
  copyHold,
  generateMotion,
  lookHold,
  motionLabel,
  motionLoops,
} from './app/animations';
import { Viewer } from './app/viewer';
import { type GuardResult, SkinGuard } from './app/skinGuard';
import { type ArmBones, mainChild, turnWrist } from './app/skinCheck';

interface HandEntry {
  name: string;
  source: Object3D;
  rig: RiggedHand;
  flip: boolean;
  restBox: Box3;
  /** When the hand was cut out of a bigger model: which of that model's vertices it uses. */
  subset: Uint8Array | null;
  /** The model's own skeleton matched to the solved hand, if it has one. */
  char: CharacterRig | null;
  /** The arm above that hand, if the model has one. */
  arm: ArmRig | null;
  /** The other arm, which hangs at the side while it holds nothing. */
  free: FreeArm | null;
  /** The geometry the rig is built from (already cut out if it came from a character), and the whole model. */
  baked: Baked;
  full: Baked;
  /** Corrections made by hand in bone editing. */
  edits: { joints: Record<string, [number, number, number][]>; thumbTurn: number };
}

interface ObjectEntry {
  name: string;
  source: Object3D;
  holder: Group;
  baseScale: number;
  scaleLog: number;
  rescaled: boolean;
  turns: Quaternion;
  grasp: GraspObject;
  box: Box3;
}

const viewer = new Viewer(document.getElementById('viewport')!);
const hintEl = document.getElementById('hint')!;
const viewportEl = document.getElementById('viewport')!;

let hand: HandEntry | null = null;
let object: ObjectEntry | null = null;
let grip: { point: Vector3; normal: Vector3 } | null = null;
/** "Hold it this way" for the first and second hand, in the solve space (set from the address: at, fingers, thumb). */
let aim1: { fingers: Vector3; thumb: Vector3 } | null = null;
let aim2: { fingers: Vector3; thumb: Vector3 } | null = null;
/** Something else carries the object's weight (the other hand, a shoulder, a sling): each hand is judged with the weight at its own spot. */
let carried = false;
/**
 * The first hand placed already, as an engine puts it (set from the address: place): the wrist transform in the solve space, the
 * fingers left straight, and how well the named bones lined up (metres left over, and the scale between the two skeletons).
 */
/** An engine's own finger hinges by bone name (setHinges): the solver bends the character's fingers only about these. */
let hinges: Map<string, BoneHinge> | null = null;
let hinged: ReturnType<typeof useHinges> | null = null;
let placed: { wrist: Matrix4; relax: string[]; adjust?: { move: number; turn: number }; reach?: { finger: number; point: Vector3 }; rms: number; scale: number; bones: number } | null = null;
let grasps: Grasp[] | null = null;
let solveToken: { cancelled: boolean } | null = null;
let pendingHands: { source: Object3D; name: string; hands: LocatedHand[] } | null = null;
/** Looser cut of the hand being loaded, tried if the tight cut cannot be rigged. */
let widerSubset: Uint8Array | null = null;
/** How many fingers the search saw on that hand; the rig should not end up with fewer. */
let expectedFingers = 0;

const ui: PanelState = {
  open: 1,
  hand: null,
  handBusy: false,
  handError: null,
  handChoice: null,
  handChoiceNote: null,
  object: null,
  objectError: null,
  grip: false,
  mode: 'fixed',
  friction: 0.6,
  solving: false,
  grasps: null,
  selected: 0,
  exportObject: true,
  exportAnimation: true,
  exporting: false,
  exportingFor: null,
  exported: null,
  armMode: 'animation',
  characterAvailable: false,
  exportCharacter: true,
  editing: false,
  curl: 0,
  thumbTurn: 0,
  edited: false,
  armAvailable: false,
  turn: [0, 0, 0],
  wristText: '',
  wristMiss: 0,
  reachText: '',
  sweepFrom: false,
  sweepTo: false,
  sweepT: 0,
  pinFinger: 1,
  pinPicking: false,
  pinSet: false,
  pinMiss: 0,
  skinNote: '',
  skinWarn: false,
  twoHandsAvailable: false,
  twoHands: false,
  grip2: false,
  supportText: '',
  supportShort: false,
  tab: 'grip',
  characterHands: null,
  characterPicked: -1,
  bodyLimits: { ...BODY_LIMITS },
  limitFinger: 1,
  limitsChanged: false,
  objectAngles: [0, 0, 0],
  nudge: [0, 0, 0, 0, 0, 0],
  nudging: false,
  itemStyle: 'everyday',
  saved: [],
  shown: -1,
  clipPlaying: false,
  clipTime: 0,
  lookAim: [0, 0],
  gizmoOn: 'hand',
  canEditShown: false,
};
let characterView = false;
const DEG = Math.PI / 180;
/** How far the arms may turn (Character tab); every arm that is built gets these. */
const bodyLimits = ui.bodyLimits;
/** Finger limits set on the Character tab, by joint name and kind of turn ("index_1/flex"), radians [min, max]. */
let fingerLimits: Record<string, [number, number]> = {};
/** Each changed finger turn's automatic range, to go back to. */
const fingerOriginal = new WeakMap<JointDof, { min: number; max: number; open: number; closed: number }>();
/** Everything saved on the Animations tab: poses, animations and looks. All of it goes into the export. */
let saved: Saved[] = [];
/** The saved item shown on the character (Animations tab): its hold for this frame, and how far (0..1) the second hand has let go. */
let preview: { hold: HoldPose; away: number } | null = null;
/** The grips as found, before the item was moved in the hand. */
let foundGrasps: Grasp[] | null = null;

/** An arm for a character's hand, with the Character tab's limits. */
function armFor(char: CharacterRig, palm?: Parameters<typeof buildArmRig>[1]): ArmRig | null {
  const arm = buildArmRig(char, palm);
  if (arm) setBodyLimits(arm, bodyLimits);
  return arm;
}

/** Puts the Character tab's finger limits on a hand (the same for both hands: joints are named by finger). */
function applyFingerLimits(model: HandModel) {
  for (const j of model.joints)
    for (const d of j.dofs) {
      const l = fingerLimits[`${j.name}/${d.kind}`];
      const was = fingerOriginal.get(d);
      if (!l) {
        if (was) Object.assign(d, was);
        continue;
      }
      if (!was) fingerOriginal.set(d, { min: d.min, max: d.max, open: d.open, closed: d.closed });
      d.min = l[0];
      d.max = l[1];
      if (d.kind === 'flex') d.closed = l[1];
      d.open = Math.min(d.max, Math.max(d.min, d.open));
      d.closed = Math.min(d.max, Math.max(d.min, d.closed));
    }
}

/** The labels of a whole character's hands, as the Hand step shows them. */
function handLabels(hands: LocatedHand[]): string[] {
  const clash = new Set(hands.map((h) => h.handedness)).size < hands.length;
  return hands.map((h, i) => (clash ? `Hand ${i + 1}` : h.handedness === 'left' ? 'Left hand' : 'Right hand'));
}

/** The first hand's grip with the item moved in the hand (ui.nudge): the item moves about the grip point, so the hand moves the other way. */
function nudgedWrist(base: Matrix4): Matrix4 {
  const n = ui.nudge, size = handSize();
  const p = grip?.point ?? new Vector3();
  const d = new Matrix4()
    .makeTranslation(p.x, p.y, p.z)
    .multiply(new Matrix4().makeRotationFromEuler(new Euler(n[3] * DEG, n[4] * DEG, n[5] * DEG, 'XYZ')))
    .multiply(new Matrix4().makeTranslation(-p.x, -p.y, -p.z))
    .premultiply(new Matrix4().makeTranslation((n[0] / 100) * size, (n[1] / 100) * size, (n[2] / 100) * size));
  return d.invert().multiply(base);
}

/** Closes the fingers again on the item where it was moved to in the hand. */
async function closeAgain() {
  const index = ui.selected;
  const base = foundGrasps?.[index];
  if (!base || !grasps || !hand || !object || !grip) return;
  const list = grasps;
  if (ui.nudge.every((v) => v === 0)) {
    list[index] = base;
  } else {
    ui.nudging = true;
    sync();
    const found = await solveGrasp(hand.rig.model, object.grasp, {
      gripPoint: grip.point,
      gripNormal: grip.normal,
      wrist: nudgedWrist(base.wrist),
      relax: [],
      mode: ui.mode,
      friction: ui.friction,
      ...(carried ? { com: grip.point } : {}),
    });
    ui.nudging = false;
    if (grasps !== list) return sync();
    if (found[0]) list[index] = found[0];
  }
  selectGrasp(index, 200);
  sync();
}

/** What the view shows for the open tab: the whole character on the Character and Animations tabs. */
function showTab() {
  if (!hand) return;
  const whole = ui.tab !== 'grip' && !!hand.char && !ui.editing;
  if (whole && grasps?.length) {
    characterView = true;
    if (hand.arm) {
      armOn = true;
      hold ??= defaultHold(hand.arm);
    }
    viewer.setObjectVisible(true);
    if (ui.tab === 'animations') showSaved(ui.shown);
    applyCharacterView(false);
    viewer.frameBox(new Box3().setFromObject(hand.source), 400);
  } else if (whole) {
    // no grip yet: the character on its own, at rest
    poseCharacter(hand.char!, hand.rig.model, null);
    viewer.setObjectVisible(false);
    viewer.setCharacterView(true);
    viewer.frameBox(new Box3().setFromObject(hand.source), 400);
  } else {
    viewer.setObjectVisible(!ui.editing);
    if (grasps?.length) applyCharacterView(true);
    else if (viewer.characterView) {
      viewer.setCharacterView(false);
      viewer.frame(400);
    }
  }
}

/** Plays the saved animation that is shown. */
const player = new ClipPlayer(
  (f) => {
    preview = { hold: f.hold, away: f.away };
    applyCharacterView(false);
  },
  () => {
    ui.clipPlaying = player.playing;
    ui.clipTime = player.time;
    sync();
  },
  (time, duration) => {
    ui.clipTime = time;
    panel.setClipTime(time, duration);
  },
);

/** Shows a saved item on the character (Animations tab); -1 goes back to the Arm step's position. */
function showSaved(index: number, autoplay = true) {
  player.clear();
  const item = saved[index];
  ui.shown = item ? index : -1;
  ui.lookAim = [0, 0];
  preview = null;
  if (item && hand?.arm && grasps?.length) {
    if (item.kind === 'pose') preview = { hold: item.hold, away: 0 };
    else if (item.kind === 'look') preview = { hold: lookHold(hand.arm, item, 0, 0), away: 0 };
    else {
      player.load(item.frames, item.loops);
      if (autoplay) player.play();
    }
  }
  ui.clipPlaying = player.playing;
  ui.clipTime = 0;
  if (characterView) applyCharacterView(false);
}

/** Forgets what the Animations tab was showing (the saved list itself is kept). */
function stopPreview() {
  player.clear();
  preview = null;
  ui.clipPlaying = false;
}
// arm pose: where the hand is held, and an optional sweep between two holds
let armOn = false;
let hold: HoldPose | null = null;
let sweepFrom: HoldPose | null = null;
let sweepTo: HoldPose | null = null;
let sweepActive = false;
// a fingertip pinned to a spot on the object (object space)
let pin: { finger: number; point: Vector3 } | null = null;
/** Each grip's hand as the solver left it, and the pin it was settled for (see settle). */
const settledFrom = new WeakMap<Grasp, { key: string; wrist: Matrix4; angles: Float32Array; result: GuardResult }>();
let guards: { rig: RiggedHand; object: GraspObject; guard: SkinGuard }[] = [];
/** While the item is dragged in the hand, the hand only moves; it is settled again when let go. */
let dragging = false;

function guardFor(rig: RiggedHand, o: GraspObject): SkinGuard {
  let e = guards.find((x) => x.rig === rig && x.object === o);
  if (!e) {
    e = { rig, object: o, guard: new SkinGuard(rig, o) };
    guards = [e, ...guards].slice(0, 4);
  }
  return e.guard;
}

/**
 * A grip as it is shown and exported: the pinned fingertip (if any) moved onto its spot, then the hand's own skin taken out of
 * the item (SkinGuard). The solver keeps its collision spheres clear, but the skin over them reaches further, so without this a
 * knuckle, a thumb's root or the heel of the palm could sit inside the item. The grip is changed in place, once per pin.
 */
function settle(g: Grasp, rig: RiggedHand | undefined = hand?.rig): Grasp {
  if (!rig || !object || dragging) return g;
  const main = rig === hand?.rig;
  const key = main && pin ? `${pin.finger}:${pin.point.toArray().join(',')}` : '';
  const was = settledFrom.get(g);
  if (was && was.key === key) return g;
  const from = was ?? { wrist: g.wrist.clone(), angles: g.angles.slice() };
  let angles = from.angles;
  const keep: number[] = [];
  if (main && pin) {
    const target = pin.point.clone().applyMatrix4(from.wrist.clone().invert());
    const r = reachFingertip(rig.model, angles, pin.finger, target);
    ui.pinMiss = r.miss / rig.model.size;
    angles = r.angles;
    keep.push(pin.finger);
  }
  // fingers laid along the item stay laid along it
  if (main && placed?.relax.length) {
    const relaxed = new Set(placed.relax.map((n) => n.toLowerCase()));
    rig.model.fingers.forEach((f, i) => relaxed.has(f.name.toLowerCase()) && keep.push(i));
  }
  const guard = guardFor(rig, object.grasp);
  let result = guard.clear(from.wrist, angles, { keep });
  // the hand moved out of the part takes the pinned fingertip off its point: reach for it again from there, and keep the skin out again
  for (let i = 0; i < 2 && main && pin && result.moved > 0.0005; i++) {
    const target = pin.point.clone().applyMatrix4(result.wrist.clone().invert());
    const r = reachFingertip(rig.model, result.angles, pin.finger, target);
    const again = guard.clear(result.wrist, r.angles, { keep });
    if (!again.clear && result.clear) break;
    ui.pinMiss = r.miss / rig.model.size;
    result = { ...again, before: result.before, moved: result.moved + again.moved, changes: [...result.changes, ...again.changes] };
  }
  g.wrist.copy(result.wrist);
  g.angles = result.angles;
  // the dots and the verdict are the drawn skin's own: the solver's came from its spheres, before the hand was moved out of the part
  g.contacts = guard.contacts(result.wrist, result.angles);
  const fingers = g.contacts.filter((c) => c.finger >= 0);
  g.fingersTouching = new Set(fingers.map((c) => c.finger)).size;
  g.palmTouching = g.contacts.some((c) => c.finger < 0);
  g.thumbTouching = g.contacts.some((c) => c.finger >= 0 && rig.model.fingers[c.finger].isThumb);
  g.segmentsTouching = new Set(fingers.map((c) => c.finger * 8 + c.link)).size;
  if (!supportGrasps) {
    const q = graspQuality(g.contacts, {
      friction: ui.friction,
      gravity: new Vector3(0, -1, 0),
      com: object.grasp.com,
      lever: Math.min(Math.max(object.grasp.radius, 0.1 * rig.model.size), 0.6 * rig.model.size),
      mode: ui.mode,
    });
    g.stable = q.stable && q.effort <= 12;
    g.effort = q.effort;
    g.robustness = q.robustness;
  }
  settledFrom.set(g, { key, wrist: from.wrist, angles: from.angles, result });
  return g;
}

/** What settling did to a grip, for the panel. */
function skinNote(g: Grasp | undefined): { text: string; warn: boolean } {
  const r = g && settledFrom.get(g)?.result;
  if (!r) return { text: '', warn: false };
  const mm = (m: number) => `${(m * 1000).toFixed(1)} mm`;
  if (!r.clear) return { text: `This grip leaves skin ${mm(r.after.worst)} inside the item even with the hand moved out ${mm(r.moved)}. Pick another grip, or mark the grip point somewhere more open.`, warn: true };
  if (r.before.worst <= 0.001) return { text: 'No skin inside the item.', warn: false };
  return { text: `Skin kept out of the item (it was ${mm(r.before.worst)} in)${r.moved > 0 ? `: the hand moved out ${mm(r.moved)}` : ''}${r.changes.length > (r.moved > 0 ? 1 : 0) ? ', fingers turned to rest on it' : ''}.`, warn: false };
}
// two-handed grips: the character's other hand, its grip point, and its grip for each entry in `grasps`
interface SupportEntry {
  name: string;
  rig: RiggedHand;
  char: CharacterRig;
  arm: ArmRig;
}
let support: SupportEntry | null = null;
let grip2: { point: Vector3; normal: Vector3 } | null = null;
let supportGrasps: Grasp[] | null = null;
/** Which of the character's hands (in `pendingHands`) is the main hand. */
let pickedHand = -1;
const supportReport: WristReport = { flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 };

// ---------- bone editing ----------

let editJoint = -1;

/** The hand on its own, at rest or curled by the curl-test amount, for checking and editing the rig. */
function showEditPose() {
  if (!hand) return;
  const m = hand.rig.model;
  const angles = new Float32Array(m.dofCount);
  for (const j of m.joints)
    j.dofs.forEach((d, k) => {
      if (d.kind === 'flex') angles[j.dofStart + k] = d.open + (d.closed - d.open) * ui.curl;
    });
  viewer.setPose({ wrist: new Matrix4(), angles }, 0);
  // joints can be picked and moved only in the rest pose
  const canMove = ui.curl < 0.005;
  viewer.setJointHandles(canMove ? m.joints.map((j) => j.position) : null, (i) => {
    if (i === 0) return;
    editJoint = i;
    showEditPose();
  });
  const selected = canMove && editJoint > 0 && editJoint < m.joints.length;
  viewer.setHoldGizmo(selected ? m.joints[editJoint].position : null, undefined, (p) => moveJoint(editJoint, p));
}

function moveJoint(index: number, to: Vector3) {
  if (!hand || index <= 0) return;
  const m = hand.rig.model;
  const fi = m.fingers.findIndex((f) => f.joints.includes(index));
  if (fi < 0 || m.joints[index].position.distanceTo(to) < 1e-9) return;
  const f = m.fingers[fi];
  hand.edits.joints[f.name] = f.joints.map((j) => (j === index ? to : m.joints[j].position).toArray() as [number, number, number]);
  rebuildHand();
}

/** Fits the rig again with the hand-made corrections applied. */
function rebuildHand() {
  if (!hand) return;
  // the rest pose is read from the bones: put the free arm back first
  if (hand.free) hangArm(hand.free, false);
  try {
    const options = { flipPalm: hand.flip, joints: hand.edits.joints, thumbTurn: (hand.edits.thumbTurn * Math.PI) / 180 };
    const own = onOwnSkeleton(hand.source, hand.full, hand.subset, hand.baked, analyzeHandMesh(hand.baked.mesh, options), options);
    const analysis = own.analysis;
    hand.char = own.char;
    hinged = hand.char && hinges ? useHinges(hand.char, analysis.model, hinges) : null;
    applyFingerLimits(analysis.model);
    hand.rig = buildRiggedHand(hand.baked, analysis);
    hand.arm = hand.char ? armFor(hand.char, analysis.model.frame) : null;
    hand.free = hand.char && hand.arm ? findOtherArm(hand.char, hand.arm) : null;
    hold = sweepFrom = sweepTo = null;
    saved = [];
    ui.shown = -1;
    viewer.setHand(hand.rig);
    viewer.setCharacter(hand.char ? hand.source : null);
    clearGrips(false);
    ui.handError = null;
  } catch (e) {
    ui.handError = e instanceof Error ? e.message : String(e);
  }
  if (ui.editing) showEditPose();
  else viewer.setPose(parkedPose(), 0);
  if (ui.tab !== 'grip') showTab();
  sync();
}

/** The grip's joint angles as shown: settled (the pinned fingertip on its spot, the skin out of the item). */
function anglesOf(g: Grasp): Float32Array {
  return settle(g).angles;
}

/** The Arm step's position, or the point along its sweep being looked at. */
function armHold(): HoldPose | null {
  if (!armOn || !hand?.arm || !hold) return null;
  if (sweepActive && sweepFrom && sweepTo) return mixHold(hand.arm, sweepFrom, sweepTo, ui.sweepT);
  return hold;
}

/** Where the arm is shown: the saved item open on the Animations tab, otherwise the Arm step's position. */
function currentHold(): HoldPose | null {
  if (preview && hand?.arm && ui.tab === 'animations') return preview.hold;
  return armHold();
}

/** The position the drag handle and the turn sliders change: the Arm step's, or the saved pose (or a look's centre) that is shown. */
function editTarget(): HoldPose | null {
  if (!hand?.arm || !grasps?.length) return null;
  if (ui.tab === 'grip') return ui.open === 5 && armOn ? hold : null;
  if (ui.tab !== 'animations') return null;
  const item = saved[ui.shown];
  if (item?.kind === 'pose') return item.hold;
  if (item?.kind === 'look' && ui.lookAim[0] === 0 && ui.lookAim[1] === 0) return item.centre;
  return null;
}

/** The edited position changed: what is shown follows it. */
function targetChanged() {
  const item = saved[ui.shown];
  if (ui.tab === 'animations' && item?.kind === 'look' && hand?.arm) preview = { hold: lookHold(hand.arm, item, ui.lookAim[0], ui.lookAim[1]), away: 0 };
  sweepActive = false;
  applyCharacterView(false);
}

/** The drag handle in the view was moved to `p`: it carries the hand, or the item with the hand following. */
function handleMoved(p: Vector3) {
  const t = editTarget();
  if (!t || !hand?.arm) return;
  if (ui.gizmoOn === 'item') moveItemTo(t, p);
  else t.position.copy(clampToReach(hand.arm, p));
  targetChanged();
}

/** Where the middle of the held item is, in the view, with the arm at a hold. */
function itemCentre(h: HoldPose): Vector3 | null {
  const g = grasps?.[ui.selected];
  if (!g || !hand?.arm || !object) return null;
  const carried = solveArm(hand.arm, h).multiply(hand.arm.handRestInverse);
  return object.box.getCenter(new Vector3()).applyMatrix4(carried.multiply(g.wrist.clone().invert()));
}

/** Moves a hold so the item's middle lands on `to`: the hand goes with the item. */
function moveItemTo(h: HoldPose, to: Vector3, passes = 1) {
  if (!hand?.arm) return;
  for (let k = 0; k < passes; k++) {
    const at = itemCentre(h);
    if (!at || at.distanceToSquared(to) < 1e-10) return;
    h.position.copy(clampToReach(hand.arm, h.position.clone().add(to).sub(at)));
  }
}

/** What the user picked for how the arm moves in their game; null until they pick. */
let armChoice: ArmMode | null = null;

/** How the arm is meant to move in the game: the user's pick, or what suits what was set up. */
function armMode(): ArmMode {
  if (armChoice) return armChoice;
  if (saved.some((s) => s.kind === 'look')) return 'camera';
  if (!armOn || !hold) return 'animation';
  return sweepFrom && sweepTo ? 'camera' : 'hold';
}

/** A name not used yet: "Swing", then "Swing 2"... */
function freshName(name: string): string {
  const base = name.trim() || 'Animation';
  if (!saved.some((c) => c.name === base)) return base;
  let k = 2;
  while (saved.some((c) => c.name === `${base} ${k}`)) k++;
  return `${base} ${k}`;
}

/** Adds to the saved list (and shows it when the Animations tab is open). Returns the name it got. */
function addSaved(item: Saved): string {
  item.name = freshName(item.name);
  saved.push(item);
  if (ui.tab === 'animations') showSaved(saved.length - 1);
  sync();
  return item.name;
}

/** The position saved items start from: the Arm step's, or the default one. Null without a character arm and a grip. */
function baseHold(): HoldPose | null {
  if (!hand?.arm || !grasps?.length) return null;
  return hold ?? defaultHold(hand.arm);
}

/** Saves a ready-made animation for the item type, starting from the Arm step's position. */
function addMotion(kind: MotionKind, style: ItemStyle = ui.itemStyle, name?: string): string | null {
  const base = baseHold();
  if (!base || !hand?.arm) return null;
  return addSaved({ kind: 'clip', name: name ?? motionLabel(kind, style), frames: generateMotion(kind, style, hand.arm, base), loops: motionLoops(kind) });
}

/** Saves a still pose: the Arm step's position, or `at` when given. */
function addPose(name = 'Pose', at?: HoldPose | null): string | null {
  const base = at ?? baseHold();
  return base ? addSaved({ kind: 'pose', name, hold: copyHold(base) }) : null;
}

/** The Arm step's position moved to fractions of the arm's reach forward / up / outward from the shoulder (for scripts). */
function holdAt(at: number[], turn?: number[] | null): HoldPose | null {
  const base = baseHold();
  if (!base || !hand?.arm || at.length !== 3 || at.some((v) => !Number.isFinite(v))) return null;
  const a = hand.arm, reach = a.upperLength + a.foreLength;
  const h = copyHold(base);
  h.position.copy(
    clampToReach(a, a.shoulder.clone().addScaledVector(a.forward, at[0] * reach).addScaledVector(new Vector3(0, 1, 0), at[1] * reach).addScaledVector(a.outward, at[2] * reach)),
  );
  if (turn && turn.length === 3 && turn.every((v) => Number.isFinite(v))) h.turn = [turn[0], turn[1], turn[2]];
  return h;
}

/** Saves a look: the arm follows the player's view, centred on the Arm step's position. */
function addLook(name = 'Look', ranges: Partial<typeof LOOK_DEFAULTS> = {}): string | null {
  const base = baseHold();
  return base ? addSaved({ kind: 'look', name, centre: copyHold(base), ...LOOK_DEFAULTS, ...ranges }) : null;
}

function armExport(): ArmExport | null {
  if (!hand?.arm) return null;
  const mode = armMode();
  const second = support ? supportGrasps?.[ui.selected] : undefined;
  // a hold position is needed for the arm to be placed at all (and always for two hands or anything saved); fall back to the default one
  const h = armHold() ?? (mode !== 'animation' || second || saved.length ? defaultHold(hand.arm) : null);
  if (!h) return null;
  return {
    arm: hand.arm,
    hold: h,
    sweep: sweepFrom && sweepTo ? { from: sweepFrom, to: sweepTo } : null,
    mode,
    support: second && support ? { char: support.char, model: support.rig.model, grasp: second, arm: support.arm } : null,
    clips: saved.filter((s): s is SavedClip => s.kind === 'clip'),
    poses: saved.filter((s): s is SavedPose => s.kind === 'pose'),
    looks: saved.filter((s): s is SavedLook => s.kind === 'look'),
  };
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const handSize = () => hand?.rig.model.size ?? 0.19;

function parkedPose(): HandPose {
  const wrist = new Matrix4();
  const angles = new Float32Array(hand?.rig.model.dofCount ?? 0);
  if (hand && object) {
    // rest the hand beside the object until a grip is chosen
    const hb = hand.restBox, ob = object.box;
    const hc = hb.getCenter(new Vector3()), oc = ob.getCenter(new Vector3());
    const gap = 0.35 * handSize();
    wrist.makeTranslation(ob.min.x - gap - hb.max.x, oc.y - hc.y, oc.z - hc.z);
  }
  return { wrist, angles };
}

function sync() {
  ui.hand = hand ? { name: hand.name, model: hand.rig.model, warnings: hand.rig.analysis.warnings } : null;
  if (object) {
    const size = object.box.getSize(new Vector3());
    ui.object = {
      name: object.name,
      ratio: Math.max(size.x, size.y, size.z) / handSize(),
      scaleLog: object.scaleLog,
      rescaled: object.rescaled,
      watertight: object.grasp.watertight,
    };
  } else ui.object = null;
  ui.grip = !!grip;
  ui.grip2 = !!grip2;
  ui.twoHandsAvailable = canTwoHands();
  ui.grasps = grasps;
  ui.characterAvailable = !!hand?.char;
  const charChip = document.getElementById('toggle-character');
  if (charChip) {
    charChip.hidden = !hand?.char || !grasps?.length;
    charChip.setAttribute('aria-pressed', String(characterView && !charChip.hidden));
  }
  const wristChip = document.getElementById('toggle-wrist-test');
  if (wristChip) wristChip.hidden = !(characterView && hand?.char && grasps?.length);
  ui.thumbTurn = hand?.edits.thumbTurn ?? 0;
  ui.edited = !!hand && (Object.keys(hand.edits.joints).length > 0 || hand.edits.thumbTurn !== 0);
  ui.armAvailable = !!hand?.arm;
  ui.armMode = armMode();
  const turned = editTarget() ?? hold;
  ui.turn = turned ? [turned.turn[0], turned.turn[1], turned.turn[2]] : [0, 0, 0];
  ui.sweepFrom = !!sweepFrom;
  ui.sweepTo = !!sweepTo;
  ui.pinSet = !!pin;
  ui.characterHands = hand && pendingHands && pendingHands.source === hand.source ? handLabels(pendingHands.hands).map((label) => ({ label })) : null;
  ui.characterPicked = pickedHand;
  if (object) {
    const e = new Euler().setFromQuaternion(object.turns, 'XYZ');
    ui.objectAngles = [Math.round(e.x / DEG), Math.round(e.y / DEG), Math.round(e.z / DEG)];
  }
  if (hand?.arm) {
    const r = reachOf(hand.arm);
    const at = currentHold()?.position.distanceTo(hand.arm.shoulder);
    const lengths = (v: number) => (v / handSize()).toFixed(1);
    ui.reachText =
      `The pale sphere is as far as this arm reaches: ${lengths(r.max)} hand lengths from the shoulder.` +
      (at ? ` The wrist is ${lengths(at)} out.` : '');
  }
  if (ui.shown >= saved.length) ui.shown = -1;
  ui.saved = saved.map((s) => ({
    kind: s.kind,
    name: s.name,
    seconds: s.kind === 'clip' ? s.frames[s.frames.length - 1].t : 0,
    loops: s.kind === 'clip' && s.loops,
    ranges: s.kind === 'look' ? { up: s.up, down: s.down, left: s.left, right: s.right } : null,
  }));
  ui.clipPlaying = player.playing;
  ui.canEditShown = ui.tab === 'animations' && !!editTarget();
  viewer.picking = ui.tab === 'grip' && ((ui.open === 3 && !!object) || ui.pinPicking);
  viewportEl.classList.toggle('picking', viewer.picking);
  hintEl.textContent = ui.pinPicking
    ? 'Click the spot the fingertip should touch'
    : viewer.picking
      ? grip
        ? 'Click the object to move the grip point'
        : 'Click the object where the palm should sit'
      : editTarget()
        ? ui.gizmoOn === 'item'
          ? 'Drag the arrows to move the item. The hand goes with it'
          : 'Drag the arrows to move the hand'
        : !hand && !object
          ? 'Drag to turn the view, scroll to zoom'
          : '';
  panel.render(ui);
}

const wristReport: WristReport = { flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 };

/** Puts what the solver did with the wrist into the Arm step, without redrawing the panel. */
function showWrist() {
  const r = wristReport, d = (v: number) => `${Math.abs(Math.round(v))}°`;
  const parts = [
    Math.abs(r.flex) >= 1 ? `bent ${d(r.flex)} ${r.flex > 0 ? 'towards the palm' : 'back'}` : '',
    Math.abs(r.radial) >= 1 ? `tilted ${d(r.radial)} ${r.radial > 0 ? 'towards the thumb' : 'towards the little finger'}` : '',
    Math.abs(r.twist) >= 1 ? `forearm turned ${d(r.twist)} ${r.twist > 0 ? 'palm up' : 'palm down'}` : '',
  ].filter(Boolean);
  ui.wristText =
    (parts.length ? `Wrist: ${parts.join(', ')}.` : 'Wrist: straight.') +
    (Math.abs(r.elbow) >= 1 ? ` Elbow ${r.elbow > 0 ? 'raised' : 'lowered'} ${d(r.elbow)} to help.` : '') +
    (r.miss > 3 ? ` The wrist cannot turn that far here: the object is ${Math.round(r.miss)}° off. Move the hand or change the turn.` : '');
  ui.wristMiss = r.miss;
  const el = document.getElementById('wrist-readout');
  if (el) {
    el.textContent = ui.wristText;
    el.className = r.miss > 3 ? 'warning' : 'note';
  }
}

/** Shows the selected grip either on the separate hand or on the model's own skeleton. */
function applyCharacterView(frame = true) {
  const g = grasps?.[ui.selected];
  const on = characterView && !!hand?.char && !!g;
  const arm = hand?.arm ?? null;
  // an animation in which the second hand lets go (Animations tab)
  const away = preview && ui.tab === 'animations' ? preview.away : 0;
  // fingers are posed with the arm at rest, then the arm is placed
  if (arm) solveArm(arm, null);
  if (hand?.char) poseCharacter(hand.char, hand.rig.model, on ? anglesOf(g!) : null);
  const second = on && support && arm ? (supportGrasps?.[ui.selected] ?? null) : null;
  if (support) {
    solveArm(support.arm, null);
    poseCharacter(support.char, support.rig.model, second ? (away > 0 ? second.angles.map((v) => v * (1 - away)) : second.angles) : null);
  }
  let toHand: Matrix4 | undefined;
  let carried = new Matrix4();
  const h = on ? currentHold() : null;
  if (on) {
    toHand = g!.wrist.clone().invert();
    if (h && arm) {
      carried = solveArm(arm, h, wristReport).multiply(arm.handRestInverse);
      showWrist();
      toHand.premultiply(carried);
    }
  }
  if (second && support && arm) {
    // the second hand goes to its own grip, wherever the first hand has put the object
    let want = meetHold(arm, g!.wrist, support.arm, second.wrist);
    if (away > 0) want = letGo(support.arm, want, away);
    solveArm(support.arm, want, supportReport);
    showSupport(holdGap(support.arm, want));
  }
  // the other arm hangs at the side unless it is holding on too
  if (hand?.free && !second) hangArm(hand.free, on);
  viewer.setCharacterView(on, toHand);
  // the drag handle and reach sphere show while a position can be changed: the Arm step, or a saved pose
  const target = on && h && arm ? editTarget() : null;
  const editing = !!target;
  // the handle sits on the wrist, or on the middle of the item
  const itemAt = editing && ui.gizmoOn === 'item' && object && toHand ? object.box.getCenter(new Vector3()).applyMatrix4(toHand) : null;
  viewer.setHoldGizmo(editing ? (itemAt ?? h!.position) : null, handleMoved);
  viewer.setReachGuide(editing ? arm!.shoulder : null, editing ? reachOf(arm!).max : 0);
  viewer.setArcGuide(
    editing && ui.tab === 'grip' && sweepFrom && sweepTo ? Array.from({ length: 25 }, (_, i) => mixHold(arm!, sweepFrom!, sweepTo!, i / 24).position) : null,
  );
  applyWristTest(on);
  if (!frame || !hand || !object || !g) return;
  const box = on
    ? hand.restBox.clone().applyMatrix4(carried).union(object.box.clone().applyMatrix4(toHand!))
    : object.box.clone().union(hand.restBox.clone().applyMatrix4(g.wrist));
  if (editing) box.expandByPoint(arm!.shoulder);
  viewer.frameBox(box, 500);
}

/** The character's arms, upper arm to hand: the holding arm, then the other one (or the second hand's). */
function characterArms(): ArmBones[] {
  const out: ArmBones[] = [];
  if (hand?.arm) out.push({ upper: hand.arm.upper, fore: hand.arm.fore, hand: hand.arm.hand });
  if (support?.arm) out.push({ upper: support.arm.upper, fore: support.arm.fore, hand: support.arm.hand });
  else if (hand?.free) {
    const h = mainChild(hand.free.fore);
    if (h) out.push({ upper: hand.free.upper, fore: hand.free.fore, hand: h });
  }
  return out;
}

/** The wrist test (view chips): every hand rolled and bent on its forearm, on top of the hold, to see the skin at the wrist. */
const wristTest = { on: false, roll: 0, bend: 0 };
function applyWristTest(on: boolean) {
  const arms = on ? characterArms() : [];
  viewer.setCharacterArms(arms);
  if (wristTest.on) for (const a of arms) turnWrist(a, wristTest.roll, wristTest.bend);
  viewer.invalidate();
}

/** Can the model's other hand join in? Needs a character with two hands, both with arms. */
function canTwoHands(): boolean {
  return !!hand?.arm && !!pendingHands && pendingHands.source === hand.source && pendingHands.hands.length > 1 && pickedHand >= 0;
}

/** Rigs the hand at the end of the character's other arm. */
function buildSupport(): SupportEntry | null {
  if (!hand || !canTwoHands()) return null;
  const all = pendingHands!.hands;
  const me = all[pickedHand];
  const far = (o: LocatedHand) => new Vector3(...o.center).distanceTo(new Vector3(...me.center));
  // the other handedness if there is one, otherwise the hand farthest away
  const others = all
    .filter((_, i) => i !== pickedHand)
    .sort((x, y) => Number(y.handedness !== me.handedness) - Number(x.handedness !== me.handedness) || far(y) - far(x));
  for (const o of others)
    for (const mask of [o.keep, o.keepWide]) {
      try {
        const b = subsetBaked(hand.full, mask);
        const a0 = analyzeHandMesh(b.mesh, { flipPalm: o.flip });
        if (a0.spec.fingers.length < o.fingers) continue;
        const own = onOwnSkeleton(hand.source, hand.full, mask, b, a0, { flipPalm: o.flip });
        const a = own.analysis;
        applyFingerLimits(a.model);
        const char = own.char;
        if (!char || char.handBone === hand.char?.handBone) continue;
        const arm = armFor(char, a.model.frame);
        if (!arm) continue;
        return { name: `${o.handedness} hand`, rig: buildRiggedHand(b, a), char, arm };
      } catch {
        // too coarse to rig: try the wider cut, then the next hand
      }
    }
  return null;
}

/** Puts the second hand back at rest and forgets it. */
function dropSupport() {
  if (support) {
    solveArm(support.arm, null);
    poseCharacter(support.char, support.rig.model, null);
  }
  support = null;
  supportGrasps = null;
  grip2 = null;
  ui.twoHands = false;
  viewer.setMarker2(null);
}

/**
 * How badly the second arm does at reaching its grip while the first hand is
 * at its hold: 0 when it reaches, up to 1 when it falls well short.
 */
function reachPenalty(a: Grasp, b: Grasp): number {
  if (!hand?.arm || !support) return 0;
  const first = hand.arm;
  solveArm(first, hold ?? defaultHold(first));
  const want = meetHold(first, a.wrist, support.arm, b.wrist);
  const r: WristReport = { flex: 0, radial: 0, twist: 0, elbow: 0, miss: 0 };
  solveArm(support.arm, want, r);
  const gap = holdGap(support.arm, want);
  return Math.min(1, gap / (0.4 * (support.arm.upperLength + support.arm.foreLength)) + r.miss / 90);
}

/** Says whether the second hand reaches its grip, without redrawing the panel. */
function showSupport(gap: number) {
  const short = gap > 0.05 * handSize();
  const miss = supportReport.miss;
  ui.supportShort = short || miss > 10;
  ui.supportText = short
    ? `The second hand is ${(gap / handSize()).toFixed(1)} hand lengths short of its grip. Bring the first hand nearer the other shoulder, or pick another grip.`
    : miss > 10
      ? `The second hand reaches its grip, but its wrist cannot turn far enough: it is ${Math.round(miss)}° off.`
      : 'The second hand reaches its grip.';
  const el = document.getElementById('support-readout');
  if (el) {
    el.textContent = ui.supportText;
    el.className = ui.supportShort ? 'warning' : 'note';
  }
}

function clearGrips(park = true) {
  if (characterView || viewer.characterView) {
    characterView = false;
    if (hand?.arm) solveArm(hand.arm, null);
    if (hand?.char) poseCharacter(hand.char, hand.rig.model, null);
    viewer.setCharacterView(false);
  }
  if (support) {
    solveArm(support.arm, null);
    poseCharacter(support.char, support.rig.model, null);
  }
  supportGrasps = null;
  viewer.setHoldGizmo(null);
  viewer.setReachGuide(null);
  viewer.setArcGuide(null);
  armOn = false;
  sweepActive = false;
  pin = null;
  ui.pinPicking = false;
  ui.pinMiss = 0;
  if (solveToken) solveToken.cancelled = true;
  stopPreview();
  grasps = null;
  foundGrasps = null;
  ui.nudge = [0, 0, 0, 0, 0, 0];
  ui.solving = false;
  ui.selected = 0;
  viewer.setContacts([]);
  if (park && hand) viewer.setPose(parkedPose());
}

// ---------- hand ----------

async function setHand(source: Object3D, name: string, flip = false, subset: Uint8Array | null = null) {
  if (hand?.free) hangArm(hand.free, false);
  ui.handBusy = true;
  ui.handError = null;
  ui.handChoice = null;
  ui.handChoiceNote = null;
  viewer.setPreview(null);
  ui.open = 1;
  sync();
  await nextFrame();
  await nextFrame();
  try {
    const full = bakeToTriMesh(source);
    let baked = full;
    let analysis: HandAnalysis | undefined;
    if (!subset) {
      pickedHand = -1;
      const found = locateHands(baked.mesh, { flipPalm: flip, character: looksLikeCharacter(source) });
      if (found.kind === 'hand') analysis = found.analysis;
      else if (found.kind === 'character' && found.hands.length > 1) {
        // a whole character: ask which hand
        pendingHands = { source, name, hands: found.hands };
        const kinds = new Set(found.hands.map((h) => h.handedness));
        const clash = kinds.size < found.hands.length;
        ui.handChoice = found.hands.map((h, i) =>
          clash
            ? { key: `pick-${i}`, label: `Hand ${i + 1}` }
            : { key: `pick-${h.handedness}`, label: h.handedness === 'left' ? 'Left hand' : 'Right hand' },
        );
        ui.handChoiceNote =
          clash && kinds.size === 1
            ? `All ${found.hands.length} hands on this model are ${[...kinds][0]} hands (the same hand mesh turned round), so they are numbered in the view.`
            : null;
        // show the character with a pin on each hand; clicking a pin picks it
        if (hand) viewer.setHand(null);
        hand = null;
        clearGrips(false);
        viewer.setPreview(
          source,
          found.hands.map((h, i) => ({
            position: new Vector3(...h.center),
            label: ui.handChoice![i].label,
            onPick: () => actions.pickHand(i),
          })),
        );
        ui.handBusy = false;
        sync();
        return;
      } else if (found.kind === 'character') {
        subset = found.hands[0].keep;
        widerSubset = found.hands[0].keepWide;
        expectedFingers = found.hands[0].fingers;
        flip = found.hands[0].flip;
      }
      else throw new Error(found.error ?? 'No hand could be found in this file.');
    }
    if (subset) {
      const attempt = (mask: Uint8Array) => {
        const b = subsetBaked(full, mask);
        const a = analyzeHandMesh(b.mesh, { flipPalm: flip });
        if (a.spec.fingers.length < expectedFingers) throw new Error('lost fingers');
        return { b, a };
      };
      try {
        let r: ReturnType<typeof attempt>;
        try {
          r = attempt(subset);
        } catch (e) {
          // the tight cut lost something the fingers needed: keep more of the forearm
          if (!widerSubset || widerSubset === subset) throw e;
          subset = widerSubset;
          r = attempt(subset);
        }
        baked = r.b;
        analysis = r.a;
      } catch {
        throw new Error('A hand was found on this model, but its fingers are too fused or too coarse to rig separately.');
      }
    }
    // on a character the hand bends about its own bones with its own weights, so what is drawn is what is exported
    const own = onOwnSkeleton(source, full, subset, baked, analysis!, { flipPalm: flip });
    analysis = own.analysis;
    applyFingerLimits(analysis.model);
    const rig = buildRiggedHand(baked, analysis);
    const restBox = new Box3();
    const p = baked.mesh.positions;
    const v = new Vector3();
    for (let i = 0; i < p.length; i += 3) restBox.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
    dropSupport();
    const char = own.char;
    hold = sweepFrom = sweepTo = null;
    saved = [];
    ui.shown = -1;
    ui.editing = false;
    ui.curl = 0;
    editJoint = -1;
    viewer.setJointHandles(null);
    viewer.setObjectVisible(true);
    hand = {
      name,
      source,
      rig,
      flip,
      restBox,
      subset,
      char,
      arm: char ? armFor(char, rig.model.frame) : null,
      free: null,
      baked,
      full,
      edits: { joints: {}, thumbTurn: 0 },
    };
    hand.free = char && hand.arm ? findOtherArm(char, hand.arm) : null;
    viewer.setHand(rig);
    viewer.setCharacter(char ? source : null);
    clearGrips(false);
    if (object) rebuildObject(false);
    viewer.setPose(parkedPose(), 0);
    viewer.setMarker(grip?.point ?? null, grip?.normal);
    viewer.frame();
    ui.handBusy = false;
    if (hand.subset || !flip) ui.open = !object ? 2 : grip ? 4 : 3;
    if (ui.tab !== 'grip') showTab();
  } catch (e) {
    ui.handBusy = false;
    ui.handError = e instanceof Error ? e.message : String(e);
  }
  sync();
}

// ---------- object ----------

function rebuildObject(resetGrip = true) {
  if (!object) return;
  const o = object;
  const holder = o.holder;
  holder.position.set(0, 0, 0);
  holder.quaternion.copy(o.turns);
  holder.scale.setScalar(o.baseScale * Math.pow(10, o.scaleLog));
  holder.updateMatrixWorld(true);
  const box = new Box3().setFromObject(holder);
  holder.position.sub(box.getCenter(new Vector3()));
  holder.updateMatrixWorld(true);
  o.box = new Box3().setFromObject(holder);
  o.grasp = new GraspObject(bakeToTriMesh(holder).mesh);
  if (resetGrip) {
    grip = grip2 = null;
    aim1 = aim2 = null;
    placed = null;
    viewer.setMarker(null);
    viewer.setMarker2(null);
  }
  clearGrips();
}

function setObject(source: Object3D, name: string, presetGrip?: { point: Vector3; normal: Vector3 }) {
  ui.objectError = null;
  try {
    const holder = new Group();
    holder.name = name;
    holder.add(source);
    holder.updateMatrixWorld(true);
    const size = new Box3().setFromObject(holder).getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (!(longest > 0)) throw new Error('This object has no size.');
    // models come in metres, centimetres or anything else: if it is absurdly
    // big or small next to the hand, assume a unit mismatch
    let baseScale = 1, rescaled = false;
    const ratio = longest / handSize();
    if (ratio > 12 || ratio < 0.08) {
      baseScale = (1.2 * handSize()) / longest;
      rescaled = true;
    }
    object = {
      name,
      source,
      holder,
      baseScale,
      scaleLog: 0,
      rescaled,
      turns: new Quaternion(),
      grasp: null as unknown as GraspObject,
      box: new Box3(),
    };
    rebuildObject();
    viewer.setObject(holder);
    if (presetGrip) {
      grip = {
        point: presetGrip.point.clone().applyMatrix4(holder.matrixWorld),
        normal: presetGrip.normal.clone().transformDirection(holder.matrixWorld),
      };
      viewer.setMarker(grip.point, grip.normal);
    }
    if (hand) viewer.setPose(parkedPose(), 0);
    viewer.frame();
    ui.open = !hand ? 1 : grip ? 4 : 3;
  } catch (e) {
    ui.objectError = e instanceof Error ? e.message : String(e);
  }
  sync();
}

// ---------- grips ----------

function selectGrasp(index: number, ms = 420) {
  if (!grasps || !grasps[index] || !hand) return;
  ui.selected = index;
  const g = settle(grasps[index]);
  const note = skinNote(g);
  ui.skinNote = note.text;
  ui.skinWarn = note.warn;
  viewer.setPose({ wrist: g.wrist, angles: g.angles }, ms);
  const second = supportGrasps?.[index];
  viewer.setContacts(second ? [...g.contacts, ...second.contacts] : g.contacts);
  if (characterView) applyCharacterView(false);
}

async function findGrips() {
  if (!hand || !object || !grip) return;
  clearGrips();
  const token = { cancelled: false };
  solveToken = token;
  ui.solving = true;
  ui.open = 4;
  sync();
  await nextFrame();
  const two = ui.twoHands && !!support && !!grip2 && !!hand.arm;
  const settings = (at: { point: Vector3; normal: Vector3 }) => ({
    gripPoint: at.point,
    gripNormal: at.normal,
    ...(at === grip && aim1 ? { aim: aim1 } : at === grip2 && aim2 ? { aim: aim2 } : {}),
    ...(carried ? { com: at.point } : {}),
    ...(at === grip && placed
      ? {
          wrist: placed.wrist,
          relax: placed.relax,
          adjust: placed.adjust,
          reach: placed.reach,
          // the place is judged on the drawn skin, which is what settle() keeps out of the part afterwards
          skinDepth: (w: Matrix4, a: Float32Array) => guardFor(hand!.rig, object!.grasp).measure(w, a).worst,
        }
      : {}),
    mode: ui.mode,
    friction: ui.friction,
    // more of each hand's grips to pair up
    ...(two ? { maxResults: 6 } : {}),
  });
  const first = await solveGrasp(hand.rig.model, object.grasp, settings(grip), {
    onProgress: (f) => panel.setProgress(two ? f / 2 : f),
    cancelled: () => token.cancelled,
  });
  if (token.cancelled) return;
  let found = first;
  if (two) {
    const s = support!;
    const second = await solveGrasp(s.rig.model, object.grasp, settings(grip2!), {
      onProgress: (f) => panel.setProgress(0.5 + f / 2),
      cancelled: () => token.cancelled,
    });
    if (token.cancelled) return;
    const pairs = pairGrasps(hand.rig.model, first, s.rig.model, second, object.grasp, {
      mode: ui.mode,
      friction: ui.friction,
      penalty: reachPenalty,
    });
    solveArm(hand.arm!, null);
    solveArm(s.arm, null);
    found = pairs.map((p) => ({ ...p.a, stable: p.stable, effort: p.effort, robustness: p.robustness, score: p.score }));
    supportGrasps = pairs.map((p) => p.b);
    // both hands are the model's own, so they are shown on the model, with the arms placed
    if (found.length) {
      characterView = true;
      armOn = true;
      hold ??= defaultHold(hand.arm!);
    }
  }
  // every grip is shown with the hand's skin out of the item; one that cannot be got out is not offered while others can
  const out: number[] = [];
  for (let i = 0; i < found.length; i++) {
    settle(found[i]);
    const second = supportGrasps?.[i];
    if (second && support) settle(second, support.rig);
    const clear = settledFrom.get(found[i])?.result.clear !== false && (!second || settledFrom.get(second)?.result.clear !== false);
    if (clear) out.push(i);
    await nextFrame();
    if (token.cancelled) return;
  }
  if (out.length && out.length < found.length) {
    const all = found;
    found = out.map((i) => all[i]);
    if (supportGrasps) supportGrasps = out.map((i) => supportGrasps![i]);
  }
  solveToken = null;
  grasps = found;
  foundGrasps = found.slice();
  ui.nudge = [0, 0, 0, 0, 0, 0];
  ui.limitsChanged = false;
  ui.solving = false;
  sync();
  if (found.length) {
    selectGrasp(0, 650);
    // bring the hand-on-object into the middle of the view
    const box = object.box.clone().union(hand.restBox.clone().applyMatrix4(found[0].wrist));
    viewer.frameBox(box, 650);
    sync();
  }
}

const actions: PanelActions = {
  openStep(step: StepId) {
    ui.open = step;
    if (step === 5 && hand?.arm && grasps?.length) {
      // posing the arm happens on the model itself
      characterView = true;
      armOn = true;
      hold ??= defaultHold(hand.arm);
      applyCharacterView(true);
    } else if (characterView) applyCharacterView(false);
    sync();
  },
  setTab(tab) {
    if (tab !== 'animations') stopPreview();
    ui.tab = tab;
    showTab();
    sync();
  },
  setBodyLimit(key, value, done) {
    bodyLimits[key] = value;
    for (const arm of [hand?.arm, support?.arm]) if (arm) setBodyLimits(arm, bodyLimits);
    if (characterView) applyCharacterView(false);
    // redrawing the panel while a slider is dragged would drop the drag
    if (done) sync();
  },
  resetBodyLimits() {
    Object.assign(bodyLimits, BODY_LIMITS);
    for (const arm of [hand?.arm, support?.arm]) if (arm) setBodyLimits(arm, bodyLimits);
    if (characterView) applyCharacterView(false);
    sync();
  },
  setLimitFinger(finger) {
    ui.limitFinger = finger;
    sync();
  },
  setFingerLimit(joint, dof, min, max) {
    const j = hand?.rig.model.joints[joint];
    const d = j?.dofs[dof];
    if (!hand || !j || !d) return;
    const lo = Math.min(0, min) * DEG;
    fingerLimits[`${j.name}/${d.kind}`] = [lo, Math.max(lo, Math.max(0, max) * DEG)];
    applyFingerLimits(hand.rig.model);
    if (support) applyFingerLimits(support.rig.model);
    ui.limitsChanged = !!grasps?.length;
    sync();
  },
  resetFingerLimits() {
    fingerLimits = {};
    if (hand) applyFingerLimits(hand.rig.model);
    if (support) applyFingerLimits(support.rig.model);
    ui.limitsChanged = !!grasps?.length;
    sync();
  },
  setObjectAngle(axis, degrees) {
    if (!object) return;
    const e = new Euler().setFromQuaternion(object.turns, 'XYZ');
    const v = [e.x, e.y, e.z];
    v[axis] = degrees * DEG;
    // the marked grip points turn with the item (a fine turn should not lose them)
    const was = object.holder.matrixWorld.clone().invert();
    object.turns.setFromEuler(new Euler(v[0], v[1], v[2], 'XYZ'));
    rebuildObject(false);
    const move = object.holder.matrixWorld.clone().multiply(was);
    const carry = (g: { point: Vector3; normal: Vector3 } | null) =>
      g && { point: g.point.clone().applyMatrix4(move), normal: g.normal.clone().transformDirection(move) };
    const carryAim = (a: { fingers: Vector3; thumb: Vector3 } | null) =>
      a && { fingers: a.fingers.clone().transformDirection(move), thumb: a.thumb.clone().transformDirection(move) };
    grip = carry(grip);
    grip2 = carry(grip2);
    aim1 = carryAim(aim1);
    aim2 = carryAim(aim2);
    placed = null;
    viewer.setMarker(grip?.point ?? null, grip?.normal);
    viewer.setMarker2(grip2?.point ?? null, grip2?.normal);
    viewer.frame(300);
    sync();
  },
  nudgeItem(index, value, done) {
    ui.nudge[index] = value;
    const base = foundGrasps?.[ui.selected];
    if (!base || !grasps?.[ui.selected]) return;
    // while dragging, the hand just moves (keeping its fingers); they close again on letting go
    dragging = !done;
    grasps[ui.selected] = { ...grasps[ui.selected], wrist: nudgedWrist(base.wrist) };
    selectGrasp(ui.selected, 0);
    if (done) void closeAgain();
  },
  resetNudge() {
    ui.nudge = [0, 0, 0, 0, 0, 0];
    void closeAgain();
  },
  setItemStyle(style) {
    ui.itemStyle = style;
    sync();
  },
  savePose() {
    addPose();
  },
  addMotion(kind) {
    addMotion(kind);
  },
  addLook() {
    addLook();
  },
  showSaved(index) {
    // clicking the animation that is already shown plays or pauses it
    if (index === ui.shown && saved[index]?.kind === 'clip') return actions.clipPlay(!player.playing);
    showSaved(index);
    sync();
  },
  clipPlay(on) {
    if (on) player.play();
    else player.pause();
  },
  clipSeek(time) {
    player.seek(time);
    ui.clipTime = player.time;
  },
  renameSaved(index, name) {
    const c = saved[index];
    if (!c) return;
    const want = name.trim() || c.name;
    c.name = saved.some((x) => x !== c && x.name === want) ? c.name : want;
    sync();
  },
  deleteSaved(index) {
    if (!saved[index]) return;
    saved.splice(index, 1);
    if (ui.shown === index) showSaved(-1);
    else if (ui.shown > index) ui.shown--;
    sync();
  },
  useArmPosition(index) {
    const item = saved[index];
    const base = baseHold();
    if (!item || !base || item.kind === 'clip') return;
    if (item.kind === 'pose') item.hold = copyHold(base);
    else item.centre = copyHold(base);
    showSaved(index);
    sync();
  },
  setLookRange(key, degrees, done) {
    const item = saved[ui.shown];
    if (item?.kind !== 'look' || !hand?.arm) return;
    item[key] = degrees;
    // show that end of the range while it is dragged
    ui.lookAim = key === 'up' ? [0, degrees] : key === 'down' ? [0, -degrees] : key === 'left' ? [-degrees, 0] : [degrees, 0];
    preview = { hold: lookHold(hand.arm, item, ui.lookAim[0], ui.lookAim[1]), away: 0 };
    applyCharacterView(false);
    if (done) sync();
  },
  lookAim(yaw, pitch, done) {
    const item = saved[ui.shown];
    if (item?.kind !== 'look' || !hand?.arm) return;
    ui.lookAim = [Math.min(item.right, Math.max(-item.left, yaw)), Math.min(item.up, Math.max(-item.down, pitch))];
    preview = { hold: lookHold(hand.arm, item, ui.lookAim[0], ui.lookAim[1]), away: 0 };
    applyCharacterView(false);
    if (done) sync();
  },
  setGizmo(on) {
    ui.gizmoOn = on;
    applyCharacterView(false);
    sync();
  },
  editBones(on) {
    if (!hand) return;
    ui.editing = on;
    ui.curl = 0;
    editJoint = -1;
    clearGrips(false);
    viewer.setObjectVisible(!on);
    if (on) {
      viewer.setView({ bones: true });
      document.querySelector('#view-toggles [data-view="bones"]')?.setAttribute('aria-pressed', 'true');
      showEditPose();
      viewer.frameBox(hand.restBox.clone(), 400);
    } else {
      viewer.setJointHandles(null);
      viewer.setHoldGizmo(null);
      viewer.setPose(parkedPose(), 0);
      viewer.frame(400);
    }
    sync();
  },
  setCurl(amount) {
    ui.curl = amount;
    showEditPose();
  },
  setThumbTurn(degrees) {
    if (!hand) return;
    hand.edits.thumbTurn = degrees;
    rebuildHand();
  },
  resetBones() {
    if (!hand) return;
    hand.edits = { joints: {}, thumbTurn: 0 };
    editJoint = -1;
    rebuildHand();
  },
  setTurn(axis, degrees) {
    const t = editTarget();
    if (!t) return;
    // turning the item: it stays where it is and the hand travels round it
    const stay = ui.gizmoOn === 'item' ? itemCentre(t) : null;
    t.turn[axis] = degrees;
    if (stay) moveItemTo(t, stay, 3);
    targetChanged();
  },
  resetHold() {
    if (!hand?.arm) return;
    hold = defaultHold(hand.arm);
    sweepActive = false;
    applyCharacterView(false);
    sync();
  },
  sweepMark(which) {
    const h = currentHold();
    if (!h) return;
    const copy: HoldPose = { position: h.position.clone(), turn: [h.turn[0], h.turn[1], h.turn[2]] };
    if (which === 'from') sweepFrom = copy;
    else sweepTo = copy;
    applyCharacterView(false);
    sync();
  },
  sweepClear() {
    sweepFrom = sweepTo = null;
    sweepActive = false;
    applyCharacterView(false);
    sync();
  },
  sweepScrub(t) {
    ui.sweepT = t;
    sweepActive = true;
    applyCharacterView(false);
  },
  setPinFinger(finger) {
    ui.pinFinger = finger;
    if (pin) {
      pin.finger = finger;
      selectGrasp(ui.selected, 250);
    }
    sync();
  },
  pinPick() {
    ui.pinPicking = !ui.pinPicking;
    sync();
  },
  setCarried(on) {
    carried = on;
    clearGrips();
    sync();
  },
  setHinges(text) {
    // "bone:ax,ay,az,maxDegrees,px,py,pz;..." (axis and rest position in the engine's space); empty text goes back to the analysed joints
    const map = new Map<string, BoneHinge>();
    for (const e of text.split(';')) {
      const [name, v] = e.split(':');
      const n = (v ?? '').split(',').map(Number);
      if (name && n.length === 7 && n.every(Number.isFinite)) map.set(name, { axis: [n[0], n[1], n[2]], max: (n[3] * Math.PI) / 180, at: [n[4], n[5], n[6]] });
    }
    hinges = map.size ? map : null;
    rebuildHand();
    return hinged;
  },
  placeHand(points, relax, adjust, reach) {
    // The hand's own bones at given places in the object file's axes (as an engine has put them): the hand goes there as one
    // rigid piece, lined up on whichever of the named bones it has, and only the fingers are solved; with `adjust`, the hand may
    // also move a little (a share of its own length) and turn (degrees) from there when that holds clearly better.
    const char = hand?.char;
    if (!char || !object) return 'needs a whole character and an object';
    object.source.updateMatrixWorld(true);
    const m = object.source.matrixWorld;
    const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const rest = new Map<string, Vector3>();
    char.bones.forEach((b, i) => rest.set(key(b.name), char.restHead[i]));
    const from: Vector3[] = [], to: Vector3[] = [];
    for (const p of points) {
      const r = rest.get(key(p.name));
      if (!r) continue;
      from.push(r.clone());
      to.push(new Vector3(p.at[0], p.at[1], p.at[2]).applyMatrix4(m));
    }
    const fit = fitPoints(from, to);
    if (!fit) return `only ${from.length} of the ${points.length} named bones are in this hand`;
    const size = hand!.rig.model.size;
    placed = {
      wrist: fit.matrix,
      relax,
      adjust: adjust && (adjust.move > 0 || adjust.turn > 0) ? { move: Math.max(1e-6, adjust.move * size), turn: Math.max(1e-6, (adjust.turn * Math.PI) / 180) } : undefined,
      // a fingertip's spot (in the file's axes, like the points), weighed when the hand may move
      reach: reach ? { finger: reach.finger, point: new Vector3(reach.at[0], reach.at[1], reach.at[2]).applyMatrix4(m) } : undefined,
      rms: fit.rms,
      scale: fit.scale,
      bones: from.length,
    };
    const centre = to.reduce((c, v) => c.add(v), new Vector3()).divideScalar(to.length);
    object.grasp.distance(centre.x, centre.y, centre.z);
    grip = { point: object.grasp.lastPoint.clone(), normal: object.grasp.lastNormal.clone() };
    aim1 = null;
    viewer.setMarker(grip.point, grip.normal);
    clearGrips();
    sync();
    return null;
  },
  holdThisWay(which, at, fingers, thumb) {
    // a point and (optionally) the way the fingers and thumb point, in the object file's own axes
    if (!object) return false;
    object.source.updateMatrixWorld(true);
    const m = object.source.matrixWorld;
    const point = new Vector3(at[0], at[1], at[2]).applyMatrix4(m);
    const aim =
      fingers && thumb
        ? { fingers: new Vector3(fingers[0], fingers[1], fingers[2]).transformDirection(m), thumb: new Vector3(thumb[0], thumb[1], thumb[2]).transformDirection(m) }
        : null;
    object.grasp.distance(point.x, point.y, point.z);
    const spot = { point, normal: object.grasp.lastNormal.clone() };
    if (which === 2) {
      if (!ui.twoHands) return false;
      grip2 = spot;
      aim2 = aim;
      viewer.setMarker2(spot.point, spot.normal);
    } else {
      grip = spot;
      aim1 = aim;
      viewer.setMarker(spot.point, spot.normal);
    }
    clearGrips();
    sync();
    return true;
  },
  setTwoHands(on) {
    if (on && !support) {
      support = buildSupport();
      if (!support) ui.twoHandsAvailable = false;
    }
    if (!on || !support) dropSupport();
    else ui.twoHands = true;
    clearGrips();
    sync();
  },
  pinAt(finger, at) {
    // a fingertip onto a spot given in the object file's own axes (a trigger), as if it had been clicked
    if (!object) return 'needs an object';
    object.source.updateMatrixWorld(true);
    const point = new Vector3(at[0], at[1], at[2]).applyMatrix4(object.source.matrixWorld).applyMatrix4(viewer.stageMatrix().invert());
    pin = { finger, point };
    ui.pinFinger = finger;
    ui.pinPicking = false;
    if (grasps?.length) selectGrasp(ui.selected, 0);
    sync();
    return null;
  },
  pinClear() {
    pin = null;
    ui.pinPicking = false;
    ui.pinMiss = 0;
    selectGrasp(ui.selected, 250);
    sync();
  },
  async handFile(file) {
    try {
      await setHand(await loadModelFile(file), file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      ui.handError = e instanceof Error ? e.message : String(e);
      ui.open = 1;
      sync();
    }
  },
  handSample() {
    void setHand(sampleHand(), 'Sample hand');
  },
  characterSample() {
    void setHand(sampleCharacter(), 'Sample player');
  },
  pickHand(index) {
    const p = pendingHands;
    if (!p || !p.hands[index]) return;
    const label = ui.handChoice?.[index]?.label.toLowerCase() ?? 'hand';
    widerSubset = p.hands[index].keepWide;
    expectedFingers = p.hands[index].fingers;
    pickedHand = index;
    void setHand(p.source, `${p.name} ${label}`, p.hands[index].flip, p.hands[index].keep);
  },
  flipPalm() {
    if (hand) void setHand(hand.source, hand.name, !hand.flip, hand.subset);
  },
  async objectFile(file) {
    try {
      setObject(await loadModelFile(file), file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      ui.objectError = e instanceof Error ? e.message : String(e);
      ui.open = 2;
      sync();
    }
  },
  objectSample(id) {
    const s = SAMPLE_OBJECTS.find((o) => o.id === id);
    if (s) setObject(s.build(), s.label, s.grip);
  },
  objectScale(scaleLog) {
    if (!object) return;
    object.scaleLog = scaleLog;
    object.rescaled = false;
    rebuildObject();
    viewer.frame();
    sync();
  },
  objectTurn(axis) {
    if (!object) return;
    const q = new Quaternion().setFromAxisAngle(axis === 'x' ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1), Math.PI / 2);
    object.turns.premultiply(q);
    rebuildObject();
    viewer.frame();
    sync();
  },
  setMode(mode) {
    ui.mode = mode;
    clearGrips();
    sync();
  },
  setFriction(mu) {
    ui.friction = mu;
    clearGrips();
    sync();
  },
  findGrips() {
    void findGrips();
  },
  cancelSolve() {
    clearGrips();
    sync();
  },
  selectGrasp(index) {
    // another grip: the item goes back to where that grip holds it
    if (index !== ui.selected && foundGrasps && grasps) {
      grasps[ui.selected] = foundGrasps[ui.selected];
      ui.nudge = [0, 0, 0, 0, 0, 0];
    }
    selectGrasp(index);
    sync();
  },
  setExport(patch) {
    Object.assign(ui, patch);
    sync();
  },
  setArmMode(mode) {
    armChoice = mode;
    sync();
  },
  async downloadGlb() {
    if (!grasps?.[ui.selected] || !hand) return;
    ui.exporting = true;
    sync();
    try {
      const blob = await makeGlb();
      const name = `${exportBase()}.glb`;
      lastExport = { blob, name };
      download(blob, name);
    } finally {
      ui.exporting = false;
      sync();
    }
  },
  downloadPose() {
    if (!grasps?.[ui.selected] || !hand) return;
    download(new Blob([JSON.stringify(makePose(), null, 2)], { type: 'application/json' }), `${exportBase()}.pose.json`);
  },
  async exportFor(engine) {
    if (!grasps?.[ui.selected] || !hand) return;
    ui.exporting = true;
    ui.exportingFor = engine;
    sync();
    try {
      const onCharacter = ui.exportCharacter && !!hand.char;
      // Unity cannot open a GLB on its own, and the character is already in the project;
      // it only needs the model when the hand was rigged here from scratch
      // ...or when it carries saved animations, which only travel as animations inside the model
      const wantsModel = engine !== 'unity' || !onCharacter || (saved.length > 0 && !!hand.arm);
      const glb = wantsModel ? new Uint8Array(await (await makeGlb()).arrayBuffer()) : null;
      const input = { base: exportBase(), pose: makePose(), glb };
      const pkg = engine === 'unity' ? await unityPackage(input) : engine === 'godot' ? godotPackage(input) : blenderPackage(input);
      lastPackage = pkg;
      download(pkg.blob, pkg.filename);
      ui.exported = engine;
    } finally {
      ui.exporting = false;
      ui.exportingFor = null;
      sync();
    }
  },
};

function exportBase(): string {
  if (!hand) return 'grip';
  const onCharacter = ui.exportCharacter && !!hand.char;
  const who = onCharacter ? hand.name.replace(/ (right hand|left hand|hand \d+)$/i, '') : hand.name;
  return `${who}-holding-${object?.name ?? 'object'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The chosen grip as a GLB: the user's own model posed, or the freshly rigged hand. */
async function makeGlb(): Promise<Blob> {
  const g = settle(grasps![ui.selected]);
  const h = hand!;
  const view = { ...viewer.view };
  try {
    viewer.setView({ bones: false, fit: false });
    const posed: Grasp = { ...g };
    const gripPose = { wrist: g.wrist, angles: posed.angles };
    const options = { includeObject: ui.exportObject, includeAnimation: ui.exportAnimation };
    const arm = armExport();
    const blob =
      ui.exportCharacter && h.char
        ? await exportCharacterGlb(h.char, h.rig.model, posed, object?.holder ?? null, options, arm && (arm.mode !== 'animation' || arm.support || saved.length) ? arm : null)
        : await exportGlb(h.rig, object?.holder ?? null, { wrist: g.wrist, angles: openPose(h.rig.model) }, gripPose, options);
    viewer.setPose(gripPose, 0);
    applyCharacterView(false);
    return blob;
  } finally {
    viewer.setView(view);
  }
}

/** The chosen grip as data for game code. */
function makePose() {
  const g = settle(grasps![ui.selected]);
  const h = hand!;
  const posed: Grasp = { ...g };
  const json =
    ui.exportCharacter && h.char
      ? characterPoseJson(h.char, h.rig.model, posed, object?.name ?? null, object?.holder ?? null, armExport())
      : poseJson(h.rig, posed, object?.name ?? null, object?.holder ?? null);
  viewer.setPose({ wrist: g.wrist, angles: posed.angles }, 0);
  applyCharacterView(false);
  return json;
}

let lastExport: { blob: Blob; name: string } | null = null;
let lastPackage: EnginePackage | null = null;
const panel = new Panel(document.getElementById('panel')!, actions, document.getElementById('topbar'));

viewer.onPick = (point, normal) => {
  if (ui.pinPicking) {
    // the object may be sitting in a character's hand: take the click back to the object's own space
    pin = { finger: ui.pinFinger, point: point.clone().applyMatrix4(viewer.stageMatrix().invert()) };
    ui.pinPicking = false;
    selectGrasp(ui.selected, 250);
    sync();
    return;
  }
  if (ui.twoHands && grip && (!grip2 || point.distanceTo(grip2.point) < point.distanceTo(grip.point))) {
    // the second hand's spot: the first click after the first mark, then whichever mark is nearer
    grip2 = { point, normal };
    aim2 = null;
    viewer.setMarker2(point, normal);
  } else {
    grip = { point, normal };
    aim1 = null;
    placed = null;
    viewer.setMarker(point, normal);
  }
  clearGrips();
  sync();
};

// ---------- view toggles ----------

{
  const host = document.getElementById('view-toggles')!;
  const items: { key: 'bones' | 'fit' | 'contacts' | 'weights'; label: string; title: string }[] = [
    { key: 'weights', label: 'Weights', title: 'Colour the hand by which bone each part of the skin follows. On your model: red follows the hand, blue stays with the forearm' },
    { key: 'bones', label: 'Bones', title: 'Show the bones that were placed in the hand' },
    { key: 'fit', label: 'Fit', title: 'Show how the bones were inflated to fill the hand' },
    { key: 'contacts', label: 'Contacts', title: 'Show where the hand touches the object' },
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = it.label;
    b.title = it.title;
    b.dataset.view = it.key;
    b.setAttribute('aria-pressed', String(viewer.view[it.key]));
    b.addEventListener('click', () => {
      viewer.setView({ [it.key]: !viewer.view[it.key] });
      b.setAttribute('aria-pressed', String(viewer.view[it.key]));
    });
    host.appendChild(b);
  }
  // shown only when the model has its own skeleton and a grip is selected
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'chip';
  c.id = 'toggle-character';
  c.textContent = 'On my model';
  c.title = "Show this grip on the model's own skeleton";
  c.hidden = true;
  c.setAttribute('aria-pressed', 'false');
  c.addEventListener('click', () => {
    characterView = !characterView;
    applyCharacterView();
    sync();
  });
  host.prepend(c);
  // the wrist test: roll and bend every hand on its forearm, to see what the skin does at the wrist (Rig Doctor checks the same turns)
  const w = document.createElement('button');
  w.type = 'button';
  w.className = 'chip';
  w.id = 'toggle-wrist-test';
  w.textContent = 'Wrist test';
  w.title = 'Roll and bend the hands on your model to see how the skin at the wrist follows';
  w.hidden = true;
  w.setAttribute('aria-pressed', 'false');
  const sliders = document.createElement('div');
  sliders.id = 'wrist-test';
  sliders.hidden = true;
  const slider = (label: string, key: 'roll' | 'bend', max: number) => {
    const l = document.createElement('label');
    l.textContent = label + ' ';
    const r = document.createElement('input');
    r.type = 'range';
    r.min = String(-max);
    r.max = String(max);
    r.step = '5';
    r.value = '0';
    r.addEventListener('input', () => {
      wristTest[key] = Number(r.value);
      applyCharacterView(false);
    });
    l.appendChild(r);
    sliders.appendChild(l);
  };
  slider('Roll', 'roll', 90);
  slider('Bend', 'bend', 60);
  w.addEventListener('click', () => {
    wristTest.on = !wristTest.on;
    w.setAttribute('aria-pressed', String(wristTest.on));
    sliders.hidden = !wristTest.on;
    applyCharacterView(false);
  });
  host.append(w, sliders);
}

// ---------- drag and drop anywhere ----------

{
  const veil = document.getElementById('drop-veil')!;
  let depth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    veil.hidden = false;
    veil.firstElementChild!.textContent = ui.tab === 'character' ? 'Drop to load as the character' : !hand || ui.open === 1 ? 'Drop to load as the hand' : 'Drop to load as the object';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) veil.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (ui.tab === 'character' || !hand || ui.open === 1) void actions.handFile(file);
    else void actions.objectFile(file);
  });
}

sync();

// ---------- ?demo=stick loads the samples and solves straight away ----------

const demo = new URLSearchParams(location.search).get('demo');
if (demo) {
  void (async () => {
    await setHand(sampleHand(), 'Sample hand');
    actions.objectSample(SAMPLE_OBJECTS.some((o) => o.id === demo) ? demo : 'stick');
    await findGrips();
  })();
}

// ---------- ?hand=<url>&object=<url> loads models by address and solves ----------
// Optional extras: pick=0 (which hand of a character), size=2.2 (object size in
// hand lengths), grip=0.5,0.5,0.5 (grip point inside the object's bounding box), arm=1.

const params = new URLSearchParams(location.search);
const handUrl = params.get('hand');
if (handUrl) {
  void (async () => {
    const fetchFile = async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status}).`);
      return new File([await r.blob()], decodeURIComponent(url.split('/').pop() ?? 'model'));
    };
    const until = async (done: () => boolean) => {
      while (!done()) await new Promise((r) => setTimeout(r, 60));
    };
    try {
      await actions.handFile(await fetchFile(handUrl));
      if (ui.handChoice) {
        actions.pickHand(Number(params.get('pick') ?? 0));
        await until(() => !ui.handBusy && (!!hand || !!ui.handError));
      }
      // read the module state afresh: the calls above change it
      const now = () => ({ hand, object, grasps });
      const objectUrl = params.get('object');
      const sampleId = params.get('sample');
      if (sampleId && now().hand) {
        // one of the built-in objects, which comes with its own grip point
        actions.objectSample(sampleId);
        await findGrips();
        return;
      }
      if (!objectUrl || !now().hand) return;
      await actions.objectFile(await fetchFile(objectUrl));
      const o = now().object;
      if (!o || !ui.object) return;
      const size = Number(params.get('size'));
      if (size > 0) actions.objectScale(Math.max(-1, Math.min(1, Math.log10(size / ui.object.ratio))));
      const target = now().object!;
      // Hold it this way: a point and two directions in the object file's own axes (as a game knows its sockets)
      const vec = (k: string) => {
        const v = params.get(k)?.split(',').map(Number);
        return v && v.length === 3 && v.every(Number.isFinite) ? v : null;
      };
      if (params.get('carried')) actions.setCarried(true);
      // Placed already: "bone:x,y,z;bone:x,y,z;..." (the hand bone and the fingers' first bones, as the engine puts them)
      const place = params.get('place');
      if (place) {
        const points = place.split(';').map((e) => {
          const [name, xyz] = e.split(':');
          return { name, at: (xyz ?? '').split(',').map(Number) };
        }).filter((p) => p.name && p.at.length === 3 && p.at.every(Number.isFinite));
        const relax = (params.get('relax') ?? '').split(',').filter(Boolean);
        const [move, turn] = (params.get('adjust') ?? '').split(',').map(Number);
        const err = actions.placeHand(points, relax, Number.isFinite(move) ? { move, turn: Number.isFinite(turn) ? turn : 0 } : undefined);
        if (err) {
          ui.handError = `place: ${err}`;
          sync();
          return;
        }
        await findGrips();
        return;
      }
      const at1 = vec('at');
      if (at1) {
        actions.holdThisWay(1, at1, vec('fingers'), vec('thumb'));
        const at2 = vec('at2');
        if (at2) {
          actions.setTwoHands(true);
          actions.holdThisWay(2, at2, vec('fingers2'), vec('thumb2'));
        }
        await findGrips();
        const after = now();
        if (params.get('arm') && after.hand?.arm && after.grasps?.length) actions.openStep(5);
        return;
      }
      const f = (params.get('grip') ?? '0.5,0.5,0.5').split(',').map(Number);
      const b = target.box;
      const spot = new Vector3(
        b.min.x + (b.max.x - b.min.x) * f[0],
        b.min.y + (b.max.y - b.min.y) * f[1],
        b.min.z + (b.max.z - b.min.z) * f[2],
      );
      target.grasp.distance(spot.x, spot.y, spot.z);
      grip = { point: target.grasp.lastPoint.clone(), normal: target.grasp.lastNormal.clone() };
      viewer.setMarker(grip.point, grip.normal);
      await findGrips();
      const after = now();
      if (params.get('arm') && after.hand?.arm && after.grasps?.length) actions.openStep(5);
    } catch (e) {
      ui.handError = e instanceof Error ? e.message : String(e);
      ui.open = 1;
      sync();
    }
  })();
}

// handle for automated checks
Object.assign(window as unknown as Record<string, unknown>, {
  __handhold: {
    viewer,
    actions,
    ui,
    get hand() {
      return hand;
    },
    get object() {
      return object;
    },
    get grasps() {
      return grasps;
    },
    /** For batch runs: find grips for what is marked now, and read the chosen grip's pose file (null when there is none). */
    solve: () => findGrips(),
    pose: () => (grasps?.length && hand ? makePose() : null),
    /** What keeping the skin out of the item did to the chosen grip: depth per finger and the palm before and after (metres), how far the hand moved, what turned. */
    skin() {
      const g = grasps?.[ui.selected];
      if (!g) return null;
      settle(g);
      const r = settledFrom.get(g)?.result;
      return r ? { before: r.before.depth, after: r.after.depth, worst: r.after.worst, moved: r.moved, changes: r.changes, clear: r.clear } : null;
    },
    /** How well a placed hand (address: place) lined up: metres left over, scale between the skeletons, bones used. */
    /** What setHinges did: joints put on the engine's hinges, and degrees between each one's old and new axis. */
    get hinged() {
      return hinged;
    },
    get placed() {
      return placed ? { rms: placed.rms, scale: placed.scale, bones: placed.bones, relax: placed.relax } : null;
    },
    /** Where the named bones of the chosen grip's hand are, in the object file's own axes (for a placed hand: where it ended up). */
    handAt(names: string[]) {
      const g = grasps?.[0] && settle(grasps[0]);
      const char = hand?.char;
      if (!g || !char || !object) return null;
      object.source.updateMatrixWorld(true);
      const toFile = object.source.matrixWorld.clone().invert();
      const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
      return names.map((name) => {
        const i = char.bones.findIndex((b) => key(b.name) === key(name));
        return { name, at: i < 0 ? null : char.restHead[i].clone().applyMatrix4(g.wrist).applyMatrix4(toFile).toArray() };
      });
    },
    /**
     * What an engine must draw for the chosen grip to be this one, in the object file's own axes: every posed finger bone's joint
     * (the character's own bones, as the exported pose turns them), each finger's tip (the end its last bone points at), and where
     * the drawn skin touches the held thing. Measured off the hand bone, so it holds wherever the character view put the model.
     */
    handJoints() {
      const g = grasps?.[ui.selected] && settle(grasps[ui.selected]);
      const h = hand;
      const char = h?.char;
      if (!g || !h || !char || !object) return null;
      object.source.updateMatrixWorld(true);
      const toFile = object.source.matrixWorld.clone().invert();
      const hi = char.bones.indexOf(char.handBone);
      if (hi < 0) return null;
      poseCharacter(char, h.rig.model, g.angles);
      // posed bone -> the hand's rest frame -> the grip's wrist -> the file
      const restHand = char.restInverse[hi].clone().invert();
      const fromPosed = toFile.clone().multiply(g.wrist).multiply(restHand).multiply(char.handBone.matrixWorld.clone().invert());
      const joints: { name: string; at: number[] }[] = [];
      const tips: { name: string; at: number[] }[] = [];
      char.bones.forEach((b, i) => {
        if (char.jointOf[i] === 0) return;
        joints.push({ name: b.name, at: b.getWorldPosition(new Vector3()).applyMatrix4(fromPosed).toArray() });
        const aim = char.aim[i];
        // the last bone of a finger aims at the fingertip, not at another bone's pivot
        const last = !char.bones.some((c, k) => k !== i && char.jointOf[k] !== 0 && c.parent === b);
        if (aim && last) {
          const tip = aim.point.clone().applyMatrix4(char.restInverse[i]).applyMatrix4(b.matrixWorld).applyMatrix4(fromPosed);
          tips.push({ name: b.name, at: tip.toArray() });
          // the same tip with the finger at rest and the hand where it holds: an engine carries this on its own last bone
          tips.push({ name: `${b.name}@rest`, at: aim.point.clone().applyMatrix4(g.wrist).applyMatrix4(toFile).toArray() });
          joints.push({ name: `${b.name}@rest`, at: char.restHead[i].clone().applyMatrix4(g.wrist).applyMatrix4(toFile).toArray() });
        }
      });
      if (!characterView) poseCharacter(char, h.rig.model, null);
      const names = h.rig.model.fingers.map((f) => f.name);
      const contacts = (g.contacts ?? []).map((c) => ({
        finger: c.finger < 0 ? 'palm' : names[c.finger],
        link: c.link,
        at: c.point.clone().applyMatrix4(toFile).toArray(),
      }));
      return { joints, tips, contacts };
    },
    get pendingHands() {
      return pendingHands;
    },
    get characterView() {
      return characterView;
    },
    /** The second hand of a two-handed grip, or null. */
    get support() {
      return ui.twoHands ? support : null;
    },
    /** For scripted checks of bone editing. */
    moveJoint,
    get edits() {
      return hand?.edits ?? null;
    },
    /** For scripted checks: put the wrist at fractions of the arm's reach forward / up / outward from the shoulder. */
    setHold(forward: number, up: number, out: number) {
      if (!hand?.arm || !hold) return;
      const a = hand.arm, reach = a.upperLength + a.foreLength;
      hold.position.copy(
        clampToReach(
          a,
          a.shoulder.clone().addScaledVector(a.forward, forward * reach).addScaledVector(new Vector3(0, 1, 0), up * reach).addScaledVector(a.outward, out * reach),
        ),
      );
      sweepActive = false;
      applyCharacterView(false);
      sync();
    },
    get arm() {
      return { on: armOn, hold: currentHold(), sweep: !!(sweepFrom && sweepTo), pinMiss: ui.pinMiss, pinSet: !!pin };
    },
    /** Fingertip mismatch between the solved hand and the model's own bones, in hand lengths. */
    get transferError() {
      const g = grasps?.[ui.selected];
      if (!hand?.char || !g) return null;
      poseCharacter(hand.char, hand.rig.model, g.angles);
      const e = transferError(hand.char, hand.rig.model, g.angles);
      if (!characterView) poseCharacter(hand.char, hand.rig.model, null);
      return e;
    },
    get lastPackage() {
      return lastPackage;
    },
    makePose,
    /** Saved animations: add a ready-made one (idle, walk, run, use, raise, second) for an item type, a still pose or a look, or list them. */
    addMotion(kind: MotionKind, style?: ItemStyle, name?: string) {
      if (style) actions.setItemStyle(style);
      return addMotion(kind, style, name);
    },
    /** `at`: fractions of the arm's reach forward / up / outward from the shoulder; `turn`: tilt, turn, roll in degrees. */
    addPose: (name?: string, at?: number[] | null, turn?: number[] | null) => (at ? ((h) => (h ? addPose(name, h) : null))(holdAt(at, turn)) : addPose(name)),
    addLook: (name?: string, ranges?: Partial<typeof LOOK_DEFAULTS>) => addLook(name, ranges),
    motions: MOTIONS,
    get saved() {
      return saved.map((s) => ({ kind: s.kind, name: s.name, seconds: s.kind === 'clip' ? s.frames[s.frames.length - 1].t : 0, keys: s.kind === 'clip' ? s.frames.length : 0 }));
    },
    /** Drags the handle in the view to a point, as the mouse would (for scripts). */
    moveHandle(to: number[]) {
      handleMoved(new Vector3(to[0], to[1], to[2]));
      sync();
    },
    /** Where the middle of the held item is in the view, with the arm as it is shown. */
    itemCentre() {
      const h = currentHold();
      const at = h ? itemCentre(h) : null;
      if (characterView) applyCharacterView(false);
      return at ? at.toArray() : null;
    },
    get lastExport() {
      return lastExport;
    },
  },
});
