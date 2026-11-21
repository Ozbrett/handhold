import type { Contact } from '../core/grasp/quality';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { type GraspObject, facesAround, onTriangleEdge } from '../core/grasp/object';
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
  /** The bones that move this piece's vertices, as `mesh * BONE_KEY + bone`. */
  deps: Uint32Array;
  /** The pose version its vertices were last posed at, and its tree last refitted at (-1: never). */
  posedAt: number;
  fitAt: number;
  /** Where its vertices were when the bounds below were taken, and the furthest any has moved from there since (metres). */
  ref: Float32Array | null;
  drift: number;
  /** For each point of the held thing, a distance the skin was at least this far from it (-Infinity: not known). */
  bound: Float64Array;
}

/** Keys a bone of one of the hand's meshes: `mesh * BONE_KEY + bone`. */
const BONE_KEY = 65536;

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
/** Points of the held thing are looked for inside the skin this near its surface (metres). */
const REACH = 0.012;
/** And measured a little further than that, so a point found out of reach can be left alone until the skin has moved this far. */
const PROBE = 0.01;
/** A measured gap is exact up to this (metres); further gaps are only known to be further. */
const GAP_EXACT = 0.01;

/** The held thing's points sorted into a grid of cells, so the ones near a piece of skin are found without going through all. */
interface PointGrid {
  lo: Vector3;
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  /** Cell c holds items[start[c]] up to items[start[c + 1]], in ascending order. */
  start: Int32Array;
  items: Int32Array;
  scratch: Int32Array;
  all: Int32Array;
}

function pointGrid(O: Float32Array, lo: Vector3, hi: Vector3): PointGrid {
  const n = O.length / 3;
  const size = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, 1e-6);
  const cell = Math.max(0.008, size / 48);
  const nx = Math.max(1, Math.ceil((hi.x - lo.x) / cell) + 1);
  const ny = Math.max(1, Math.ceil((hi.y - lo.y) / cell) + 1);
  const nz = Math.max(1, Math.ceil((hi.z - lo.z) / cell) + 1);
  const at = (v: number, o: number, k: number) => Math.min(k - 1, Math.max(0, Math.floor((v - o) / cell)));
  const cellOf = new Int32Array(n);
  const start = new Int32Array(nx * ny * nz + 1);
  for (let j = 0; j < n; j++) {
    const c = (at(O[j * 3 + 2], lo.z, nz) * ny + at(O[j * 3 + 1], lo.y, ny)) * nx + at(O[j * 3], lo.x, nx);
    cellOf[j] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < nx * ny * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny * nz);
  const items = new Int32Array(n);
  for (let j = 0; j < n; j++) items[fill[cellOf[j]]++] = j;
  return { lo: lo.clone(), cell, nx, ny, nz, start, items, scratch: new Int32Array(n), all: Int32Array.from({ length: n }, (_, j) => j) };
}

/** Faces meeting at an edge this far from flat (radians) make a sharp edge, which can poke into the skin anywhere along it. */
const SHARP = 0.17;
/** A corner whose faces take up this much less than a whole turn round it is a point, even if no edge into it is sharp. */
const POINTED = 0.35;
/**
 * The rest of the surface is looked at this far apart (metres). A smooth bump can poke between a coarse skin's points too, but one
 * that pokes a millimetre in is wider than this where it does.
 */
const SURFACE_STEP = 0.003;

/**
 * Points of a mesh that may poke into the skin between the skin's own points: along every sharp edge (convex, if the mesh says
 * which side is out) and open rim, each edge once, the corners at their ends or that come to a point, and the rest of the surface
 * evenly, about SURFACE_STEP apart however finely or coarsely it is cut into triangles.
 */
function edgePoints(P: Float32Array, I: Uint32Array, flip: number, closed: boolean): Float32Array {
  const nv = P.length / 3;
  // one id per place, so faces that do not share vertices still meet
  const canon = new Uint32Array(nv);
  const at = new Map<string, number>();
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;
    const c = at.get(k);
    if (c === undefined) at.set(k, (canon[i] = i));
    else canon[i] = c;
  }
  const nt = Math.floor(I.length / 3);
  const normal = new Float64Array(nt * 3);
  const turn = new Float64Array(nv);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    _ab.set(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    _ac.set(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
    _n.crossVectors(_ab, _ac);
    const l = _n.length();
    if (l > 0) _n.multiplyScalar(flip / l);
    normal[t * 3] = _n.x;
    normal[t * 3 + 1] = _n.y;
    normal[t * 3 + 2] = _n.z;
    // the angle each corner takes up, added up round each place
    for (let e = 0; e < 3; e++) {
      const o = I[t * 3 + e] * 3, u = I[t * 3 + ((e + 1) % 3)] * 3, w = I[t * 3 + ((e + 2) % 3)] * 3;
      _ab.set(P[u] - P[o], P[u + 1] - P[o + 1], P[u + 2] - P[o + 2]);
      _ac.set(P[w] - P[o], P[w + 1] - P[o + 1], P[w + 2] - P[o + 2]);
      if (_ab.lengthSq() > 0 && _ac.lengthSq() > 0) turn[canon[I[t * 3 + e]]] += _ab.angleTo(_ac);
    }
  }
  // the faces at each edge, and the corner of each face across from it
  const faces = new Map<string, number[]>();
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const a = canon[I[t * 3 + e]], b = canon[I[t * 3 + ((e + 1) % 3)]];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = faces.get(key);
      if (list) list.push(t, I[t * 3 + ((e + 2) % 3)]);
      else faces.set(key, [t, I[t * 3 + ((e + 2) % 3)]]);
    }
  }
  const keep = new Uint8Array(nv);
  const out: number[] = [];
  const cos = Math.cos(SHARP);
  for (const [key, list] of faces) {
    const comma = key.indexOf(',');
    const a = Number(key.slice(0, comma)), b = Number(key.slice(comma + 1));
    let sharp = list.length !== 4;
    if (!sharp) {
      const t = list[0], u = list[2], far = list[3] * 3;
      const d = normal[t * 3] * normal[u * 3] + normal[t * 3 + 1] * normal[u * 3 + 1] + normal[t * 3 + 2] * normal[u * 3 + 2];
      // convex: the other face's far corner lies behind this face (a closed mesh says which side is out)
      const behind =
        (P[far] - P[a * 3]) * normal[t * 3] + (P[far + 1] - P[a * 3 + 1]) * normal[t * 3 + 1] + (P[far + 2] - P[a * 3 + 2]) * normal[t * 3 + 2];
      sharp = d < cos && (!closed || behind < 0);
    }
    if (!sharp) continue;
    keep[a] = keep[b] = 1;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az;
    const n = Math.floor(Math.hypot(dx, dy, dz) / EDGE_STEP);
    for (let i = 1; i <= n; i++) {
      const f = i / (n + 1);
      out.push(ax + dx * f, ay + dy * f, az + dz * f);
    }
  }
  const corners: number[] = [];
  for (let i = 0; i < nv; i++) {
    if (canon[i] !== i) continue;
    if (keep[i] || Math.abs(2 * Math.PI - turn[i]) > POINTED) corners.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  }
  // the rest of the surface: rows across each triangle SURFACE_STEP apart, a point every SURFACE_STEP along each row, and one
  // point kept in each cell SURFACE_STEP wide (a long thin triangle gets as many points as its area needs, not its length squared)
  let lx = Infinity, ly = Infinity, lz = Infinity;
  for (let i = 0; i < nv; i++) {
    lx = Math.min(lx, P[i * 3]);
    ly = Math.min(ly, P[i * 3 + 1]);
    lz = Math.min(lz, P[i * 3 + 2]);
  }
  const span = 1 << 20;
  const cells = new Set<number>();
  const even: number[] = [];
  const put = (x: number, y: number, z: number) => {
    const k = (Math.floor((z - lz) / SURFACE_STEP) * span + Math.floor((y - ly) / SURFACE_STEP)) * span + Math.floor((x - lx) / SURFACE_STEP);
    if (cells.has(k)) return;
    cells.add(k);
    even.push(x, y, z);
  };
  for (let t = 0; t < nt; t++) {
    let a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const len = (p: number, q: number) => Math.hypot(P[q] - P[p], P[q + 1] - P[p + 1], P[q + 2] - P[p + 2]);
    // the longest side is the base, c the corner across from it
    if (len(b, c) > len(a, b) && len(b, c) >= len(c, a)) [a, b, c] = [b, c, a];
    else if (len(c, a) > len(a, b)) [a, b, c] = [c, a, b];
    const base = len(a, b);
    _ab.set(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    _ac.set(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
    const height = base > 0 ? _n.crossVectors(_ab, _ac).length() / base : 0;
    const rows = Math.max(1, Math.ceil(height / SURFACE_STEP));
    for (let r = 0; r <= rows; r++) {
      // row r runs between the two sides from c, a fraction s of the way down to the base
      const s = r / rows;
      const ux = P[c] + (P[a] - P[c]) * s, uy = P[c + 1] + (P[a + 1] - P[c + 1]) * s, uz = P[c + 2] + (P[a + 2] - P[c + 2]) * s;
      const vx = P[c] + (P[b] - P[c]) * s, vy = P[c + 1] + (P[b + 1] - P[c + 1]) * s, vz = P[c + 2] + (P[b + 2] - P[c + 2]) * s;
      const n = Math.max(1, Math.ceil((base * s) / SURFACE_STEP));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        put(ux + (vx - ux) * f, uy + (vy - uy) * f, uz + (vz - uz) * f);
      }
    }
  }
  return Float32Array.from([...corners, ...out, ...even]);
}

const NAME: Record<string, SkinPart> = { thumb: 'thumb', index: 'index', middle: 'middle', ring: 'ring', pinky: 'little', little: 'little' };
const _v = new Vector3();
const _q = new Vector3();
const _n = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _m = new Matrix4();
const _A = new Vector3();
const _B = new Vector3();
const _C = new Vector3();
const _at = new Vector3();
const _sum = new Vector3();
const NOT_KNOWN = -Infinity;

/** Whether a matrix's 16 elements equal those stored at `at` in `b`. */
function sameMatrix(a: ArrayLike<number>, b: ArrayLike<number>, at: number): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[at + i]) return false;
  return true;
}

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
  /**
   * Skinning, done here rather than by three.js's getVertexPosition (the same sums in the same order, so the same numbers, without
   * the per-vertex matrix products): each vertex's rest position in bind space, its four bones and weights, and for each mesh each
   * bone's world matrix times its inverse bind matrix, for the pose last placed.
   */
  private readonly bindPos: Float64Array;
  private readonly skinBone: Uint16Array;
  private readonly skinW: Float64Array;
  private readonly boneMats: Float64Array[];
  /**
   * Bumped whenever place() moves anything: each bone and each mesh keeps the version it last moved at, so a piece whose bones
   * have not moved since it was posed (another finger was turned, or the same pose was placed again) is not posed or refitted again.
   */
  private version = 0;
  private readonly boneVersion: Uint32Array[];
  private readonly meshVersion: Uint32Array;
  /** The pose version the whole skin's tree was last refitted at (-1: never). */
  private wholeAt = -1;
  private readonly whole: { geo: BufferGeometry; bvh: MeshBVH | null; loops: Uint32Array[] };
  /** Winding answers for the held thing's points where the hand is now. */
  private readonly inside = new Map<number, boolean>();
  private readonly grid: PointGrid;
  /** Each skin point where it was last measured against the held thing, and its distance from it then (-Infinity: never). */
  private readonly refPos: Float32Array;
  private readonly refDist: Float64Array;
  /** Distance queries, winding numbers and piece measures made, for timing checks. */
  queries = 0;
  windings = 0;
  evals = 0;
  probes = 0;

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
    this.bindPos = new Float64Array(total * 3);
    this.skinBone = new Uint16Array(total * 4);
    this.skinW = new Float64Array(total * 4);
    this.boneMats = hand.meshes.map((m) => new Float64Array(16 * m.skeleton.bones.length));
    this.boneVersion = hand.meshes.map((m) => new Uint32Array(m.skeleton.bones.length));
    this.meshVersion = new Uint32Array(hand.meshes.length);
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
      const position = g.getAttribute('position');
      for (let i = 0; i < n; i++) {
        let best = 0, w = -1;
        for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > w) ((w = sw.getComponent(i, k)), (best = si.getComponent(i, k)));
        const id = base + i;
        _v.fromBufferAttribute(position, i).applyMatrix4(mesh.bindMatrix);
        this.bindPos[id * 3] = _v.x;
        this.bindPos[id * 3 + 1] = _v.y;
        this.bindPos[id * 3 + 2] = _v.z;
        for (let k = 0; k < 4; k++) {
          this.skinBone[id * 4 + k] = si.getComponent(i, k);
          this.skinW[id * 4 + k] = sw.getComponent(i, k);
        }
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
      const deps = new Set<number>();
      for (const v of list) for (let k = 0; k < 4; k++) if (this.skinW[v * 4 + k] !== 0) deps.add(this.vMesh[v] * BONE_KEY + this.skinBone[v * 4 + k]);
      return {
        verts: list,
        triLink: Uint8Array.from(pieceTriLink[p].length ? pieceTriLink[p] : [0]),
        geo,
        bvh: null as unknown as MeshBVH,
        links,
        deepest,
        deps: Uint32Array.from(deps),
        posedAt: -1,
        fitAt: -1,
        ref: null,
        drift: 0,
        bound: new Float64Array(0),
      };
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
    for (let p = 0; p < this.pieces.length; p++) this.posePiece(p);
    this.whole = this.closeSkin();
    const P = object.positions;
    this.objPts = edgePoints(P, object.index, object.flip, object.watertight);
    this.objMin = new Vector3(Infinity, Infinity, Infinity);
    this.objMax = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < P.length; i += 3) {
      this.objMin.min(_v.set(P[i], P[i + 1], P[i + 2]));
      this.objMax.max(_v);
    }
    this.grid = pointGrid(this.objPts, this.objMin, this.objMax);
    for (const piece of this.pieces) piece.bound = new Float64Array(this.objPts.length / 3).fill(NOT_KNOWN);
    this.refPos = new Float32Array(total * 3);
    this.refDist = new Float64Array(total).fill(NOT_KNOWN);
  }

  /** The held thing's points that may lie in a box, in ascending order (the order they are always looked at in). */
  private objNear(min: Vector3, max: Vector3): Int32Array {
    const g = this.grid;
    if (max.x < g.lo.x || max.y < g.lo.y || max.z < g.lo.z) return g.scratch.subarray(0, 0);
    if (min.x > g.lo.x + g.nx * g.cell || min.y > g.lo.y + g.ny * g.cell || min.z > g.lo.z + g.nz * g.cell) return g.scratch.subarray(0, 0);
    const at = (v: number, o: number, k: number) => Math.min(k - 1, Math.max(0, Math.floor((v - o) / g.cell)));
    const x0 = at(min.x, g.lo.x, g.nx), x1 = at(max.x, g.lo.x, g.nx);
    const y0 = at(min.y, g.lo.y, g.ny), y1 = at(max.y, g.lo.y, g.ny);
    const z0 = at(min.z, g.lo.z, g.nz), z1 = at(max.z, g.lo.z, g.nz);
    let count = 0;
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const row = (z * g.ny + y) * g.nx;
        count += g.start[row + x1 + 1] - g.start[row + x0];
      }
    // most of the held thing: going through all of it in order is quicker than sorting
    if (count > g.all.length / 4) return g.all;
    let k = 0;
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const row = (z * g.ny + y) * g.nx;
        for (let i = g.start[row + x0], end = g.start[row + x1 + 1]; i < end; i++) g.scratch[k++] = g.items[i];
      }
    return g.scratch.subarray(0, k).sort();
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
    this.hand.meshes.forEach((m, i) => {
      if (!sameMatrix(_m.multiplyMatrices(toObject, m.matrixWorld).elements, this.meshMats[i].elements, 0)) {
        this.meshMats[i].copy(_m);
        this.meshVersion[i] = ++this.version;
      }
      const bones = m.skeleton.bones, inverses = m.skeleton.boneInverses, A = this.boneMats[i], at = this.boneVersion[i];
      for (let b = 0; b < bones.length; b++) {
        const e = _m.multiplyMatrices(bones[b].matrixWorld, inverses[b]).elements;
        if (sameMatrix(e, A, b * 16)) continue;
        A.set(e, b * 16);
        at[b] = ++this.version;
      }
    });
    this.wristSide = wrist.determinant() < 0 ? -1 : 1;
  }

  /** Whether any bone that moves the piece, or the mesh it is in, has moved since pose version `since`. */
  private movedSince(piece: Piece, since: number): boolean {
    if (since < 0) return true;
    if (since === this.version) return false;
    for (let i = 0; i < piece.deps.length; i++) {
      const mi = Math.floor(piece.deps[i] / BONE_KEY);
      if (this.boneVersion[mi][piece.deps[i] % BONE_KEY] > since || this.meshVersion[mi] > since) return true;
    }
    return false;
  }

  /** Poses one piece's vertices where the hand is placed now (nothing to do when its bones have not moved since). */
  private posePiece(p: number) {
    const piece = this.pieces[p];
    if (!this.movedSince(piece, piece.posedAt)) return;
    this.pose(piece.verts);
    piece.posedAt = this.version;
  }

  /**
   * Whether a point is inside the whole skin, by the whole skin's nearest triangle with its holes capped: a piece alone is open where
   * it joins the next, and a hand cut from an arm is open at the wrist, so a point seen through an opening could read "inside".
   */
  private insideSkin(q: Vector3, key: number): boolean {
    const w = this.whole;
    if (this.wholeAt !== this.version) {
      for (let p = 0; p < this.pieces.length; p++) this.posePiece(p);
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
      this.wholeAt = this.version;
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

  /**
   * Poses vertices into P: three.js's SkinnedMesh.getVertexPosition followed by the mesh's place, written out (each bone's matrix
   * made once per place() rather than once per vertex and weight), with every sum in the same order so the numbers are the same.
   */
  private pose(ids: Uint32Array) {
    const P = this.P, B = this.bindPos, SI = this.skinBone, SW = this.skinW;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const mi = this.vMesh[id];
      const A = this.boneMats[mi];
      const bx = B[id * 3], by = B[id * 3 + 1], bz = B[id * 3 + 2];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) {
        const weight = SW[id * 4 + k];
        if (weight === 0) continue;
        const o = SI[id * 4 + k] * 16;
        const s = 1 / (A[o + 3] * bx + A[o + 7] * by + A[o + 11] * bz + A[o + 15]);
        x += (A[o] * bx + A[o + 4] * by + A[o + 8] * bz + A[o + 12]) * s * weight;
        y += (A[o + 1] * bx + A[o + 5] * by + A[o + 9] * bz + A[o + 13]) * s * weight;
        z += (A[o + 2] * bx + A[o + 6] * by + A[o + 10] * bz + A[o + 14]) * s * weight;
      }
      let e = this.hand.meshes[mi].bindMatrixInverse.elements;
      let s = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      const ux = (e[0] * x + e[4] * y + e[8] * z + e[12]) * s;
      const uy = (e[1] * x + e[5] * y + e[9] * z + e[13]) * s;
      const uz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * s;
      e = this.meshMats[mi].elements;
      s = 1 / (e[3] * ux + e[7] * uy + e[11] * uz + e[15]);
      P[id * 3] = (e[0] * ux + e[4] * uy + e[8] * uz + e[12]) * s;
      P[id * 3 + 1] = (e[1] * ux + e[5] * uy + e[9] * uz + e[13]) * s;
      P[id * 3 + 2] = (e[2] * ux + e[6] * uy + e[10] * uz + e[14]) * s;
    }
  }

  private refit(piece: Piece) {
    if (!this.movedSince(piece, piece.fitAt)) return;
    this.posePiece(this.pieces.indexOf(piece));
    piece.fitAt = this.version;
    const a = piece.geo.getAttribute('position') as BufferAttribute;
    const arr = a.array as Float32Array;
    for (let i = 0; i < piece.verts.length; i++) {
      const id = piece.verts[i];
      arr[i * 3] = this.P[id * 3];
      arr[i * 3 + 1] = this.P[id * 3 + 1];
      arr[i * 3 + 2] = this.P[id * 3 + 2];
    }
    a.needsUpdate = true;
    if (!piece.bvh) piece.bvh = this.firstTree(piece);
    else piece.bvh.refit();
    // how far the skin has moved since the bounds were taken; past half the margin they are taken again
    const ref = piece.ref;
    if (!ref) {
      piece.ref = Float32Array.from(arr);
      piece.drift = 0;
      return;
    }
    let worst = 0;
    for (let i = 0; i < arr.length; i += 3) {
      const dx = arr[i] - ref[i], dy = arr[i + 1] - ref[i + 1], dz = arr[i + 2] - ref[i + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d > worst) worst = d;
    }
    piece.drift = Math.sqrt(worst);
    if (piece.drift > PROBE / 2) {
      ref.set(arr);
      piece.drift = 0;
      piece.bound.fill(NOT_KNOWN);
    }
  }

  /**
   * A piece's first tree. Building it sorts the piece's triangles, so which link each triangle belongs to is sorted the same way,
   * found again by its three corners.
   */
  private firstTree(piece: Piece): MeshBVH {
    const index = piece.geo.index!.array;
    const was = new Map<string, number>();
    const key = (t: number) => {
      const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
      return `${a},${b},${c}`;
    };
    for (let t = 0; t < index.length / 3; t++) was.set(key(t), piece.triLink[t]);
    const bvh = new MeshBVH(piece.geo);
    const sorted = piece.geo.index!.array;
    const link = new Uint8Array(sorted.length / 3);
    for (let t = 0; t < link.length; t++) link[t] = was.get(key(t)) ?? 0;
    piece.triLink = link;
    return bvh;
  }

  /**
   * Which side of a piece's skin a point is on, from its nearest triangle: negative inside (by the depth), positive outside,
   * 0 when it cannot tell (the nearest point is on an edge the point lies beside, as past a piece's open end).
   */
  private side(piece: { geo: BufferGeometry; bvh: MeshBVH }, q: Vector3, within: number): number {
    const h = piece.bvh.closestPointToPoint(q, _hit, 0, within);
    return h ? this.sideOf(piece, q, h) : 0;
  }

  /** The same, from the nearest point already found. */
  private sideOf(piece: { geo: BufferGeometry; bvh: MeshBVH }, q: Vector3, h: { point: Vector3; distance: number; faceIndex: number }): number {
    if (h.distance < 1e-7) return 0;
    const pos = piece.geo.getAttribute('position').array as Float32Array;
    const idx = piece.geo.index!.array as Uint32Array;
    const a = idx[h.faceIndex * 3] * 3, b = idx[h.faceIndex * 3 + 1] * 3, c = idx[h.faceIndex * 3 + 2] * 3;
    _ab.set(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    _ac.set(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]);
    _n.crossVectors(_ab, _ac).normalize();
    // on an edge or a corner the one triangle the tree found cannot say which side is out (another tree finds another): every face
    // meeting there says, by the angle it takes up round the point
    _A.set(pos[a], pos[a + 1], pos[a + 2]);
    _B.set(pos[b], pos[b + 1], pos[b + 2]);
    _C.set(pos[c], pos[c + 1], pos[c + 2]);
    _at.copy(h.point);
    if (onTriangleEdge(_at, _A, _B, _C) && facesAround(piece.bvh, _at, _sum)) _n.copy(_sum).normalize();
    _q.copy(q).sub(h.point).divideScalar(h.distance);
    const cos = _q.dot(_n) * (this.skinSide ?? 1) * this.wristSide;
    if (Math.abs(cos) < 0.3) return 0;
    return cos < 0 ? -h.distance : h.distance;
  }

  /**
   * Measures one piece where the hand is now placed, from segment `fromLink` out. With `only`, just that segment; points no deeper
   * than `floor` are not looked at closely, and once one is found deeper than `stop` the measure ends there (enough for a yes or no).
   * The gap is exact up to `gap` (metres); beyond that it is only known to be further.
   *
   * Most of the hand is about as far from the held thing as last time, give or take how far it has moved since, so a point is only
   * measured again when that could change the answer (a distance changes no faster than the point moves): a skin point that was
   * outside by more than it has moved since is still outside (on a closed held thing, whose inside and outside meet only at its
   * surface), and a point of the held thing further than `REACH` from the skin by more than the skin has moved is still out of reach.
   */
  private evalPiece(p: number, fromLink = 0, look: { only?: number; floor?: number; stop?: number; gap?: number } = {}): PieceEval {
    const only = look.only ?? -1, floor = look.floor ?? 0, stop = look.stop ?? Infinity;
    const collect = only < 0 && stop === Infinity;
    const piece = this.pieces[p];
    this.evals++;
    const out: PieceEval = { link: new Float64Array(piece.links), gap: Infinity, violations: [] };
    this.refit(piece);
    const P = this.P, RP = this.refPos, RD = this.refDist;
    const lo = this.objMin, hi = this.objMax, m = 0.002;
    const cache = this.object.watertight;
    // a skin point surely further out than this needs no measuring: it is neither in the part nor setting a gap that is wanted
    const need = Math.max(0, look.gap ?? 0) + 1e-6;
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
      if (cache && RD[id] > need) {
        const lower = RD[id] - Math.hypot(x - RP[id * 3], y - RP[id * 3 + 1], z - RP[id * 3 + 2]);
        if (lower > need) {
          if (lower < out.gap) out.gap = lower;
          continue;
        }
      }
      this.queries++;
      const d = this.object.distance(x, y, z);
      if (cache) {
        RP[id * 3] = x;
        RP[id * 3 + 1] = y;
        RP[id * 3 + 2] = z;
        RD[id] = d;
      }
      if (d < out.gap) out.gap = d;
      if (d < 0) {
        if (-d > out.link[k]) out.link[k] = -d;
        if (collect) out.violations.push({ depth: -d, piece: p, link: k, out: this.object.lastNormal.clone() });
        if (-d > stop) return out;
      }
    }
    // points of the held thing inside the skin: a thin edge between skin points (none can count when none is looked at closely)
    if (floor === Infinity) return out;
    min.subScalar(REACH);
    max.addScalar(REACH);
    const O = this.objPts;
    const found = this.objNear(min, max);
    const bound = piece.bound, drift = piece.drift;
    for (let c = 0; c < found.length; c++) {
      const j = found[c], i = j * 3;
      const x = O[i], y = O[i + 1], z = O[i + 2];
      if (x < min.x || y < min.y || z < min.z || x > max.x || y > max.y || z > max.z) continue;
      if (bound[j] - drift > REACH + 1e-7) continue;
      // looked for a little further than needed, so the answer says how long the point can be left alone
      const h = piece.bvh.closestPointToPoint(_q.set(x, y, z), _hit, 0, REACH + PROBE);
      this.probes++;
      bound[j] = (h && h.distance < REACH + PROBE ? h.distance : REACH + PROBE) - drift;
      if (!h || h.distance > REACH) continue;
      const s = this.sideOf(piece, _q, h);
      if (s >= 0 || -s <= floor) continue;
      const k = piece.triLink[h.faceIndex] ?? 0;
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
      const e = this.evalPiece(p, 0, { gap: GAP_EXACT });
      const part = this.partOf(p);
      depth[part] = Math.max(depth[part], ...e.link);
      gap[part] = Math.min(gap[part], e.gap);
    }
    return { depth, worst: Math.max(...Object.values(depth)), gap };
  }

  /**
   * Where the drawn skin touches the held thing with the hand at `wrist`: on each finger segment and the palm, the skin point nearest the part, if it is within
   * `within` of it (metres). These are the hand's real contacts, where the solver's are its collision spheres', which sit inside the skin and stop being
   * where the fingers are once the hand has been moved out of the part.
   */
  contacts(wrist: Matrix4, angles: Float32Array, within = 0.002): Contact[] {
    this.place(wrist, angles);
    const palm = this.hand.model.fingers.length;
    const lo = this.objMin, hi = this.objMax, m = within + 0.001;
    const best = new Map<number, { d: number; id: number }>();
    for (let p = 0; p < this.pieces.length; p++) {
      const piece = this.pieces[p];
      this.refit(piece);
      for (let i = 0; i < piece.verts.length; i++) {
        const id = piece.verts[i];
        if (this.pieceOf(id) !== p) continue;
        const x = this.P[id * 3], y = this.P[id * 3 + 1], z = this.P[id * 3 + 2];
        if (x < lo.x - m || y < lo.y - m || z < lo.z - m || x > hi.x + m || y > hi.y + m || z > hi.z + m) continue;
        const d = this.object.distance(x, y, z);
        if (d > within) continue;
        const key = p * 8 + (p === palm ? 0 : this.vLink[id]);
        const was = best.get(key);
        if (!was || d < was.d) best.set(key, { d, id });
      }
    }
    const out: Contact[] = [];
    for (const [key, { id }] of best) {
      const p = Math.floor(key / 8);
      this.object.distance(this.P[id * 3], this.P[id * 3 + 1], this.P[id * 3 + 2]);
      out.push({ point: this.object.lastPoint.clone(), normal: this.object.lastNormal.clone(), finger: p === palm ? -1 : p, link: key % 8 });
    }
    return out;
  }

  /** Takes the hand out of the held thing (see the class comment). */
  clear(wrist0: Matrix4, angles0: Float32Array, options: GuardOptions = {}): GuardResult {
    const model = this.hand.model;
    const tol = options.tol ?? 0.001;
    const contact = options.contact ?? 0.002;
    const keep = new Set(options.keep ?? []);
    // the least move out is found within a third of the hand's size first; only a grip still in after that may go out as far as half of it
    const reaches = options.maxMove !== undefined ? [options.maxMove] : [0.3 * model.size, 0.5 * model.size];
    let maxMove = reaches[0];
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
    for (let tries = 0; tries < 4 * reaches.length && best.left.length; tries++) {
      maxMove = reaches[Math.floor(tries / 4)];
      // twice from the grip's own fingers, then from open fingers
      const from = tries % 4 < 2 ? angles0 : opened;
      const room = maxMove - moved;
      if (room <= 0) break;
      // two ways out: against what is in (the faces it is in say which way is out), and back off the palm; the shorter one wins
      const ways: Vector3[] = [];
      const pushed = new Vector3();
      for (const v of best.left) pushed.addScaledVector(v.out, v.depth);
      if (pushed.lengthSq() > 1e-12) ways.push(pushed.normalize());
      const back = model.frame.normal.clone().transformDirection(wrist).negate();
      if (!ways.length || ways[0].dot(back) < 0.98) ways.push(back);
      type Found = ReturnType<typeof search> & { way: Vector3 };
      let pick: Found | null = null as Found | null;
      const tryWays = (list: Vector3[]) => {
        for (const way of list) {
          const r = search(way, from, room);
          const better = !pick || (r.out && (!pick.out || r.t < pick.t)) || (!r.out && !pick.out && r.result.sum < pick.result.sum);
          if (better) pick = { ...r, way };
        }
      };
      tryWays(ways);
      // a finger caught round a block may come free only sideways or along the hand: the hand's own four other ways, when neither of those freed it
      if (!pick?.out) {
        const side = model.frame.side.clone().transformDirection(wrist), up = model.frame.up.clone().transformDirection(wrist);
        tryWays([side, side.clone().negate(), up, up.clone().negate()]);
      }
      const chosen = pick as Found;
      if (chosen.out || chosen.t > 0) {
        // not out along either way: go where the least was left in, and look again from there
        wrist = shifted(wrist, chosen.way, chosen.t);
        moved += chosen.t;
        best = chosen.result;
      } else if (tries % 4 >= 1) tries = 4 * Math.floor(tries / 4) + 3;
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
          // open, the two ends, then between: a thumb round a block may clear only part way through its range
          const between = [1, 2, 3, 4, 5].map((i) => dof.min + ((dof.max - dof.min) * i) / 6);
          const targets = [Math.max(dof.min, Math.min(dof.max, dof.open ?? 0)), dof.min, dof.max, ...between.sort((x, y) => Math.abs(x - a0) - Math.abs(y - a0))].filter((t, i, all) => Math.abs(t - a0) > 1e-4 && all.indexOf(t) === i);
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
    const near = { floor: Infinity, gap: contact };
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
