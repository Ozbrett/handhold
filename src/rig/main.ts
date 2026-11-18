import '../styles.css';
import './rig.css';
import {
  AmbientLight, Box3, BufferAttribute, Color, DirectionalLight, Group, HemisphereLight, type Material, type Mesh,
  MeshStandardMaterial, type Object3D, PerspectiveCamera, Quaternion, Scene, SkeletonHelper, type Bone, type SkinnedMesh,
  SRGBColorSpace, type Texture, TextureLoader, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModelFile } from '../app/loaders';
import { type ArmBones, followColours, turnWrist } from '../app/skinCheck';

/*
 * The rig report: one character as it was and as it is now, side by side with one camera, coloured by what each part of the
 * skin follows, with its bones, and the wrists turned by hand. Under it, what the game itself measures in every hold (written by
 * the game's own probe, e.g. Deep Shift's WristProbe) and what was changed. Everything it shows comes from a folder of files that
 * Claude or a script writes: report.json names the models, the probe results and the notes. ?dir=<folder> picks the folder.
 */

interface ProbeArm { twist: number; bend: number; elbowRoll: number }
interface ProbeRow { pose: string; right: ProbeArm | null; left: ProbeArm | null }
interface Probe { limits: { twist: number; bend: number; elbowRoll: number }; tile: { w: number; h: number }; rows: ProbeRow[] }
interface Note { when: string; kind: 'fixed' | 'open' | 'next'; title: string; text: string }
interface Report {
  title: string;
  before: { label: string; model: string; probe?: string; picture?: string };
  after: { label: string; model: string; probe?: string; picture?: string };
  texture?: string;
  notes?: Note[];
}

const dir = (new URLSearchParams(location.search).get('dir') ?? '/handhold-out/rig/').replace(/\/?$/, '/');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const at = (p: string) => (/^(\/|https?:)/.test(p) ? p : dir + p);

// ---------- the character ----------

interface Arm extends ArmBones { side: 'right' | 'left' }

interface Character {
  root: Group;
  skins: SkinnedMesh[];
  arms: Arm[];
  rest: Map<Bone, Quaternion>;
  textured: Map<SkinnedMesh, Material | Material[]>;
  weights: Map<SkinnedMesh, Material>;
  spread: Map<SkinnedMesh, Material>;
  bones: SkeletonHelper;
  facts: Facts;
}

interface ArmFacts { side: string; chain: string[]; fingers: number; overHand: number; fingersOnCuff: number }
interface Facts { meshes: number; verts: number; tris: number; bones: number; spread: number[]; arms: ArmFacts[] }

const SIDE = /(^|[_.\s:-])(l|left)$|^left|left(?=hand)/i;
const isHandName = (n: string) => /hand/i.test(n) && !/(thumb|index|middle|ring|pinky|little|finger|twist|ik|pole)/i.test(n);

function findArms(skins: SkinnedMesh[]): Arm[] {
  const seen = new Set<Bone>();
  for (const s of skins) for (const b of s.skeleton.bones) seen.add(b);
  const hands = [...seen].filter((b) => isHandName(b.name) && b.parent && (b.parent as Bone).isBone && b.parent.parent && (b.parent.parent as Bone).isBone
    && b.children.some((c) => (c as Bone).isBone));
  const arms: Arm[] = [];
  for (const hand of hands) {
    const fore = hand.parent as Bone, upper = fore.parent as Bone;
    const side = SIDE.test(hand.name) ? 'left' : 'right';
    if (arms.some((a) => a.side === side)) continue;
    arms.push({ upper, fore, hand, side });
  }
  return arms.sort((a) => (a.side === 'right' ? -1 : 1));
}

function subtree(b: Object3D, into = new Set<Bone>()): Set<Bone> {
  if ((b as Bone).isBone) into.add(b as Bone);
  for (const c of b.children) subtree(c, into);
  return into;
}

/** Skin past each wrist that stays with the forearm (a sleeve or cuff over the hand), and skin behind it pulled by the fingers. */
function measure(skins: SkinnedMesh[], arms: Arm[]): Facts {
  const bones = new Set<Bone>();
  let verts = 0, tris = 0;
  const spread = [0, 0, 0, 0];
  for (const s of skins) {
    for (const b of s.skeleton.bones) bones.add(b);
    const g = s.geometry;
    verts += g.getAttribute('position').count;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const sw = g.getAttribute('skinWeight');
    if (sw) for (let i = 0; i < sw.count; i++) {
      let n = 0;
      for (let k = 0; k < sw.itemSize; k++) if (sw.getComponent(i, k) > 0.01) n++;
      if (n > 0) spread[Math.min(4, n) - 1]++;
    }
  }
  const armFacts: ArmFacts[] = arms.map((arm) => {
    const handSet = subtree(arm.hand), fingerSet = new Set([...handSet].filter((b) => b !== arm.hand));
    const foreSet = new Set([...subtree(arm.fore)].filter((b) => !handSet.has(b)));   // the forearm and any twist bone on it
    const wrist = arm.hand.getWorldPosition(new Vector3()), elbow = arm.fore.getWorldPosition(new Vector3());
    const along = wrist.clone().sub(elbow).normalize();
    const reach = wrist.distanceTo(elbow);
    let overHand = 0, fingersOnCuff = 0;
    const p = new Vector3();
    for (const s of skins) {
      const g = s.geometry, pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
      if (!si || !sw) continue;
      for (let i = 0; i < pos.count; i++) {
        let fore = 0, hand = 0, fingers = 0;
        for (let k = 0; k < si.itemSize; k++) {
          const w = sw.getComponent(i, k);
          if (w <= 0) continue;
          const b = s.skeleton.bones[si.getComponent(i, k)];
          if (foreSet.has(b)) fore += w;
          if (handSet.has(b)) hand += w;
          if (fingerSet.has(b)) fingers += w;
        }
        if (fore < 0.01 && fingers < 0.01) continue;
        p.fromBufferAttribute(pos, i).applyMatrix4(s.matrixWorld);
        const d = p.clone().sub(wrist);
        const t = d.dot(along);
        const off = d.clone().addScaledVector(along, -t).length();
        if (off > reach * 0.5) continue;   // not on this arm's line (a thigh beside an A-posed hand)
        if (t > reach * 0.04 && fore >= 0.5) overHand++;
        if (t < -reach * 0.06 && fingers > 0.2) fingersOnCuff++;
      }
    }
    return {
      side: arm.side,
      chain: [arm.upper.name, arm.fore.name, arm.hand.name],
      fingers: fingerSet.size,
      overHand,
      fingersOnCuff,
    };
  });
  return { meshes: skins.length, verts, tris: Math.round(tris), bones: bones.size, spread, arms: armFacts };
}

// ---------- against an ideal rig ----------

/**
 * What a game-ready humanoid arm looks like (the conventions of Unreal's mannequin, Mixamo and most AAA rigs), checked one by
 * one. Each check says what the ideal is, what this rig has, and what fixes it (a Rig Doctor step where there is one).
 */
interface IdealCheck { key: string; title: string; ideal: string; value: string; status: 'pass' | 'near' | 'fail'; fix: string }

const kidBones = (b: Object3D) => b.children.filter((c): c is Bone => (c as Bone).isBone === true);

function chainLength(b: Bone): number {
  let n = 1, at: Bone = b;
  for (;;) {
    const next = kidBones(at).sort((x, y) => subtree(y).size - subtree(x).size)[0];
    if (!next) return n;
    n++;
    at = next;
  }
}

/** Points of the skin around a limb at `joint` (within `band` of the plane square to `along`), followed mostly by `bones`. */
function ring(skins: SkinnedMesh[], joint: Vector3, along: Vector3, band: number, maxR: number, bones: Set<Bone>, skip = new Set<Bone>()) {
  const byMesh = new Map<SkinnedMesh, Vector3[]>();
  const p = new Vector3();
  for (const s of skins) {
    const g = s.geometry, pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!si || !sw) continue;
    const pts: Vector3[] = [];
    byMesh.set(s, pts);
    for (let i = 0; i < pos.count; i++) {
      let on = 0, off = 0;
      for (let k = 0; k < si.itemSize; k++) {
        const b = s.skeleton.bones[si.getComponent(i, k)];
        if (bones.has(b)) on += sw.getComponent(i, k);
        if (skip.has(b)) off += sw.getComponent(i, k);
      }
      if (on < 0.5 || off >= 0.2) continue;   // `skip`: a part that crosses the plane but is not the limb (the thumb at the wrist)
      p.fromBufferAttribute(pos, i).applyMatrix4(s.matrixWorld);
      const d = p.clone().sub(joint);
      const t = d.dot(along);
      if (Math.abs(t) > band) continue;
      const perp = d.addScaledVector(along, -t);
      if (perp.length() > maxR) continue;
      pts.push(perp);
    }
  }
  return byMesh;
}

/**
 * How far the joint sits from the middle of the limb around it, as a share of the limb's radius there (0 = dead centre). The
 * middle is taken from the limb's outline (its extent in eight directions), not the average of its points, so a dense patch
 * on one side (a button, the thumb's root) does not pull it.
 */
function outline(pts: Vector3[], along: Vector3): { off: number; radius: number } | null {
  if (pts.length < 12) return null;
  const u = new Vector3(1, 0, 0);
  if (Math.abs(u.dot(along)) > 0.9) u.set(0, 1, 0);
  u.addScaledVector(along, -u.dot(along)).normalize();
  const w = along.clone().cross(u);
  // only a shell that goes round the joint (points in at least six of eight sectors); a patch or a buckle beside it is not the limb
  const sectors = new Set(pts.map((p) => Math.floor(((Math.atan2(p.dot(w), p.dot(u)) + Math.PI) / (2 * Math.PI)) * 8) % 8));
  if (sectors.size < 6) return null;
  const centre = new Vector3();
  let radius = 0;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI;
    const dir = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { const t = p.dot(dir); if (t < lo) lo = t; if (t > hi) hi = t; }
    centre.addScaledVector(dir, ((lo + hi) / 2) * (2 / n));
    radius += (hi - lo) / 2 / n;
  }
  return radius > 1e-6 ? { off: centre.length() / radius, radius } : null;
}

/**
 * The joint against the limb itself: of the shells around it (a glove inside a sleeve, a body under a coat), the narrowest
 * one, because a loose sleeve hanging to one side says nothing about where the wrist is.
 */
function offCentre(byMesh: Map<SkinnedMesh, Vector3[]>, along: Vector3): number | null {
  let best: { off: number; radius: number } | null = null;
  for (const pts of byMesh.values()) {
    const o = outline(pts, along);
    if (o && (!best || o.radius < best.radius)) best = o;
  }
  return best ? best.off : null;
}

/** Along the forearm, where the hand's share of the skin goes from a tenth to nine tenths: the width of the blend across the wrist. */
function blendWidth(skins: SkinnedMesh[], arm: Arm): number | null {
  const handSet = subtree(arm.hand);
  // the forearm's own skin is the forearm bone and any twist bone hanging from it (what is in the forearm's subtree but not the hand's)
  const foreSet = new Set([...subtree(arm.fore)].filter((b) => !handSet.has(b)));
  const wrist = arm.hand.getWorldPosition(new Vector3()), elbow = arm.fore.getWorldPosition(new Vector3());
  const along = wrist.clone().sub(elbow);
  const len = along.length();
  along.normalize();
  const bins = new Map<number, { s: number; n: number }>();
  const step = 0.005;
  const p = new Vector3();
  for (const s of skins) {
    const g = s.geometry, pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!si || !sw) continue;
    for (let i = 0; i < pos.count; i++) {
      let hand = 0, arm2 = 0;
      for (let k = 0; k < si.itemSize; k++) {
        const b = s.skeleton.bones[si.getComponent(i, k)], w = sw.getComponent(i, k);
        if (handSet.has(b)) hand += w;
        if (handSet.has(b) || foreSet.has(b)) arm2 += w;
      }
      if (arm2 < 0.6) continue;
      p.fromBufferAttribute(pos, i).applyMatrix4(s.matrixWorld);
      const d = p.clone().sub(wrist);
      const t = d.dot(along);
      if (t < -len * 0.6 || t > len * 0.15) continue;
      if (d.addScaledVector(along, -t).length() > len * 0.4) continue;
      const k = Math.round(t / step);
      const b = bins.get(k) ?? { s: 0, n: 0 };
      b.s += hand / Math.max(1e-6, arm2);
      b.n++;
      bins.set(k, b);
    }
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  if (keys.length < 4) return null;
  let lo: number | null = null, hi: number | null = null;
  for (const k of keys) {
    const v = bins.get(k)!;
    const share = v.s / v.n;
    if (lo === null && share >= 0.1) lo = k * step;
    if (hi === null && share >= 0.9) hi = k * step;
  }
  return lo !== null && hi !== null ? Math.max(0, hi - lo) : null;
}

/** How well a bone points down its limb: the child's offset in the bone's own frame lies along one axis (1 = exactly). */
function axisAligned(bone: Bone, child: Bone): number {
  const v = child.position.clone();
  const l = v.length();
  return l > 1e-9 ? Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) / l : 1;
}

function idealChecks(c: Character): IdealCheck[] {
  const out: IdealCheck[] = [];
  const arms = c.arms;
  const each = <T,>(f: (a: Arm) => T) => arms.map(f);
  const cm = (m: number) => `${(m * 100).toFixed(1)} cm`;

  const fingers = each((a) => kidBones(a.hand).map(chainLength));
  const fingerOk = fingers.every((f) => f.filter((n) => n >= 3).length >= 5);
  out.push({
    key: 'fingers', title: 'Five fingers, three joints each', ideal: '5 × 3 per hand',
    value: fingers.map((f) => `${f.length} fingers (${f.join('/')})`).join(', ') || 'no hand',
    status: fingerOk ? 'pass' : fingers.every((f) => f.length >= 4) ? 'near' : 'fail',
    fix: 'Handhold rigs a hand from its mesh (the main app); a missing joint means re-rigging the hand.',
  });

  const twists = each((a) => [...subtree(a.fore)].filter((b) => b !== a.fore && !subtree(a.hand).has(b)).length);
  out.push({
    key: 'twist', title: 'Twist bones in the forearms', ideal: '1 or 2 per forearm, driven by the wrist',
    value: twists.map((n, i) => `${arms[i].side} ${n}`).join(', '),
    status: twists.length && twists.every((n) => n >= 1) ? 'pass' : 'fail',
    fix: 'Rig Doctor --twist adds one halfway down each forearm and spreads the forearm\'s weights onto it; the game turns it by half the wrist\'s roll.',
  });

  const wristOff = each((a) => {
    const w = a.hand.getWorldPosition(new Vector3()), e = a.fore.getWorldPosition(new Vector3());
    const len = w.distanceTo(e);
    const along = w.clone().sub(e).normalize();
    const fingers = new Set([...subtree(a.hand)].filter((b) => b !== a.hand));
    return offCentre(ring(c.skins, w, along, len * 0.05, len * 0.45, new Set([a.fore, a.hand]), fingers), along);
  });
  const worstWrist = Math.max(...wristOff.map((v) => v ?? 0));
  out.push({
    key: 'wrist-centre', title: 'Wrist joint in the middle of the wrist', ideal: 'off centre by under 20% of the wrist\'s radius',
    value: wristOff.map((v, i) => `${arms[i].side} ${v === null ? '?' : Math.round(v * 100) + '%'}`).join(', '),
    status: worstWrist <= 0.2 ? 'pass' : worstWrist <= 0.35 ? 'near' : 'fail',
    fix: 'Move the hand bone\'s head to the middle of the wrist ring (a joint off centre makes one side of the wrist stretch and the other pinch).',
  });

  const elbowOff = each((a) => {
    const e = a.fore.getWorldPosition(new Vector3()), s = a.upper.getWorldPosition(new Vector3());
    const len = e.distanceTo(s);
    const along = e.clone().sub(s).normalize();
    return offCentre(ring(c.skins, e, along, len * 0.05, len * 0.45, new Set([a.upper, a.fore])), along);
  });
  const worstElbow = Math.max(...elbowOff.map((v) => v ?? 0));
  out.push({
    key: 'elbow-centre', title: 'Elbow joint in the middle of the elbow', ideal: 'off centre by under 20% of the arm\'s radius',
    value: elbowOff.map((v, i) => `${arms[i].side} ${v === null ? '?' : Math.round(v * 100) + '%'}`).join(', '),
    status: worstElbow <= 0.2 ? 'pass' : worstElbow <= 0.35 ? 'near' : 'fail',
    fix: 'Move the forearm bone\'s head to the middle of the elbow.',
  });

  const r = arms.find((a) => a.side === 'right'), l = arms.find((a) => a.side === 'left');
  let mirror: number | null = null;
  if (r && l) {
    // mirrored across the body's own middle (between the shoulders), wherever the model stands
    const mid = (r.upper.getWorldPosition(new Vector3()).x + l.upper.getWorldPosition(new Vector3()).x) / 2;
    mirror = 0;
    for (const k of ['upper', 'fore', 'hand'] as const) {
      const a = r[k].getWorldPosition(new Vector3()), b = l[k].getWorldPosition(new Vector3());
      mirror = Math.max(mirror, a.distanceTo(new Vector3(2 * mid - b.x, b.y, b.z)));
    }
  }
  // Joints that sit centred in arms that differ are the mesh's asymmetry, not the rig's: mirroring them would push them off centre.
  const centred = worstWrist <= 0.2 && worstElbow <= 0.2;
  const mirrored = mirror !== null && mirror <= 0.01;
  out.push({
    key: 'mirror', title: 'Left and right arms match', ideal: 'joints mirror within 1 cm',
    value: mirror === null ? 'one arm' : `worst ${cm(mirror)}${!mirrored && centred ? ', each joint centred in its own arm (the mesh differs)' : ''}`,
    status: mirrored ? 'pass' : mirror !== null && (mirror <= 0.025 || centred) ? 'near' : 'fail',
    fix: centred
      ? 'The generated arms are not mirror images and the joints follow them. Symmetrize mesh and armature together if animations get mirrored; IK places each hand on its own, so the game does not need it.'
      : 'Mirror the better arm\'s joints onto the other (Blender: Symmetrize the armature), then re-run the centring check.',
  });

  let short = 0, total = 0;
  for (const s of c.skins) {
    const sw = s.geometry.getAttribute('skinWeight');
    if (!sw) continue;
    for (let i = 0; i < sw.count; i++) {
      let sum = 0;
      for (let k = 0; k < sw.itemSize; k++) sum += sw.getComponent(i, k);
      total++;
      if (sum < 0.99 || sum > 1.01) short++;
    }
  }
  out.push({
    key: 'influences', title: 'At most four bones a vertex, weights add up to 1', ideal: 'every vertex',
    value: `${fmt(short)} of ${fmt(total)} vertices off`,
    status: short === 0 ? 'pass' : short / Math.max(1, total) < 0.01 ? 'near' : 'fail',
    fix: 'Rig Doctor keeps each vertex to its four strongest bones and renormalises (always, last step). A vertex whose weights do not add to 1 lost a fifth bone the engine dropped.',
  });

  const over = c.facts.arms.reduce((n, a) => n + a.overHand, 0);
  out.push({
    key: 'sleeve', title: 'No sleeve over the hand', ideal: 'nothing past the wrist stays with the forearm',
    value: `${fmt(over)} vertices`, status: over === 0 ? 'pass' : over < 20 ? 'near' : 'fail',
    fix: 'Rig Doctor --trim cuts sleeve geometry that reaches past the wrist.',
  });

  const cuff = c.facts.arms.reduce((n, a) => n + a.fingersOnCuff, 0);
  out.push({
    key: 'cuff', title: 'Fingers do not pull the cuff', ideal: 'no finger weight behind the wrist',
    value: `${fmt(cuff)} vertices`, status: cuff === 0 ? 'pass' : cuff < 20 ? 'near' : 'fail',
    fix: 'Rig Doctor --cuff takes finger weights off the sleeve and fades the hand\'s share up the forearm.',
  });

  const widths = each((a) => blendWidth(c.skins, a));
  const okW = (w: number | null) => w !== null && w >= 0.02 && w <= 0.1;
  out.push({
    key: 'blend', title: 'A soft blend across the wrist', ideal: 'hand weight rises over 2 to 10 cm',
    value: widths.map((w, i) => `${arms[i].side} ${w === null ? '?' : cm(w)}`).join(', '),
    status: widths.every(okW) ? 'pass' : widths.some(okW) ? 'near' : 'fail',
    fix: 'Rig Doctor --blend spreads the hand\'s share over --blend-len (6 cm) so a turn is not one folding ring.',
  });

  const aligned = each((a) => Math.min(axisAligned(a.upper, a.fore), axisAligned(a.fore, a.hand)));
  const worstAxis = Math.min(...aligned);
  out.push({
    key: 'axes', title: 'Arm bones point down the limb', ideal: 'each bone\'s own axis runs to its child',
    value: `${Math.round(Math.acos(Math.min(1, worstAxis)) * 180 / Math.PI)}° off at worst`,
    status: worstAxis >= 0.998 ? 'pass' : worstAxis >= 0.98 ? 'near' : 'fail',
    fix: 'Re-orient the bones so their roll is consistent; IK and twist then turn about the limb itself.',
  });
  return out;
}

function idealCard(before: Character, now: Character) {
  const a = idealChecks(before), b = idealChecks(now);
  const score = (x: IdealCheck[]) => x.filter((c) => c.status === 'pass').length;
  const mark = (c: IdealCheck) => `<span class="rr-mark ${c.status}" title="${c.value}">${c.status === 'pass' ? 'Matches' : c.status === 'near' ? 'Close' : 'Off'}</span>`;
  $('rr-ideal').innerHTML = `<h2>Against an ideal rig</h2>
    <p class="rr-score">Matches the ideal on ${change(score(a), score(b), false)} of ${b.length} points. Hover a mark for the measurement.</p>
    <ul class="rr-ideal">${b.map((c, i) => `<li><div><b>${c.title}</b><p>Ideal: ${c.ideal}. Now: ${c.value}.${c.status === 'pass' ? '' : ` <em>Fix:</em> ${c.fix}`}</p></div>${mark(a[i])}${mark(c)}</li>`).join('')}</ul>`;
  (window as unknown as { idealRig: unknown }).idealRig = { before: a, now: b };
}

const SPREAD_COLOURS =[[0.62, 0.64, 0.68], [0.12, 0.64, 0.54], [0.89, 0.65, 0.18], [0.85, 0.27, 0.2]];

function spreadColours(mesh: SkinnedMesh): Float32Array {
  const sw = mesh.geometry.getAttribute('skinWeight');
  const out = new Float32Array(mesh.geometry.getAttribute('position').count * 3);
  if (!sw) return out;
  for (let i = 0; i < sw.count; i++) {
    let n = 0;
    for (let k = 0; k < sw.itemSize; k++) if (sw.getComponent(i, k) > 0.01) n++;
    const c = SPREAD_COLOURS[Math.max(0, Math.min(4, n) - 1)];
    out.set(c, i * 3);
  }
  return out;
}

async function loadCharacter(url: string, texture: Texture | null): Promise<Character> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status}).`);
  const model = await loadModelFile(new File([await r.blob()], url.split('/').pop() ?? 'model.fbx'));
  const root = new Group();
  root.add(model);
  // stand it 1.8 m tall, feet on the ground, centred: the files come in centimetres or metres
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model);
  const height = Math.max(1e-6, box.max.y - box.min.y);
  model.scale.multiplyScalar(1.8 / height);
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  model.position.sub(new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
  root.updateMatrixWorld(true);

  const skins: SkinnedMesh[] = [];
  root.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh) skins.push(o as SkinnedMesh); });
  const arms = findArms(skins);
  const rest = new Map<Bone, Quaternion>();
  for (const s of skins) for (const b of s.skeleton.bones) rest.set(b, b.quaternion.clone());
  const textured = new Map<SkinnedMesh, Material | Material[]>();
  const weights = new Map<SkinnedMesh, Material>();
  const spread = new Map<SkinnedMesh, Material>();
  for (const s of skins) {
    if (texture) s.material = new MeshStandardMaterial({ map: texture, roughness: 0.85 });
    textured.set(s, s.material);
    s.geometry.setAttribute('color', new BufferAttribute(followColours(s, arms), 3));
    weights.set(s, new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    s.geometry.setAttribute('spreadColor', new BufferAttribute(spreadColours(s), 3));
    spread.set(s, new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  }
  const bones = new SkeletonHelper(model);
  (bones.material as Material & { depthTest: boolean; color?: Color }).depthTest = false;
  bones.renderOrder = 2;
  bones.visible = false;
  root.add(bones);
  return { root, skins, arms, rest, textured, weights, spread, bones, facts: measure(skins, arms) };
}

type Look = 'skin' | 'weights' | 'spread';

function setLook(c: Character, look: Look) {
  for (const s of c.skins) {
    // weights and spread share the one colour slot: swap which array is in it
    if (look === 'spread') {
      const a = s.geometry.getAttribute('spreadColor');
      s.geometry.setAttribute('color', a);
    } else if (look === 'weights') {
      s.geometry.setAttribute('color', new BufferAttribute(followColours(s, c.arms), 3));
    }
    s.material = look === 'skin' ? c.textured.get(s)! : look === 'weights' ? c.weights.get(s)! : c.spread.get(s)!;
  }
}

function setWrists(c: Character, roll: number, bend: number) {
  for (const [b, q] of c.rest) b.quaternion.copy(q);
  c.root.updateMatrixWorld(true);
  for (const a of c.arms) turnWrist(a, a.side === 'left' ? -roll : roll, bend);
}

// ---------- the stage: one renderer, two halves, one camera ----------

const views = $('rr-views');
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = SRGBColorSpace;
views.prepend(renderer.domElement);
const camera = new PerspectiveCamera(32, 1, 0.01, 50);
camera.position.set(0.6, 1.25, 3.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
const scenes = [new Scene(), new Scene()];
for (const s of scenes) {
  s.add(new HemisphereLight(0xffffff, 0x444a55, 1.5));
  s.add(new AmbientLight(0xffffff, 0.3));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(1.5, 3, 2.5);
  s.add(sun);
  const back = new DirectionalLight(0xbcd0ff, 0.9);
  back.position.set(-2, 1.5, -2);
  s.add(back);
}
const studio = () => getComputedStyle(document.documentElement).getPropertyValue('--studio-b').trim() || '#d3d8de';

function frame() {
  const w = views.clientWidth, h = views.clientHeight;
  if (renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
  }
  camera.aspect = w / 2 / Math.max(1, h);
  camera.updateProjectionMatrix();
  controls.update();
  renderer.setScissorTest(true);
  renderer.setClearColor(new Color(studio()));
  for (let i = 0; i < 2; i++) {
    renderer.setViewport((i * w) / 2, 0, w / 2, h);
    renderer.setScissor((i * w) / 2, 0, w / 2, h);
    renderer.render(scenes[i], camera);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- the panels ----------

const fmt = (n: number) => n.toLocaleString('en');
const deg = (n: number) => `${Math.round(n)}°`;

function segmented(host: HTMLElement, items: { key: string; label: string; title: string }[], pick: (key: string) => void, first: string) {
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.title = it.title;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(it.key === first));
    b.addEventListener('click', () => {
      for (const o of host.querySelectorAll('button')) o.setAttribute('aria-checked', String(o === b));
      pick(it.key);
    });
    host.appendChild(b);
  }
}

function change(before: number, now: number, lowerIsBetter = true, unit = '') {
  const better = lowerIsBetter ? now < before : now > before;
  const same = Math.round(before) === Math.round(now);
  return `<span class="rr-was">${fmt(Math.round(before))}${unit}</span><span class="rr-arrow" aria-hidden="true">→</span><span class="rr-now ${same ? '' : better ? 'is-better' : 'is-worse'}">${fmt(Math.round(now))}${unit}</span>`;
}

function worst(p: Probe, key: 'twist' | 'bend') {
  let w = 0, where = '';
  for (const r of p.rows) for (const [side, a] of [['right', r.right], ['left', r.left]] as const) {
    if (!a) continue;
    const v = Math.abs(a[key]);
    if (v > w) { w = v; where = `${r.pose}, ${side}`; }
  }
  return { w, where };
}

const within = (p: Probe, a: ProbeArm | null) => !a || (Math.abs(a.twist) <= p.limits.twist + 1 && a.bend <= p.limits.bend + 1);

function summary(before: Character, now: Character, pb: Probe | null, pa: Probe | null) {
  const cards: string[] = [];
  const over = (c: Character) => c.facts.arms.reduce((n, a) => n + a.overHand, 0);
  const cuff = (c: Character) => c.facts.arms.reduce((n, a) => n + a.fingersOnCuff, 0);
  if (pb && pa) {
    const tb = worst(pb, 'twist'), ta = worst(pa, 'twist'), bb = worst(pb, 'bend'), ba = worst(pa, 'bend');
    const ok = (p: Probe) => p.rows.filter((r) => within(p, r.right) && within(p, r.left)).length;
    cards.push(`<div class="rr-stat"><h3>Worst wrist twist in a hold</h3><p class="rr-big">${change(tb.w, ta.w, true, '°')}</p><p class="rr-sub">now at ${ta.where}; the skin follows ${pa.limits.twist}°</p></div>`);
    cards.push(`<div class="rr-stat"><h3>Worst wrist bend in a hold</h3><p class="rr-big">${change(bb.w, ba.w, true, '°')}</p><p class="rr-sub">now at ${ba.where}; a blade's cap is ${pa.limits.bend}°</p></div>`);
    cards.push(`<div class="rr-stat"><h3>Holds inside the skin's limits</h3><p class="rr-big">${change(ok(pb), ok(pa), false)}<span class="rr-of"> of ${pa.rows.length}</span></p><p class="rr-sub">both wrists, every pose the game probes</p></div>`);
  }
  cards.push(`<div class="rr-stat"><h3>Sleeve over the hands</h3><p class="rr-big">${change(over(before), over(now))}</p><p class="rr-sub">vertices past the wrist that stay with the forearm; finger weights on the cuff ${change(cuff(before), cuff(now))}</p></div>`);
  $('rr-summary').innerHTML = cards.join('');
}

function rigCard(before: Character, now: Character, r: Report) {
  const row = (label: string, b: number | string, a: number | string, title = '') =>
    `<tr title="${title}"><th scope="row">${label}</th><td>${typeof b === 'number' ? fmt(b) : b}</td><td>${typeof a === 'number' ? fmt(a) : a}</td></tr>`;
  const spread = (c: Character) => {
    const total = c.facts.spread.reduce((x, y) => x + y, 0) || 1;
    return `<span class="rr-spread">${c.facts.spread.map((n, i) => `<i style="flex:${n / total};background:rgb(${SPREAD_COLOURS[i].map((v) => Math.round(v * 255)).join(',')})" title="${i + 1} bone${i ? 's' : ''}: ${fmt(n)} vertices"></i>`).join('')}</span>`;
  };
  const arms = now.facts.arms.map((a) => {
    const was = before.facts.arms.find((x) => x.side === a.side);
    return `<li><b>${a.side} arm</b> <code>${a.chain.join(' › ')}</code> › ${a.fingers} finger bones<br/>
      sleeve past the wrist: ${change(was?.overHand ?? 0, a.overHand)} vertices · finger weights behind the wrist: ${change(was?.fingersOnCuff ?? 0, a.fingersOnCuff)}</li>`;
  }).join('');
  $('rr-rig').innerHTML = `<h2>How it is rigged</h2>
    <table class="rr-table"><thead><tr><th></th><th>${r.before.label}</th><th>${r.after.label}</th></tr></thead><tbody>
    ${row('Skinned meshes', before.facts.meshes, now.facts.meshes)}
    ${row('Vertices', before.facts.verts, now.facts.verts)}
    ${row('Triangles', before.facts.tris, now.facts.tris)}
    ${row('Bones', before.facts.bones, now.facts.bones)}
    ${row('Bones per vertex', spread(before), spread(now), 'grey 1, green 2, amber 3, red 4 (the most a game engine blends)')}
    </tbody></table>
    <ul class="rr-arms">${arms || '<li>No arm found: the hand bones are named in a way the report does not know.</li>'}</ul>`;
}

function notesCard(notes: Note[]) {
  const label = { fixed: 'Fixed', open: 'Open', next: 'Next' } as const;
  $('rr-notes').innerHTML = `<h2>What changed</h2><ol class="rr-notes">${notes.map((n) =>
    `<li class="is-${n.kind}"><span class="rr-tag">${label[n.kind]}</span><div><b>${n.title}</b> <span class="rr-when">${n.when}</span><p>${n.text}</p></div></li>`).join('')}</ol>`;
}

function holdsCard(pb: Probe, pa: Probe, picB: string | undefined, picA: string | undefined) {
  const cell = (b: ProbeArm | null, a: ProbeArm | null) => {
    if (!a || !b) return '<td>–</td><td>–</td>';
    const t = (v: number, lim: number) => `<span class="${Math.abs(v) <= lim + 1 ? 'ok' : Math.abs(v) <= lim * 1.4 ? 'warn' : 'bad'}">${deg(Math.abs(v))}</span>`;
    return `<td>${t(b.twist, pb.limits.twist)} → ${t(a.twist, pa.limits.twist)}</td><td>${t(b.bend, pb.limits.bend)} → ${t(a.bend, pa.limits.bend)}</td>`;
  };
  const rows = pa.rows.map((r, i) => {
    const b = pb.rows.find((x) => x.pose === r.pose) ?? r;
    return `<tr data-i="${i}" tabindex="0"><th scope="row">${r.pose}</th>${cell(b.right, r.right)}${cell(b.left, r.left)}</tr>`;
  }).join('');
  $('rr-holds').innerHTML = `<h2>In the game, every hold</h2>
    <p class="rr-sub">The game's own probe poses the in-game body in each hold and measures each wrist off the skin's bind pose: twist about the forearm and bend across it. Pick a row to see the game's render, before and now.</p>
    <div class="rr-holds-body">
      <div class="rr-table-wrap"><table class="rr-table rr-probe"><thead>
        <tr><th rowspan="2">Pose</th><th colspan="2">Right wrist</th><th colspan="2">Left wrist</th></tr>
        <tr><th>twist</th><th>bend</th><th>twist</th><th>bend</th></tr></thead><tbody>${rows}</tbody></table></div>
      <figure class="rr-shots" id="rr-shots"></figure>
    </div>`;
  const shots = $('rr-shots');
  const show = (i: number) => {
    for (const tr of $('rr-holds').querySelectorAll('tbody tr')) tr.classList.toggle('is-picked', Number((tr as HTMLElement).dataset.i) === i);
    const n = pa.rows.length, { w, h } = pa.tile;
    const tile = (pic: string | undefined, view: number, label: string) => pic
      ? `<div class="rr-shot"><div class="rr-shot-img" style="background-image:url('${pic}');background-size:${n * 100}% 200%;background-position:${n > 1 ? (i / (n - 1)) * 100 : 0}% ${view * 100}%;aspect-ratio:${w}/${h}"></div><span>${label}</span></div>` : '';
    shots.innerHTML = `<figcaption>${pa.rows[i].pose}</figcaption><div class="rr-shot-grid">
      ${tile(picB, 0, 'Before, front')}${tile(picA, 0, 'Now, front')}${tile(picB, 1, 'Before, side')}${tile(picA, 1, 'Now, side')}</div>`;
  };
  for (const tr of $('rr-holds').querySelectorAll('tbody tr')) {
    const i = Number((tr as HTMLElement).dataset.i);
    tr.addEventListener('click', () => show(i));
    tr.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') show(i); });
  }
  // open on the hold that changed most
  let best = 0, most = -1;
  pa.rows.forEach((r, i) => {
    const b = pb.rows.find((x) => x.pose === r.pose);
    if (!b) return;
    const d = [['right', 'twist'], ['right', 'bend'], ['left', 'twist'], ['left', 'bend']].reduce((s, [side, k]) => {
      const x = (b as unknown as Record<string, Record<string, number> | null>)[side], y = (r as unknown as Record<string, Record<string, number> | null>)[side];
      return s + (x && y ? Math.abs(x[k]) - Math.abs(y[k]) : 0);
    }, 0);
    if (d > most) { most = d; best = i; }
  });
  show(best);
}

// ---------- start ----------

async function main() {
  const report: Report = await (await fetch(dir + 'report.json')).json();
  $('rr-title').textContent = report.title;
  document.title = `${report.title} · Handhold rig report`;
  let texture: Texture | null = null;
  if (report.texture) {
    texture = await new TextureLoader().loadAsync(at(report.texture)).catch(() => null);
    if (texture) { texture.colorSpace = SRGBColorSpace; texture.flipY = true; }
  }
  const [before, now] = await Promise.all([loadCharacter(at(report.before.model), texture), loadCharacter(at(report.after.model), texture)]);
  scenes[0].add(before.root);
  scenes[1].add(now.root);
  $('rr-loading').remove();
  const both = [before, now];

  const legends: Record<Look, string> = {
    skin: 'The model as the game draws it.',
    weights: '<i class="sw" style="background:#db382a"></i>follows the hand <i class="sw" style="background:#336be6"></i>stays with the forearm <i class="sw" style="background:#8cb3f2"></i>upper arm <i class="sw" style="background:#6b6b6b"></i>the rest. A cuff that is red turns with the wrist; blue past the wrist is a sleeve over the hand.',
    spread: '<i class="sw" style="background:#9ea3ad"></i>1 bone <i class="sw" style="background:#1fa38a"></i>2 <i class="sw" style="background:#e3a62e"></i>3 <i class="sw" style="background:#d94533"></i>4 bones blended at each vertex.',
  };
  const pickLook = (k: string) => { for (const c of both) setLook(c, k as Look); $('rr-legend').innerHTML = legends[k as Look]; };
  segmented($('rr-look'), [
    { key: 'skin', label: 'Skin', title: 'The textured model' },
    { key: 'weights', label: 'Weights', title: 'Colour by which bone each part of the skin follows' },
    { key: 'spread', label: 'Bones per vertex', title: 'Colour by how many bones each vertex blends' },
  ], pickLook, 'weights');
  pickLook('weights');

  const focusOn = (k: string) => {
    const arm = now.arms.find((a) => a.side === k);
    if (!arm) {
      controls.target.set(0, 1.0, 0);
      camera.position.set(0.6, 1.25, 3.4);
      return;
    }
    const p = arm.hand.getWorldPosition(new Vector3());
    const out = new Vector3(p.x, 0, p.z).normalize();
    if (out.lengthSq() < 1e-6) out.set(k === 'right' ? -1 : 1, 0, 0);
    controls.target.copy(p);
    // far enough that the hand and the forearm fit even when each half of the view is narrow
    const fit = 0.32 / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1, camera.aspect);
    camera.position.copy(p).add(out.multiplyScalar(0.35).add(new Vector3(0, 0.12, 1)).normalize().multiplyScalar(fit));
  };
  segmented($('rr-focus'), [
    { key: 'body', label: 'Body', title: 'The whole character' },
    { key: 'right', label: 'Right hand', title: 'Close on the right wrist' },
    { key: 'left', label: 'Left hand', title: 'Close on the left wrist' },
  ], focusOn, 'body');

  $<HTMLInputElement>('rr-bones').addEventListener('change', (e) => { for (const c of both) c.bones.visible = (e.target as HTMLInputElement).checked; });
  const roll = $<HTMLInputElement>('rr-roll'), bend = $<HTMLInputElement>('rr-bend');
  const turn = () => {
    $('rr-roll-v').textContent = deg(Number(roll.value));
    $('rr-bend-v').textContent = deg(Number(bend.value));
    for (const c of both) setWrists(c, Number(roll.value), Number(bend.value));
  };
  roll.addEventListener('input', turn);
  bend.addEventListener('input', turn);

  const probe = async (p?: string) => (p ? ((await (await fetch(at(p))).json()) as Probe) : null);
  const [pb, pa] = await Promise.all([probe(report.before.probe), probe(report.after.probe)]);
  summary(before, now, pb, pa);
  rigCard(before, now, report);
  idealCard(before, now);
  notesCard(report.notes ?? []);
  if (pb && pa) holdsCard(pb, pa, report.before.picture && at(report.before.picture), report.after.picture && at(report.after.picture));
  else $('rr-holds').hidden = true;
  (window as unknown as { rigReport: unknown }).rigReport = { before: before.facts, now: now.facts, characters: { before, now } };
}

main().catch((e) => {
  const el = $('rr-loading');
  if (el) el.textContent = `Could not build the report: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
