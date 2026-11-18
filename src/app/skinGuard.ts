import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { GraspObject } from '../core/grasp/object';
import { type RiggedHand, setHandPose } from './handRig';

/**
 * Keeps the drawn hand out of the held thing. The solver closes the fingers with collision spheres that sit inside the skin,
 * so the skin over a knuckle, a thumb's root or the heel of the palm can still go into a gun. This measures the real skin
 * against the real held mesh both ways (skin points inside the held thing, and points of the held thing inside the skin,
 * which catches a thin edge cutting between skin points) and takes the hand out of it:
 *
 * 1. each finger joint, from the knuckle out, is turned within its own limits just far enough to take its segment out;
 * 2. what no finger joint can clear (the palm, a thumb's root) moves the whole hand out along the way out of the held thing;
 * 3. from there the fingers that were on the part close again until their skin touches it.
 *
 * The result is clear when nothing is deeper than `tol`: skin resting on the part, not in it.
 */

export const SKIN_PARTS = ['thumb', 'index', 'middle', 'ring', 'little', 'palm'] as const;
export type SkinPart = (typeof SKIN_PARTS)[number];

export interface SkinReport {
  /** How deep the skin and the held thing are in each other, per finger and the palm (metres, 0 = clear). */
  depth: Record<SkinPart, number>;
  /** The deepest of them. */
  worst: number;
  /** Nearest the skin of each finger and the palm comes to the held thing (metres, negative = inside). */
  gap: Record<SkinPart, number>;
}

export interface GuardOptions {
  /** Deeper than this is a collision (metres). */
  tol?: number;
  /** A finger whose skin comes this near the held thing is on it (metres). */
  contact?: number;
  /** Fingers that stay as they were put (a fingertip pinned to a trigger, a finger laid along a frame): only turned out of the part. */
  keep?: number[];
  /** Furthest the whole hand may be moved out (metres); default half the hand's length. */
  maxMove?: number;
}

export interface GuardResult {
  wrist: Matrix4;
  angles: Float32Array;
  before: SkinReport;
  after: SkinReport;
  /** How far the whole hand was moved out of the held thing (metres). */
  moved: number;
  /** What was turned or moved, in words. */
  changes: string[];
  /** Nothing deeper than tol. */
  clear: boolean;
}

/** One piece of the skin: a finger (all its segments) or the palm, with its own tree for "is this point inside the skin". */
interface Piece {
  verts: Uint32Array;
  /** Segment of each of the piece's triangles (0 for the palm). */
  triLink: Uint8Array;
  geo: BufferGeometry;
  bvh: MeshBVH;
  links: number;
  /** No point is deeper inside this piece than this: its flesh is not that thick (metres). */
  deepest: number;
}

interface Violation {
  depth: number;
  /** Piece (finger index, or the number of fingers for the palm) and segment. */
  piece: number;
  link: number;
  /** The way the hand would have to move to take this point out. */
  out: Vector3;
}

interface PieceEval {
  /** Depth per segment (metres, 0 = clear). */
  link: Float64Array;
  /** Nearest any skin point of the piece comes to the held thing (negative inside). */
  gap: number;
  violations: Violation[];
}

/** Points along the held thing's edges are this far apart at most: thinner than a finger's skin is between its points. */
const EDGE_STEP = 0.002;

/** Every corner of a mesh and points along each of its edges, each edge once. */
function edgePoints(P: Float32Array, I: Uint32Array): Float32Array {
  const out: number[] = Array.from(P);
  const seen = new Set<string>();
  for (let t = 0; t + 2 < I.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az;
      const n = Math.floor(Math.hypot(dx, dy, dz) / EDGE_STEP);
      for (let i = 1; i <= n; i++) {
        const f = i / (n + 1);
        out.push(ax + dx * f, ay + dy * f, az + dz * f);
      }
    }
  }
  return Float32Array.from(out);
}

const NAME: Record<string, SkinPart> = { thumb: 'thumb', index: 'index', middle: 'middle', ring: 'ring', pinky: 'little', little: 'little' };
const _v = new Vector3();
const _q = new Vector3();
const _n = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _hit = { point: new Vector3(), distance: 0, faceIndex: 0 };

export class SkinGuard {
  /** Each skin vertex: which mesh, and its index there. */
  private readonly vMesh: Uint16Array;
  private readonly vLocal: Uint32Array;
  /** Each skin vertex: its finger (-1 palm) and segment. */
  private readonly vFinger: Int8Array;
  private readonly vLink: Uint8Array;
  /** Posed skin positions in the held thing's space. */
  private readonly P: Float32Array;
  private readonly pieces: Piece[];
  private readonly meshMats: Matrix4[];
  /** +1 when a point inside the skin lies behind its triangles' (b - a) x (c - a) side, -1 when the winding is the other way. */
  private readonly skinSide: number;
  private wristSide = 1;
  private readonly objMin: Vector3;
  private readonly objMax: Vector3;
  /** The held thing's corners and points along its edges (at most EDGE_STEP apart), tested against the inside of the skin. */
  private readonly objPts: Float32Array;
  /** Every skin triangle (vertex ids), for the winding number. */
  private readonly allTris: Uint32Array;
  /** Bumped by each place(); the whole skin is posed again when a winding number is wanted after one. */
  private placed = 0;
  private wholePosed = -1;
  private readonly whole: { geo: BufferGeometry; bvh: MeshBVH | null; loops: Uint32Array[] };
  /** Winding answers for the held thing's points where the hand is now. */
  private readonly inside = new Map<number, boolean>();
  /** Distance queries, winding numbers and piece measures made, for timing checks. */
  queries = 0;
  windings = 0;
  evals = 0;

  constructor(
    readonly hand: RiggedHand,
    readonly object: GraspObject,
  ) {
    const model = hand.model;
    const jointFinger = new Int8Array(model.joints.length).fill(-1);
    const jointLink = new Uint8Array(model.joints.length);
    model.fingers.forEach((f, fi) => f.joints.forEach((j, k) => ((jointFinger[j] = fi), (jointLink[j] = k))));
    let total = 0;
    for (const m of hand.meshes) total += m.geometry.getAttribute('position').count;
    this.vMesh = new Uint16Array(total);
    this.vLocal = new Uint32Array(total);
    this.vFinger = new Int8Array(total);
    this.vLink = new Uint8Array(total);
    this.P = new Float32Array(total * 3);
    this.meshMats = hand.meshes.map(() => new Matrix4());
    const nPieces = model.fingers.length + 1;
    const palm = model.fingers.length;
    const pieceVerts: number[][] = Array.from({ length: nPieces }, () => []);
    const pieceTris: number[][] = Array.from({ length: nPieces }, () => []);
    const pieceTriLink: number[][] = Array.from({ length: nPieces }, () => []);
    let base = 0;
    hand.meshes.forEach((mesh, mi) => {
      const g = mesh.geometry;
      const n = g.getAttribute('position').count;
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      for (let i = 0; i < n; i++) {
        let best = 0, w = -1;
        for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > w) ((w = sw.getComponent(i, k)), (best = si.getComponent(i, k)));
        const id = base + i;
        this.vMesh[id] = mi;
        this.vLocal[id] = i;
        this.vFinger[id] = best < jointFinger.length ? jointFinger[best] : -1;
        this.vLink[id] = best < jointLink.length ? jointLink[best] : 0;
        pieceVerts[this.vFinger[id] < 0 ? palm : this.vFinger[id]].push(id);
      }
      const index = g.index;
      const count = index ? index.count : n;
      for (let t = 0; t + 2 < count; t += 3) {
        const a = base + (index ? index.getX(t) : t);
        const b = base + (index ? index.getX(t + 1) : t + 1);
        const c = base + (index ? index.getX(t + 2) : t + 2);
        // a triangle belongs to the piece most of its corners belong to
        const pa = this.pieceOf(a), pb = this.pieceOf(b), pc = this.pieceOf(c);
        const p = pb === pc ? pb : pa;
        const corner = p === pa ? a : p === pb ? b : c;
        pieceTris[p].push(a, b, c);
        pieceTriLink[p].push(p === palm ? 0 : this.vLink[corner]);
      }
      base += n;
    });
    this.allTris = Uint32Array.from(pieceTris.flat());
    this.pieces = pieceVerts.map((verts, p) => {
      // a piece's triangles may reach corners of the next piece: those are posed with it
      const own = new Set(verts);
      for (const v of pieceTris[p]) own.add(v);
      const list = Uint32Array.from(own);
      const local = new Map<number, number>();
      list.forEach((v, i) => local.set(v, i));
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, list.length) * 3), 3));
      const tris = pieceTris[p].length ? pieceTris[p].map((v) => local.get(v)!) : [0, 0, 0];
      geo.setIndex(new BufferAttribute(Uint32Array.from(tris), 1));
      const links = p === palm ? 1 : model.fingers[p].joints.length;
      const radii = model.spheres.filter((x) => x.finger === (p === palm ? -1 : p)).map((x) => x.radius);
      const deepest = 1.6 * Math.max(0.005, ...radii) + 0.003;
      return { verts: list, triLink: Uint8Array.from(pieceTriLink[p].length ? pieceTriLink[p] : [0]), geo, bvh: null as unknown as MeshBVH, links, deepest };
    });
    // which way the skin's triangles face: test the finger joints, which lie inside the flesh, at rest
    const rest = new Float32Array(model.dofCount);
    this.place(new Matrix4(), rest);
    let behind = 0, front = 0;
    model.fingers.forEach((f, fi) => {
      const piece = this.pieces[fi];
      this.refit(piece);
      f.joints.forEach((j, k) => {
        if (k === 0) return;
        const s = this.side(piece, model.joints[j].position, Infinity);
        if (s < 0) behind++;
        else if (s > 0) front++;
      });
    });
    this.skinSide = behind >= front ? 1 : -1;
    for (const piece of this.pieces) this.pose(piece.verts);
    this.whole = this.closeSkin();
    const P = object.positions;
    this.objPts = edgePoints(P, object.index);
    this.objMin = new Vector3(Infinity, Infinity, Infinity);
    this.objMax = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < P.length; i += 3) {
      this.objMin.min(_v.set(P[i], P[i + 1], P[i + 2]));
      this.objMax.max(_v);
    }
  }

  private pieceOf(v: number): number {
    return this.vFinger[v] < 0 ? this.hand.model.fingers.length : this.vFinger[v];
  }

  private partOf(piece: number): SkinPart {
    const f = this.hand.model.fingers[piece];
    return f ? (NAME[f.name] ?? 'index') : 'palm';
  }

  /** Poses the hand (the rigged hand's own bones are moved: show the pose wanted afterwards). */
  private place(wrist: Matrix4, angles: Float32Array) {
    setHandPose(this.hand, { wrist, angles });
    const toObject = wrist.clone().multiply(this.hand.root.matrixWorld.clone().invert());
    this.hand.meshes.forEach((m, i) => this.meshMats[i].multiplyMatrices(toObject, m.matrixWorld));
    this.wristSide = wrist.determinant() < 0 ? -1 : 1;
    this.placed++;
  }

  /**
   * Whether a point is inside the whole skin, by the whole skin's nearest triangle with its holes capped: a piece alone is open where
   * it joins the next, and a hand cut from an arm is open at the wrist, so a point seen through an opening could read "inside".
   */
  private insideSkin(q: Vector3, key: number): boolean {
    const w = this.whole;
    if (this.wholePosed !== this.placed) {
      for (const piece of this.pieces) this.pose(piece.verts);
      const attr = w.geo.getAttribute('position') as BufferAttribute;
      const arr = attr.array as Float32Array;
      const n = this.P.length / 3;
      arr.set(this.P);
      w.loops.forEach((loop, c) => {
        let x = 0, y = 0, z = 0;
        for (const v of loop) ((x += this.P[v * 3]), (y += this.P[v * 3 + 1]), (z += this.P[v * 3 + 2]));
        arr[(n + c) * 3] = x / loop.length;
        arr[(n + c) * 3 + 1] = y / loop.length;
        arr[(n + c) * 3 + 2] = z / loop.length;
      });
      attr.needsUpdate = true;
      if (!w.bvh) w.bvh = new MeshBVH(w.geo);
      else w.bvh.refit();
      this.wholePosed = this.placed;
      this.inside.clear();
    }
    const known = this.inside.get(key);
    if (known !== undefined) return known;
    this.windings++;
    const inside = this.side(w as { geo: BufferGeometry; bvh: MeshBVH }, q, 0.03) < 0;
    this.inside.set(key, inside);
    return inside;
  }

  /** The whole skin as one closed surface: every triangle, and each hole fanned shut to its middle (a vertex after the skin's own). */
  private closeSkin(): { geo: BufferGeometry; bvh: MeshBVH | null; loops: Uint32Array[] } {
    const n = this.P.length / 3;
    // one id per place, so a seam where the texture is cut is not a hole
    const canon = new Uint32Array(n);
    const at = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(this.P[i * 3] * 1e5)},${Math.round(this.P[i * 3 + 1] * 1e5)},${Math.round(this.P[i * 3 + 2] * 1e5)}`;
      const c = at.get(k);
      if (c === undefined) at.set(k, (canon[i] = i));
      else canon[i] = c;
    }
    const T = this.allTris;
    const edges = new Map<string, { a: number; b: number; count: number }>();
    for (let t = 0; t + 2 < T.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = T[t + e], b = T[t + ((e + 1) % 3)];
        const ca = canon[a], cb = canon[b];
        if (ca === cb) continue;
        const key = ca < cb ? `${ca},${cb}` : `${cb},${ca}`;
        const was = edges.get(key);
        if (was) was.count++;
        else edges.set(key, { a, b, count: 1 });
      }
    const open = [...edges.values()].filter((e) => e.count === 1);
    // the open edges, grouped into the holes they ring
    const parent = new Map<number, number>();
    const root = (v: number): number => {
      let r = v;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(v, r);
      return r;
    };
    for (const e of open) {
      const ra = root(canon[e.a]), rb = root(canon[e.b]);
      if (ra !== rb) parent.set(ra, rb);
    }
    const holeOf = new Map<number, number>();
    const members: Set<number>[] = [];
    for (const e of open) {
      const r = root(canon[e.a]);
      if (!holeOf.has(r)) (holeOf.set(r, members.length), members.push(new Set()));
      members[holeOf.get(r)!].add(e.a).add(e.b);
    }
    const caps: number[] = [];
    for (const e of open) caps.push(e.b, e.a, n + holeOf.get(root(canon[e.a]))!);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array((n + members.length) * 3), 3));
    geo.setIndex(new BufferAttribute(Uint32Array.from([...T, ...caps]), 1));
    return { geo, bvh: null, loops: members.map((m) => Uint32Array.from(m)) };
  }

  private pose(ids: Uint32Array) {
    const P = this.P;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const mi = this.vMesh[id];
      this.hand.meshes[mi].getVertexPosition(this.vLocal[id], _v).applyMatrix4(this.meshMats[mi]);
      P[id * 3] = _v.x;
      P[id * 3 + 1] = _v.y;
      P[id * 3 + 2] = _v.z;
    }
  }

  private refit(piece: Piece) {
    this.pose(piece.verts);
    const a = piece.geo.getAttribute('position') as BufferAttribute;
    const arr = a.array as Float32Array;
    for (let i = 0; i < piece.verts.length; i++) {
      const id = piece.verts[i];
      arr[i * 3] = this.P[id * 3];
      arr[i * 3 + 1] = this.P[id * 3 + 1];
      arr[i * 3 + 2] = this.P[id * 3 + 2];
    }
    a.needsUpdate = true;
    if (!piece.bvh) piece.bvh = new MeshBVH(piece.geo);
    else piece.bvh.refit();
  }

  /**
   * Which side of a piece's skin a point is on, from its nearest triangle: negative inside (by the depth), positive outside,
   * 0 when it cannot tell (the nearest point is on an edge the point lies beside, as past a piece's open end).
   */
  private side(piece: { geo: BufferGeometry; bvh: MeshBVH }, q: Vector3, within: number): number {
    const h = piece.bvh.closestPointToPoint(q, _hit, 0, within);
    if (!h || h.distance < 1e-7) return 0;
    const pos = piece.geo.getAttribute('position').array as Float32Array;
    const idx = piece.geo.index!.array as Uint32Array;
    const a = idx[h.faceIndex * 3] * 3, b = idx[h.faceIndex * 3 + 1] * 3, c = idx[h.faceIndex * 3 + 2] * 3;
    _ab.set(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    _ac.set(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]);
    _n.crossVectors(_ab, _ac).normalize();
    _q.copy(q).sub(h.point).divideScalar(h.distance);
    const cos = _q.dot(_n) * (this.skinSide ?? 1) * this.wristSide;
    if (Math.abs(cos) < 0.3) return 0;
    return cos < 0 ? -h.distance : h.distance;
  }

  /**
   * Measures one piece where the hand is now placed, from segment `fromLink` out. With `only`, just that segment; points no deeper
   * than `floor` are not looked at closely, and once one is found deeper than `stop` the measure ends there (enough for a yes or no).
   */
  private evalPiece(p: number, fromLink = 0, look: { only?: number; floor?: number; stop?: number } = {}): PieceEval {
    const only = look.only ?? -1, floor = look.floor ?? 0, stop = look.stop ?? Infinity;
    const collect = only < 0 && stop === Infinity;
    const piece = this.pieces[p];
    this.evals++;
    const out: PieceEval = { link: new Float64Array(piece.links), gap: Infinity, violations: [] };
    this.refit(piece);
    const P = this.P;
    const lo = this.objMin, hi = this.objMax, m = 0.002;
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    // skin points inside the held thing
    for (let i = 0; i < piece.verts.length; i++) {
      const id = piece.verts[i];
      if (this.pieceOf(id) !== p) continue;
      const k = p === this.hand.model.fingers.length ? 0 : this.vLink[id];
      if (k < fromLink || (only >= 0 && k !== only)) continue;
      const x = P[id * 3], y = P[id * 3 + 1], z = P[id * 3 + 2];
      min.min(_v.set(x, y, z));
      max.max(_v);
      if (x < lo.x - m || y < lo.y - m || z < lo.z - m || x > hi.x + m || y > hi.y + m || z > hi.z + m) {
        // well outside the held thing's box: at least that far from it
        const bx = Math.max(lo.x - x, 0, x - hi.x), by = Math.max(lo.y - y, 0, y - hi.y), bz = Math.max(lo.z - z, 0, z - hi.z);
        out.gap = Math.min(out.gap, Math.hypot(bx, by, bz));
        continue;
      }
      this.queries++;
      const d = this.object.distance(x, y, z);
      if (d < out.gap) out.gap = d;
      if (d < 0) {
        if (-d > out.link[k]) out.link[k] = -d;
        if (collect) out.violations.push({ depth: -d, piece: p, link: k, out: this.object.lastNormal.clone() });
        if (-d > stop) return out;
      }
    }
    // points of the held thing inside the skin: a thin edge between skin points
    const reach = 0.012;
    min.subScalar(reach);
    max.addScalar(reach);
    const O = this.objPts;
    for (let i = 0; i < O.length; i += 3) {
      const x = O[i], y = O[i + 1], z = O[i + 2];
      if (x < min.x || y < min.y || z < min.z || x > max.x || y > max.y || z > max.z) continue;
      const s = this.side(piece, _q.set(x, y, z), reach);
      if (s >= 0 || -s <= floor) continue;
      const k = piece.triLink[_hit.faceIndex] ?? 0;
      if (k < fromLink || (only >= 0 && k !== only)) continue;
      // a point no deeper than one already found changes nothing unless every point is wanted
      if (!collect && -s <= out.link[k]) continue;
      const n = _n.clone();
      if (!this.insideSkin(_q.set(x, y, z), i)) continue;
      _n.copy(n);
      if (-s > out.link[k]) out.link[k] = -s;
      if (s < out.gap) out.gap = s;
      // the hand moves against the skin's outward side here to let the point out
      if (collect) out.violations.push({ depth: -s, piece: p, link: k, out: _n.clone().multiplyScalar(-(this.skinSide ?? 1) * this.wristSide) });
      if (-s > stop) return out;
    }
    return out;
  }

  /** How deep the skin and the held thing are in each other for a pose. */
  measure(wrist: Matrix4, angles: Float32Array): SkinReport {
    this.place(wrist, angles);
    const depth = { thumb: 0, index: 0, middle: 0, ring: 0, little: 0, palm: 0 } as Record<SkinPart, number>;
    const gap = { thumb: Infinity, index: Infinity, middle: Infinity, ring: Infinity, little: Infinity, palm: Infinity } as Record<SkinPart, number>;
    for (let p = 0; p < this.pieces.length; p++) {
      const e = this.evalPiece(p);
      const part = this.partOf(p);
      depth[part] = Math.max(depth[part], ...e.link);
      gap[part] = Math.min(gap[part], e.gap);
    }
    return { depth, worst: Math.max(...Object.values(depth)), gap };
  }

  /** Takes the hand out of the held thing (see the class comment). */
  clear(wrist0: Matrix4, angles0: Float32Array, options: GuardOptions = {}): GuardResult {
    const model = this.hand.model;
    const tol = options.tol ?? 0.001;
    const contact = options.contact ?? 0.002;
    const keep = new Set(options.keep ?? []);
    const maxMove = options.maxMove ?? 0.3 * model.size;
    const before = this.measure(wrist0, angles0);
    let wrist = wrist0.clone();
    const changes: string[] = [];
    let moved = 0;
    if (before.worst <= tol) return { wrist, angles: Float32Array.from(angles0), before, after: before, moved, changes, clear: true };
    // fingers that were on the part close onto it again wherever the hand ends up
    const onPart = model.fingers.map((f, fi) => !keep.has(fi) && before.gap[this.partOf(fi)] <= 2 * contact + tol);
    /** The fingers turned out of the part and closed back onto it with the hand at `w`; what is still in afterwards. */
    const attempt = (w: Matrix4, from: Float32Array) => {
      const angles = Float32Array.from(from);
      const said: string[] = [];
      for (let fi = 0; fi < model.fingers.length; fi++) this.fixFinger(fi, w, angles, tol, said);
      for (let fi = 0; fi < model.fingers.length; fi++) if (onPart[fi]) this.closeFinger(fi, w, angles, tol, contact, said);
      this.place(w, angles);
      const left: Violation[] = [];
      for (let p = 0; p < this.pieces.length; p++) for (const v of this.evalPiece(p, 0, { floor: tol }).violations) if (v.depth > tol) left.push(v);
      if (typeof process !== 'undefined' && process.env?.GUARD_DEBUG) {
        const by = new Map<string, number>();
        for (const v of left) by.set(`${v.piece}:${v.link}`, Math.max(by.get(`${v.piece}:${v.link}`) ?? 0, v.depth));
        console.log('attempt', w.elements.slice(12, 15).map((x) => x.toFixed(4)).join(','), JSON.stringify([...by].map(([k, d]) => `${k}=${(d * 1000).toFixed(1)}`)));
      }
      return { angles, left, said, sum: left.reduce((t, v) => t + v.depth, 0) };
    };
    const shifted = (w: Matrix4, way: Vector3, t: number) => new Matrix4().makeTranslation(way.x * t, way.y * t, way.z * t).multiply(w);
    const opened = Float32Array.from(model.joints.flatMap((j) => j.dofs.map((d) => Math.max(d.min, Math.min(d.max, d.open ?? 0)))));
    let best = attempt(wrist, angles0);
    // what no finger joint can take out moves the whole hand: the least move along the way out that leaves nothing in
    /** Along one way: the least move that leaves nothing in, or failing that the move that left least in. */
    const search = (way: Vector3, from: Float32Array, room: number) => {
      let lo = 0, hi = NaN;
      let good = best, least = best, leastT = 0;
      for (let t = Math.min(room, Math.max(0.001, Math.max(...best.left.map((v) => v.depth)))); ; t = Math.min(room, t * 2)) {
        const probe = attempt(shifted(wrist, way, t), from);
        if (!probe.left.length) {
          hi = t;
          good = probe;
          break;
        }
        if (probe.sum < least.sum) ((least = probe), (leastT = t));
        lo = t;
        if (t >= room) break;
      }
      if (!Number.isFinite(hi)) return { out: false, t: leastT, result: least };
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        const probe = attempt(shifted(wrist, way, mid), from);
        if (probe.left.length) lo = mid;
        else ((hi = mid), (good = probe));
      }
      return { out: true, t: hi, result: good };
    };
    for (let tries = 0; tries < 4 && best.left.length; tries++) {
      // twice from the grip's own fingers, then from open fingers
      const from = tries < 2 ? angles0 : opened;
      const room = maxMove - moved;
      if (room <= 0) break;
      // two ways out: against what is in (the faces it is in say which way is out), and back off the palm; the shorter one wins
      const ways: Vector3[] = [];
      const pushed = new Vector3();
      for (const v of best.left) pushed.addScaledVector(v.out, v.depth);
      if (pushed.lengthSq() > 1e-12) ways.push(pushed.normalize());
      const back = model.frame.normal.clone().transformDirection(wrist).negate();
      if (!ways.length || ways[0].dot(back) < 0.98) ways.push(back);
      let pick: ReturnType<typeof search> | null = null;
      for (const way of ways) {
        const r = search(way, from, room);
        const better = !pick || (r.out && (!pick.out || r.t < pick.t)) || (!r.out && !pick.out && r.result.sum < pick.result.sum);
        if (better) pick = { ...r, way } as ReturnType<typeof search> & { way: Vector3 };
      }
      const chosen = pick as ReturnType<typeof search> & { way: Vector3 };
      if (chosen.out || chosen.t > 0) {
        // not out along either way: go where the least was left in, and look again from there
        wrist = shifted(wrist, chosen.way, chosen.t);
        moved += chosen.t;
        best = chosen.result;
      } else if (tries >= 1) break;
    }
    const angles = best.angles;
    changes.push(...best.said);
    const after = this.measure(wrist, angles);
    if (moved > 0) changes.push(`hand moved ${(moved * 1000).toFixed(1)} mm out`);
    return { wrist, angles, before, after, moved, changes, clear: after.worst <= tol };
  }

  /** Turns each joint of a finger, knuckle first, just far enough within its limits that its own segment is out of the part. */
  private fixFinger(fi: number, wrist: Matrix4, angles: Float32Array, tol: number, said: string[]) {
    const model = this.hand.model;
    const f = model.fingers[fi];
    for (let k = 0; k < f.joints.length; k++) {
      this.place(wrist, angles);
      let depth = this.evalPiece(fi, k, { only: k, floor: tol }).link[k];
      if (depth <= tol) continue;
      const joint = model.joints[f.joints[k]];
      // the bend first, then any sideways freedom (a thumb's saddle); two passes so they can share the work
      const order = joint.dofs.map((_, d) => d).sort((a, b) => Number(joint.dofs[b].kind === 'flex') - Number(joint.dofs[a].kind === 'flex'));
      for (let pass = 0; pass < 2 && depth > tol; pass++) {
        for (const d of order) {
          const dof = joint.dofs[d];
          const at = joint.dofStart + d;
          const a0 = angles[at];
          const targets = [Math.max(dof.min, Math.min(dof.max, dof.open ?? 0)), dof.min, dof.max].filter((t, i, all) => Math.abs(t - a0) > 1e-4 && all.indexOf(t) === i);
          let best = { depth, to: a0 };
          let cleared = false;
          for (const t of targets) {
            const dt = this.linkDepth(fi, k, wrist, angles, at, t, tol, false);
            if (dt <= tol) {
              // the least turn that clears
              let bad = a0, good = t;
              for (let i = 0; i < 9; i++) {
                const mid = (bad + good) / 2;
                if (this.linkDepth(fi, k, wrist, angles, at, mid, tol, true) <= tol) good = mid;
                else bad = mid;
              }
              best = { depth: this.linkDepth(fi, k, wrist, angles, at, good, tol, false), to: good };
              cleared = true;
              break;
            }
            if (dt < best.depth) best = { depth: dt, to: t };
          }
          angles[at] = best.to;
          if (best.to !== a0) said.push(`${f.name} ${k === 0 ? 'base' : k === 1 ? 'middle' : 'end'} joint ${best.to < a0 ? 'opened' : 'closed'} ${Math.abs(((best.to - a0) * 180) / Math.PI).toFixed(0)} deg`);
          depth = best.depth;
          if (cleared) break;
        }
      }
    }
  }

  /** Segment k's depth with one angle set to `value` (with `quick`, only whether it is deeper than tol). */
  private linkDepth(fi: number, k: number, wrist: Matrix4, angles: Float32Array, at: number, value: number, tol: number, quick: boolean): number {
    const was = angles[at];
    angles[at] = value;
    this.place(wrist, angles);
    const d = this.evalPiece(fi, k, { only: k, floor: tol, stop: quick ? tol : Infinity }).link[k];
    angles[at] = was;
    return d;
  }

  /** A finger that was on the part and is now off it bends in again, knuckle first, until its skin touches. */
  private closeFinger(fi: number, wrist: Matrix4, angles: Float32Array, tol: number, contact: number, said: string[]) {
    const model = this.hand.model;
    const f = model.fingers[fi];
    this.place(wrist, angles);
    // the skin's own points say how near a finger is: nothing else is needed for touching
    const near = { floor: Infinity };
    if (this.evalPiece(fi, 0, near).gap <= contact) return;
    const start = Float32Array.from(angles);
    const told = said.length;
    const stepAngle = (4 * Math.PI) / 180;
    for (let k = 0; k < f.joints.length; k++) {
      const joint = model.joints[f.joints[k]];
      const d = joint.dofs.findIndex((x) => x.kind === 'flex');
      if (d < 0) continue;
      const dof = joint.dofs[d];
      const at = joint.dofStart + d;
      const a0 = angles[at];
      const inAt = (a: number) => {
        angles[at] = a;
        this.place(wrist, angles);
        const e = this.evalPiece(fi, k, { floor: tol, stop: tol });
        return { deep: Math.max(...e.link.slice(k)) > tol };
      };
      // in small steps, so a finger never jumps across a thin part
      let good = a0, bad = NaN;
      for (let a = a0 + stepAngle; ; a += stepAngle) {
        const t = Math.min(a, dof.max);
        if (inAt(t).deep) {
          bad = t;
          break;
        }
        good = t;
        if (t >= dof.max) break;
      }
      if (Number.isFinite(bad)) {
        for (let i = 0; i < 7; i++) {
          const mid = (good + bad) / 2;
          if (inAt(mid).deep) bad = mid;
          else good = mid;
        }
      }
      angles[at] = good;
      this.place(wrist, angles);
      const touching = this.evalPiece(fi, 0, near).gap <= contact;
      if (good !== a0) said.push(`${f.name} ${k === 0 ? 'base' : k === 1 ? 'middle' : 'end'} joint closed ${(((good - a0) * 180) / Math.PI).toFixed(0)} deg onto the part`);
      if (touching) return;
    }
    // it reached nothing: a finger that curls into a fist round empty air is worse than one left where it was
    for (let k = 0; k < f.joints.length; k++) {
      const joint = model.joints[f.joints[k]];
      for (let d = 0; d < joint.dofs.length; d++) angles[joint.dofStart + d] = start[joint.dofStart + d];
    }
    said.length = told;
    said.push(`${f.name} reached nothing and stays open`);
  }
}
