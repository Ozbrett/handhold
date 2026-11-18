import { type Bone, Matrix4, type Object3D, Quaternion, type SkinnedMesh, Vector3 } from 'three';

/**
 * A whole character as the pose checks see it: its arms, fingers, spine and head found by name and shape, every drawn skinned
 * mesh, which part of the body each vertex of that skin belongs to, and the rest pose everything is measured from. It works on
 * the character's own bones and weights, so what it measures is what an engine draws with the same file.
 */

export type Side = 'left' | 'right';
export const SIDES: Side[] = ['right', 'left'];
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type FingerName = (typeof FINGERS)[number];

export interface Finger {
  name: FingerName;
  /** From the knuckle out. */
  bones: Bone[];
}

export interface Limb {
  side: Side;
  clavicle: Bone | null;
  upper: Bone;
  fore: Bone;
  hand: Bone;
  fingers: Finger[];
}

/** Which part of the body a vertex of the skin belongs to. Arms and hands have one per side. */
export enum Region {
  Torso = 0,
  Head = 1,
  Legs = 2,
  UpperR = 3,
  ForeR = 4,
  HandR = 5,
  UpperL = 6,
  ForeL = 7,
  HandL = 8,
}
export const REGION_NAMES = ['torso', 'head', 'legs', 'upper arm (right)', 'forearm (right)', 'hand (right)', 'upper arm (left)', 'forearm (left)', 'hand (left)'];
export const armRegion = (side: Side, part: 'upper' | 'fore' | 'hand') => (side === 'right' ? 3 : 6) + ['upper', 'fore', 'hand'].indexOf(part);

export interface SkinPart {
  mesh: SkinnedMesh;
  /** Triangle corners (three per triangle) into this mesh's vertices. */
  index: Uint32Array;
  /** Per vertex: the region of its strongest bone. */
  region: Uint8Array;
  /** Per vertex: the region of its second bone when that bone carries a real share (over 0.12), else 255. A vertex between two regions is the joint's own skin. */
  blend: Uint8Array;
  /** Per vertex: its strongest bone. */
  bone: (Bone | null)[];
  /** Rest positions in world space. */
  rest: Float32Array;
}

export interface Body {
  root: Object3D;
  bones: Bone[];
  limbs: Partial<Record<Side, Limb>>;
  spine: Bone[];
  neck: Bone | null;
  head: Bone | null;
  pelvis: Bone | null;
  skin: SkinPart[];
  /** Rest world matrices, positions and turns of every bone. */
  restWorld: Map<Bone, Matrix4>;
  restLocal: Map<Bone, { position: Vector3; quaternion: Quaternion; scale: Vector3 }>;
  /** The way the character faces and up, at rest. */
  forward: Vector3;
  up: Vector3;
  /** Typical radius of each region's skin round its bones (metres), from the rest pose. */
  thickness: number[];
  /** Height of the character (metres), from the rest skin. */
  height: number;
}

export const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');

const isBone = (o: Object3D | null | undefined): o is Bone => !!o && (o as Bone).isBone === true;
const boneKids = (b: Bone) => b.children.filter(isBone);
const count = (b: Bone): number => boneKids(b).reduce((n, c) => n + 1 + count(c), 0);
const mainChild = (b: Bone) => boneKids(b).sort((x, y) => count(y) - count(x))[0] ?? null;

/** Left or right from a bone's name: a trailing r / l token, or the words. */
export function sideOf(name: string): Side | null {
  if (/right/i.test(name)) return 'right';
  if (/left/i.test(name)) return 'left';
  if (/(^|[_.\s:-])r(\d*)$|(^|[_.\s:-])r[_.\s:-]/i.test(name)) return 'right';
  if (/(^|[_.\s:-])l(\d*)$|(^|[_.\s:-])l[_.\s:-]/i.test(name)) return 'left';
  return null;
}

function fingerOf(name: string): FingerName | null {
  const k = key(name);
  if (k.includes('thumb')) return 'thumb';
  if (k.includes('index')) return 'index';
  if (k.includes('middle')) return 'middle';
  if (k.includes('ring')) return 'ring';
  if (k.includes('pinky') || k.includes('little')) return 'pinky';
  return null;
}

const helper = (b: Bone) => /twist|roll|helper|ik|pole|target/i.test(b.name);
/** The parent a limb carries on through: twist and helper bones in between are passed over. */
function limbParent(b: Bone): Bone | null {
  let p = b.parent;
  while (isBone(p) && helper(p)) p = p.parent;
  return isBone(p) ? p : null;
}

function findLimbs(bones: Bone[]): Limb[] {
  const limbs: Limb[] = [];
  for (const hand of bones) {
    if (helper(hand)) continue;
    const fingers: Finger[] = [];
    for (const c of boneKids(hand)) {
      const f = fingerOf(c.name);
      if (!f || fingers.some((x) => x.name === f)) continue;
      const chain: Bone[] = [];
      for (let b: Bone | null = c; b && chain.length < 4; b = mainChild(b)) {
        if (fingerOf(b.name) !== f && chain.length) break;
        chain.push(b);
      }
      // a leaf "end" bone only marks the tip
      if (chain.length > 3) chain.length = 3;
      fingers.push({ name: f, bones: chain });
    }
    if (fingers.length < 3) continue;
    const fore = limbParent(hand);
    const upper = fore && limbParent(fore);
    if (!fore || !upper) continue;
    const cl = limbParent(upper);
    const clavicle = cl && !/spine|chest|neck|pelvis|hips|root/i.test(cl.name) && /clav|shoulder/i.test(cl.name) ? cl : null;
    fingers.sort((a, b) => FINGERS.indexOf(a.name) - FINGERS.indexOf(b.name));
    const side = sideOf(hand.name) ?? sideOf(fore.name) ?? 'right';
    limbs.push({ side, clavicle, upper, fore, hand, fingers });
  }
  return limbs;
}

function subtree(b: Bone, into: Set<Bone>) {
  into.add(b);
  for (const c of boneKids(b)) subtree(c, into);
  return into;
}

/** Every vertex of a skinned mesh in world space, as its bones are posed now. Faster than three's per-vertex call for whole bodies. */
export function skinPositions(mesh: SkinnedMesh, out?: Float32Array): Float32Array {
  const g = mesh.geometry;
  const pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
  const n = pos.count;
  const res = out ?? new Float32Array(n * 3);
  const sk = mesh.skeleton;
  mesh.updateMatrixWorld(true);
  // world <- mesh <- bindInverse <- bone <- boneInverse <- bind
  const mats = sk.bones.map((b, i) =>
    new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).multiply(b.matrixWorld).multiply(sk.boneInverses[i]).multiply(mesh.bindMatrix).elements,
  );
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let ox = 0, oy = 0, oz = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      const e = mats[si.getComponent(i, k)];
      if (!e) continue;
      ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
      oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
      oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
      wsum += w;
    }
    if (wsum <= 0) {
      const e = mesh.matrixWorld.elements;
      ox = e[0] * x + e[4] * y + e[8] * z + e[12]; oy = e[1] * x + e[5] * y + e[9] * z + e[13]; oz = e[2] * x + e[6] * y + e[10] * z + e[14];
      wsum = 1;
    }
    res[i * 3] = ox / wsum; res[i * 3 + 1] = oy / wsum; res[i * 3 + 2] = oz / wsum;
  }
  return res;
}

/**
 * Finds the body in a loaded character. Call with the character in its rest (bind) pose; that pose is what every turn and stretch
 * is measured from. Returns null when no arm with a hand and fingers is found.
 */
export function buildBody(root: Object3D): Body | null {
  root.updateMatrixWorld(true);
  const bones: Bone[] = [];
  const meshes: SkinnedMesh[] = [];
  root.traverse((o) => {
    if (isBone(o)) bones.push(o);
    if ((o as SkinnedMesh).isSkinnedMesh && (o as SkinnedMesh).visible !== false) meshes.push(o as SkinnedMesh);
  });
  const limbList = findLimbs(bones);
  if (!limbList.length) return null;
  const limbs: Partial<Record<Side, Limb>> = {};
  for (const l of limbList) if (!limbs[l.side]) limbs[l.side] = l;
  const by = (re: RegExp) => bones.filter((b) => re.test(b.name) && !helper(b));
  const spine = by(/spine|chest/i);
  const neck = by(/neck/i)[0] ?? null;
  const head = bones.find((b) => /head/i.test(b.name) && !/end|top|nub/i.test(b.name) && !helper(b)) ?? null;
  const pelvis = by(/pelvis|hips/i)[0] ?? null;

  const restWorld = new Map<Bone, Matrix4>();
  const restLocal = new Map<Bone, { position: Vector3; quaternion: Quaternion; scale: Vector3 }>();
  for (const b of bones) {
    restWorld.set(b, b.matrixWorld.clone());
    restLocal.set(b, { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone() });
  }

  // which region each bone's skin belongs to
  const regionOf = new Map<Bone, Region>();
  for (const b of bones) regionOf.set(b, Region.Legs);
  const upperBody = new Set<Bone>();
  for (const s of [...spine, ...(neck ? [neck] : [])]) upperBody.add(s);
  for (const b of upperBody) regionOf.set(b, Region.Torso);
  if (pelvis) regionOf.set(pelvis, Region.Torso);
  if (head) for (const b of subtree(head, new Set())) regionOf.set(b, Region.Head);
  for (const l of Object.values(limbs) as Limb[]) {
    if (l.clavicle) regionOf.set(l.clavicle, Region.Torso);
    for (const b of subtree(l.upper, new Set())) regionOf.set(b, armRegion(l.side, 'upper'));
    for (const b of subtree(l.fore, new Set())) regionOf.set(b, armRegion(l.side, 'fore'));
    for (const b of subtree(l.hand, new Set())) regionOf.set(b, armRegion(l.side, 'hand'));
  }

  const skin: SkinPart[] = [];
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw) continue;
    const n = pos.count;
    const region = new Uint8Array(n), blend = new Uint8Array(n).fill(255);
    const bone: (Bone | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      let b1 = -1, w1 = 0, b2 = -1, w2 = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k), b = si.getComponent(i, k);
        if (w > w1) { b2 = b1; w2 = w1; b1 = b; w1 = w; } else if (w > w2) { b2 = b; w2 = w; }
      }
      const B1 = mesh.skeleton.bones[b1] ?? null;
      bone[i] = B1;
      region[i] = B1 ? regionOf.get(B1) ?? Region.Legs : Region.Legs;
      const B2 = mesh.skeleton.bones[b2];
      if (B2 && w2 > 0.12) {
        const r2 = regionOf.get(B2) ?? Region.Legs;
        if (r2 !== region[i]) blend[i] = r2;
      }
    }
    const idx = g.getIndex();
    const index = idx ? Uint32Array.from(idx.array as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i);
    skin.push({ mesh, index, region, blend, bone, rest: skinPositions(mesh) });
  }

  // up: pelvis to head; forward: square to the shoulders, the way the feet or the face point
  const at = (b: Bone | null | undefined) => (b ? b.getWorldPosition(new Vector3()) : null);
  const up = new Vector3(0, 1, 0);
  const R = limbs.right ? at(limbs.right.upper)! : null, L = limbs.left ? at(limbs.left.upper)! : null;
  const forward = new Vector3(0, 0, 1);
  if (R && L) {
    forward.crossVectors(up, R.clone().sub(L)).setY(0);
    if (forward.lengthSq() < 1e-10) forward.set(0, 0, 1);
    forward.normalize();
  }
  const foot = bones.find((b) => /foot/i.test(b.name)), toe = foot && mainChild(foot);
  if (foot && toe) {
    const d = at(toe)!.sub(at(foot)!).setY(0);
    if (d.lengthSq() > 1e-8 && d.dot(forward) < 0) forward.negate();
  }

  let lo = Infinity, hi = -Infinity;
  for (const s of skin) for (let i = 1; i < s.rest.length; i += 3) { lo = Math.min(lo, s.rest[i]); hi = Math.max(hi, s.rest[i]); }
  const body: Body = { root, bones, limbs, spine, neck, head, pelvis, skin, restWorld, restLocal, forward, up, thickness: [], height: hi - lo };
  body.thickness = regionThickness(body);
  return body;
}

/** For each region, the 90th percentile of how far its rest skin is from its own bone's line to the bone's main child. */
function regionThickness(body: Body): number[] {
  const out: number[] = [];
  const ds: number[][] = REGION_NAMES.map(() => []);
  const seg = new Map<Bone, [Vector3, Vector3]>();
  for (const b of body.bones) {
    const a = new Vector3().setFromMatrixPosition(body.restWorld.get(b)!);
    const c = mainChild(b);
    const e = c ? new Vector3().setFromMatrixPosition(body.restWorld.get(c)!) : a.clone();
    seg.set(b, [a, e]);
  }
  const p = new Vector3(), ab = new Vector3(), ap = new Vector3();
  for (const s of body.skin) {
    for (let i = 0; i < s.region.length; i += 3) {
      const b = s.bone[i];
      if (!b) continue;
      const [a, e] = seg.get(b)!;
      p.fromArray(s.rest, i * 3);
      ab.subVectors(e, a);
      const t = ab.lengthSq() > 1e-12 ? Math.min(1, Math.max(0, ap.subVectors(p, a).dot(ab) / ab.lengthSq())) : 0;
      ds[s.region[i]].push(p.distanceTo(a.clone().addScaledVector(ab, t)));
    }
  }
  for (const d of ds) {
    d.sort((x, y) => x - y);
    out.push(d.length ? d[Math.floor(d.length * 0.9)] : 0.05);
  }
  return out;
}

/** Puts every bone back in its rest pose. */
export function restPose(body: Body) {
  for (const [b, r] of body.restLocal) {
    b.position.copy(r.position);
    b.quaternion.copy(r.quaternion);
    b.scale.copy(r.scale);
  }
  body.root.updateMatrixWorld(true);
}

/** Every drawn skin vertex where the bones are now, per skin part (world space). */
export function posedSkin(body: Body): Float32Array[] {
  body.root.updateMatrixWorld(true);
  return body.skin.map((s) => skinPositions(s.mesh));
}

/** A bone's world turn from rest (world = delta * rest). */
export function worldDelta(body: Body, b: Bone): Quaternion {
  const q = new Quaternion(), r = new Quaternion();
  const _a = new Vector3(), _b = new Vector3();
  b.matrixWorld.decompose(_a, q, _b);
  body.restWorld.get(b)!.decompose(_a, r, _b);
  return q.multiply(r.invert());
}

export const worldPos = (b: Bone) => new Vector3().setFromMatrixPosition(b.matrixWorld);
export const restPos = (body: Body, b: Bone) => new Vector3().setFromMatrixPosition(body.restWorld.get(b)!);
export const restQuat = (body: Body, b: Bone) => {
  const q = new Quaternion();
  body.restWorld.get(b)!.decompose(new Vector3(), q, new Vector3());
  return q;
};

/** Sets a bone's world matrix (position and turn; its scale stays), keeping its children where their own local transforms put them. */
export function setWorld(b: Bone, position: Vector3, quaternion: Quaternion) {
  const parent = b.parent;
  parent?.updateWorldMatrix(true, false);
  const scale = new Vector3().setFromMatrixScale(b.matrixWorld);
  const world = new Matrix4().compose(position, quaternion, scale);
  const local = parent ? parent.matrixWorld.clone().invert().multiply(world) : world;
  local.decompose(b.position, b.quaternion, new Vector3());
  b.updateMatrixWorld(true);
}

/** The bone a finger ends at, and where its tip is at rest: the far end of the skin weighted to its last bone. */
export function fingerTips(body: Body, limb: Limb): Map<FingerName, { bone: Bone; local: Vector3 }> {
  const out = new Map<FingerName, { bone: Bone; local: Vector3 }>();
  for (const f of limb.fingers) {
    const last = f.bones[f.bones.length - 1];
    const head = restPos(body, last);
    let far = -1;
    const best = new Vector3();
    const p = new Vector3();
    for (const s of body.skin) for (let i = 0; i < s.bone.length; i++) {
      if (s.bone[i] !== last) continue;
      p.fromArray(s.rest, i * 3);
      const d = p.distanceTo(head);
      if (d > far) { far = d; best.copy(p); }
    }
    if (far < 0) {
      // no skin on the last bone: carry on along the finger by the last segment's length
      const prev = f.bones.length > 1 ? restPos(body, f.bones[f.bones.length - 2]) : restPos(body, limb.hand);
      best.copy(head).add(head.clone().sub(prev));
    }
    out.set(f.name, { bone: last, local: best.applyMatrix4(body.restWorld.get(last)!.clone().invert()) });
  }
  return out;
}
