import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { bucketTrianglesByLevel, levelLoops } from '../contours';
import {
  type TriMesh,
  buildGraph,
  connectedComponents,
  dijkstra,
  extractComponent,
  weldMesh,
} from '../trimesh';
import { type FingerSpec, type HandSpec, buildHandModel } from './build';
import type { HandModel } from './model';

export interface AnalyzeOptions {
  /** Put the palm on the other side when the automatic guess is wrong. */
  flipPalm?: boolean;
  /** Fingertip positions picked by hand; replaces automatic fingertip detection. */
  tipHints?: [number, number, number][];
  /**
   * Joint positions corrected by hand, by finger name ("thumb", "index"...),
   * base joint first. Fingers not listed keep their automatic joints.
   */
  joints?: Record<string, [number, number, number][]>;
  /** Manual correction of the thumb's bending direction, in radians about the thumb's length. */
  thumbTurn?: number;
}

export interface HandAnalysis {
  spec: HandSpec;
  model: HandModel;
  /** Four bone indices and weights per input vertex. Bone i is model.joints[i]. */
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
  warnings: string[];
  /** 0..1: how sure the analysis is about which side is the palm. */
  palmConfidence: number;
  /** Cross-section rings found along each finger, for display. */
  rings: { center: Vector3; radius: number }[][];
  /** The joint (index into model.joints) that a point in or near the hand moves with; 0 is the palm. */
  jointAt(x: number, y: number, z: number): number;
}

// Proportions of a finger measured from the tip, as fractions of its full
// length (tip to knuckle). The visible finger ends at the web, which sits
// about three quarters of the way to the knuckle joint.
const FINGER_WEB_FRACTION = 0.76;
const FINGER_DIP = 0.255;
const FINGER_PIP = 0.53;
// Thumb joints as fractions of its traced length (tip to where it meets the palm).
const THUMB_IP = 0.44;
const THUMB_MCP = 1.0;

interface Ring {
  level: number;
  centroid: Vector3;
  perimeter: number;
}

interface Tube {
  tip: number;
  field: Float32Array;
  rings: Ring[];
  /** Index of the first ring past the rounded tip, -1 if the shape never became a tube. */
  cap: number;
  end: 'split' | 'flare' | 'boundary' | 'max' | 'none';
  perimeter: number;
  radius: number;
  plateau: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const smoothstep = (a: number, b: number, x: number) => {
  if (b <= a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Walks level sets of the surface distance from a candidate fingertip.
 * On a finger they are rings of nearly constant size; the walk stops where
 * the ring flares or splits, which is where the finger joins the palm.
 */
function traceTube(
  mesh: TriMesh,
  field: Float32Array,
  tip: number,
  delta: number,
  maxLevels: number,
  capLimit: number,
): Tube {
  const buckets = bucketTrianglesByLevel(mesh, field, delta, maxLevels);
  const rings: Ring[] = [];
  let cap = -1;
  let end: Tube['end'] = 'max';
  const unit = 2 * Math.PI * delta;
  for (let k = 1; k <= maxLevels; k++) {
    const loops = levelLoops(mesh, field, k * delta, buckets[k]);
    if (!loops.length) {
      end = 'none';
      break;
    }
    let main: (typeof loops)[number] | null = null;
    let second = 0;
    let openLen = 0;
    for (const l of loops) {
      if (!l.closed) {
        openLen += l.length;
        continue;
      }
      if (!main || l.length > main.length) {
        if (main) second = Math.max(second, main.length);
        main = l;
      } else second = Math.max(second, l.length);
    }
    if (!main || openLen > 0.25 * main.length) {
      end = 'boundary';
      break;
    }
    const P = main.length;
    const ring: Ring = { level: k * delta, centroid: new Vector3(...main.centroid), perimeter: P };
    if (cap < 0) {
      if (second > 0.5 * P) {
        end = 'split';
        break;
      }
      rings.push(ring);
      const m = rings.length;
      if (m >= 4) {
        const growth = (P - rings[m - 4].perimeter) / (3 * unit);
        if (growth < 0.35) cap = m - 1;
      }
      if (cap < 0 && m * delta > capLimit) {
        end = 'none';
        break;
      }
    } else {
      const m = rings.length;
      const all = median(rings.slice(cap).map((r) => r.perimeter));
      const lo = Math.max(cap, m - 7), hi = Math.max(lo + 1, m - 1);
      const recent = median(rings.slice(lo, hi).map((r) => r.perimeter));
      if (second > 0.3 * all) {
        end = 'split';
        break;
      }
      if (P > 1.28 * recent || P > 1.8 * all) {
        end = 'flare';
        break;
      }
      rings.push(ring);
    }
  }
  const perimeter = cap >= 0 ? median(rings.slice(cap).map((r) => r.perimeter)) : 0;
  return {
    tip,
    field,
    rings,
    cap,
    end,
    perimeter,
    radius: perimeter / (2 * Math.PI),
    plateau: cap >= 0 ? (rings.length - cap) * delta : 0,
  };
}

/** Geometry of one detected finger: its centreline and how to measure along it. */
class FingerGeom {
  readonly line: Vector3[] = [];
  readonly arcs: number[] = [];
  readonly ringArc: number[] = [];
  readonly endIdx: number;
  readonly endLevel: number;
  readonly sEnd: number;
  readonly apex: Vector3;
  readonly tBase: Vector3;
  readonly base: Vector3;
  /** Extension of the centreline into the palm, with arc lengths. */
  ext: Vector3[] = [];
  extArcs: number[] = [];
  /** Arc position of each joint, base first. */
  jointArcs: number[] = [];
  blend: number[] = [];
  baseRadius = 0;

  constructor(
    readonly tube: Tube,
    readonly delta: number,
    positions: Float32Array,
  ) {
    const { rings, cap, field } = tube;
    const trim = Math.min(2, Math.floor((rings.length - cap) / 6));
    this.endIdx = rings.length - 1 - trim;
    this.endLevel = rings[this.endIdx].level;
    const c0 = rings[cap].centroid;
    const c1 = rings[Math.min(cap + 4, this.endIdx)].centroid;
    const distal = c0.clone().sub(c1).normalize();
    let ext = 0;
    const capLevel = rings[cap].level;
    for (let v = 0; v < field.length; v++) {
      if (field[v] > capLevel) continue;
      const d =
        (positions[v * 3] - c0.x) * distal.x +
        (positions[v * 3 + 1] - c0.y) * distal.y +
        (positions[v * 3 + 2] - c0.z) * distal.z;
      if (d > ext) ext = d;
    }
    this.apex = c0.clone().addScaledVector(distal, ext);
    this.line.push(this.apex);
    this.arcs.push(0);
    for (let k = cap; k <= this.endIdx; k++) {
      const prev = this.line[this.line.length - 1];
      this.arcs.push(this.arcs[this.arcs.length - 1] + prev.distanceTo(rings[k].centroid));
      this.line.push(rings[k].centroid);
    }
    for (let k = 0; k <= this.endIdx; k++) {
      this.ringArc.push(k >= cap ? this.arcs[k - cap + 1] : (this.arcs[1] * (k + 1)) / (cap + 1));
    }
    this.sEnd = this.arcs[this.arcs.length - 1];
    this.base = this.line[this.line.length - 1];
    this.tBase = this.base.clone().sub(this.pointAtInner(0.6 * this.sEnd)).normalize();
  }

  private pointAtInner(s: number): Vector3 {
    const { arcs, line } = this;
    if (s <= 0) return line[0].clone();
    for (let i = 1; i < arcs.length; i++) {
      if (s <= arcs[i]) {
        const t = (s - arcs[i - 1]) / Math.max(1e-12, arcs[i] - arcs[i - 1]);
        return line[i - 1].clone().lerp(line[i], t);
      }
    }
    return line[line.length - 1].clone();
  }

  /** Point at arc length s from the tip; continues straight into the palm past the last ring. */
  pointAt(s: number): Vector3 {
    if (s <= this.sEnd) return this.pointAtInner(s);
    return this.base.clone().addScaledVector(this.tBase, s - this.sEnd);
  }

  /** Arc position of a surface vertex inside the finger, from its distance to the tip. */
  arcOfLevel(d: number): number {
    const kf = d / this.delta - 1;
    if (kf <= 0) return this.ringArc[0] * Math.max(0, d / this.delta);
    if (kf >= this.endIdx) return this.sEnd;
    const k = Math.floor(kf);
    return this.ringArc[k] + (this.ringArc[k + 1] - this.ringArc[k]) * (kf - k);
  }

  /** Median ring radius between two arc positions. */
  radiusBetween(s0: number, s1: number): number {
    const { rings, cap } = this.tube;
    const vals: number[] = [];
    for (let k = cap; k <= this.endIdx; k++) {
      const s = this.ringArc[k];
      if (s >= s0 && s <= s1) vals.push(rings[k].perimeter / (2 * Math.PI));
    }
    if (vals.length) return median(vals);
    // nearest ring
    let best = cap, bd = Infinity;
    const mid = (s0 + s1) / 2;
    for (let k = cap; k <= this.endIdx; k++) {
      const d = Math.abs(this.ringArc[k] - mid);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return rings[best].perimeter / (2 * Math.PI);
  }

  /**
   * Closest point on the finger's own centreline (tip to where it meets the palm).
   * `atBase` is true when the closest point is the very end of the line, i.e. the
   * point is really beyond the finger, in the palm.
   */
  projectOnLine(p: Vector3): { s: number; rho: number; atBase: boolean } {
    let best = Infinity, bs = 0, atBase = false;
    const { line, arcs } = this;
    const last = line.length - 1;
    for (let i = 1; i <= last; i++) {
      const a = line[i - 1], b = line[i];
      const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
      const rx = p.x - a.x, ry = p.y - a.y, rz = p.z - a.z;
      const len2 = sx * sx + sy * sy + sz * sz;
      let t = len2 > 0 ? (rx * sx + ry * sy + rz * sz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(rx - sx * t, ry - sy * t, rz - sz * t);
      if (d < best) {
        best = d;
        bs = arcs[i - 1] + (arcs[i] - arcs[i - 1]) * t;
        atBase = i === last && t >= 1;
      }
    }
    return { s: bs, rho: best, atBase };
  }

  /** Finger radius at an arc position. */
  radiusAt(s: number): number {
    const { rings, cap } = this.tube;
    let best = cap, bd = Infinity;
    for (let k = cap; k <= this.endIdx; k++) {
      const d = Math.abs(this.ringArc[k] - s);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return rings[best].perimeter / (2 * Math.PI);
  }

  /** Sphere around the whole centreline, for quick rejection. */
  bound(): { center: Vector3; radius: number } {
    const center = this.apex.clone().add(this.base).multiplyScalar(0.5);
    let radius = 0;
    for (const p of this.line) radius = Math.max(radius, p.distanceTo(center));
    return { center, radius };
  }

  /** Arc position of any point near the finger: along the finger itself, or straight on past its base. */
  arcOf(p: Vector3): number {
    const on = this.projectOnLine(p);
    return on.atBase ? this.sEnd + p.distanceTo(this.base) : on.s;
  }

  /** Closest point on the palm-side extension: arc position and distance from the axis. */
  projectOnExtension(p: Vector3): { s: number; rho: number } {
    let best = Infinity, bs = this.sEnd;
    const seg = new Vector3(), rel = new Vector3();
    for (let i = 1; i < this.ext.length; i++) {
      seg.subVectors(this.ext[i], this.ext[i - 1]);
      const len2 = seg.lengthSq();
      rel.subVectors(p, this.ext[i - 1]);
      const t = len2 > 0 ? Math.min(1, Math.max(0, rel.dot(seg) / len2)) : 0;
      const d = rel.addScaledVector(seg, -t).length();
      if (d < best) {
        best = d;
        bs = this.extArcs[i - 1] + (this.extArcs[i] - this.extArcs[i - 1]) * t;
      }
    }
    return { s: bs, rho: best };
  }

  /**
   * Bone weights at arc position s. Returns one weight per joint (base first)
   * followed by the weight of the palm.
   */
  chainWeights(s: number, out: number[]): number[] {
    const n = this.jointArcs.length;
    let carry = 1;
    for (let k = n - 1; k >= 0; k--) {
      const t = smoothstep(this.jointArcs[k] - this.blend[k], this.jointArcs[k] + this.blend[k], s);
      out[k] = carry * (1 - t);
      carry *= t;
    }
    out[n] = carry;
    return out;
  }
}

/**
 * Finds the fingers, joints, thickness and palm of a bare hand mesh and
 * produces a rig for it. The mesh can be in any orientation and scale.
 */
export function analyzeHandMesh(input: TriMesh, options: AnalyzeOptions = {}): HandAnalysis {
  const warnings: string[] = [];
  const welded = weldMesh(input);
  const comps = connectedComponents(welded.mesh);
  if (!comps.sizes.length) throw new Error('This mesh has no triangles.');
  let mainLabel = 0;
  for (let i = 1; i < comps.sizes.length; i++) if (comps.sizes[i] > comps.sizes[mainLabel]) mainLabel = i;
  const main = extractComponent(welded.mesh, comps.labels, mainLabel);
  const mesh = main.mesh;
  const P = mesh.positions;
  const nV = P.length / 3;
  if (nV < 30) throw new Error('This mesh is too simple to analyse as a hand.');
  const graph = buildGraph(mesh);

  const argmax = (f: Float32Array) => {
    let b = -1, bv = -Infinity;
    for (let i = 0; i < f.length; i++)
      if (f[i] < Infinity && f[i] > bv) {
        bv = f[i];
        b = i;
      }
    return b;
  };

  // --- 1. extremities: points furthest (along the surface) from each other
  const fields: Float32Array[] = [];
  const extrema: number[] = [];
  let scale = 0;
  if (options.tipHints?.length) {
    for (const h of options.tipHints) {
      let best = 0, bd = Infinity;
      for (let v = 0; v < nV; v++) {
        const d = Math.hypot(P[v * 3] - h[0], P[v * 3 + 1] - h[1], P[v * 3 + 2] - h[2]);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      extrema.push(best);
      fields.push(dijkstra(graph, [best]));
    }
    for (const f of fields) scale = Math.max(scale, f[argmax(f)]);
  } else {
    let e = argmax(dijkstra(graph, [0]));
    const minD = new Float32Array(nV).fill(Infinity);
    for (let it = 0; it < 20 && e >= 0; it++) {
      const d = dijkstra(graph, [e]);
      if (it === 0) scale = d[argmax(d)];
      fields.push(d);
      extrema.push(e);
      for (let v = 0; v < nV; v++) if (d[v] < minD[v]) minD[v] = d[v];
      e = argmax(minD);
      if (e < 0 || minD[e] < 0.15 * scale) break;
    }
  }
  if (!(scale > 0)) throw new Error('Could not measure this mesh.');

  // --- 2. which extremities are tubes (fingers, or a forearm)
  const delta = scale / 120;
  const maxLevels = 90;
  const tubes = extrema.map((e, i) => traceTube(mesh, fields[i], e, delta, maxLevels, 0.16 * scale));
  const hinted = !!options.tipHints?.length;
  let cands = tubes.filter((t) => t.cap >= 0 && t.rings.length - t.cap >= 4 && (hinted || t.plateau >= 2 * t.radius));
  let arm: Tube | null = null;
  if (!hinted && cands.length >= 3) {
    // a forearm is also a tube, but much thicker than the fingers
    const medR = median(cands.map((t) => t.radius));
    const arms = cands.filter((t) => t.radius > 1.7 * medR);
    if (arms.length && cands.length - arms.length >= 2) {
      arm = arms.sort((a, b) => b.plateau - a.plateau)[0];
      cands = cands.filter((t) => !arms.includes(t));
    }
  }
  // A hollow mesh (a glove with an inside, a double-walled scan) shows every
  // finger twice, once per wall: keep the outer one.
  cands = cands.filter(
    (t, ti) =>
      !cands.some((o, oi) => {
        if (o === t) return false;
        const near = o.rings[o.cap].centroid.distanceTo(t.rings[t.cap].centroid) < Math.max(o.radius, t.radius);
        return near && (o.perimeter > t.perimeter || (o.perimeter === t.perimeter && oi < ti));
      }),
  );
  // up to six digits: generated hands sometimes have an extra finger
  if (cands.length > 6) cands = [...cands].sort((a, b) => b.plateau - a.plateau).slice(0, 6);
  if (cands.length < 2) {
    throw new Error(
      'Could not find separate fingers on this mesh. It works best on a single open hand with the fingers apart.',
    );
  }
  const geoms = cands.map((t) => new FingerGeom(t, delta, P));

  // --- 3. thumb: its base sits far from the row of finger bases
  let thumb = -1;
  if (geoms.length >= 3) {
    const nn = geoms.map((g, i) => {
      let m = Infinity;
      geoms.forEach((h, j) => {
        if (i !== j) m = Math.min(m, g.base.distanceTo(h.base));
      });
      return m;
    });
    let best = 0;
    for (let i = 1; i < nn.length; i++) if (nn[i] > nn[best]) best = i;
    const others = median(nn.filter((_, i) => i !== best));
    if (nn[best] > 1.5 * others) thumb = best;
    if (thumb < 0) {
      // Second opinion, measured along the skin: neighbouring fingers meet at
      // the web just past their bases, while the thumb is a long way round.
      const gap = geoms.map((g, i) => {
        let m = Infinity;
        geoms.forEach((h, j) => {
          if (i === j) return;
          const d = cands[i].field[cands[j].tip] - g.endLevel - h.endLevel;
          if (d < m) m = d;
        });
        return m;
      });
      let far = 0;
      for (let i = 1; i < gap.length; i++) if (gap[i] > gap[far]) far = i;
      const second = Math.max(...gap.filter((_, i) => i !== far));
      const medR = median(geoms.map((g) => g.tube.radius));
      if (gap[far] > 3 * medR && gap[far] > 2 * Math.max(second, medR)) thumb = far;
    }
  }
  if (thumb < 0) warnings.push('No thumb was recognised, so left/right could not be determined.');
  const fingerIdx = geoms.map((_, i) => i).filter((i) => i !== thumb);
  if (!hinted && fingerIdx.length >= 2) {
    // Fingers sit side by side. If the "fingers" found are many widths apart
    // they are really limbs: this is a body, not a hand.
    let worst = 0;
    for (const i of fingerIdx) {
      let nn = Infinity;
      for (const j of fingerIdx) {
        if (i === j) continue;
        nn = Math.min(nn, geoms[i].base.distanceTo(geoms[j].base) / Math.min(geoms[i].tube.radius, geoms[j].tube.radius));
      }
      worst = Math.max(worst, nn);
    }
    // Fingers never point in opposite directions; the arms of a T-pose do.
    let minDot = 1;
    for (const i of fingerIdx)
      for (const j of fingerIdx) if (i < j) minDot = Math.min(minDot, geoms[i].tBase.dot(geoms[j].tBase));
    // A finger is about as thick at the tip as further down. A leg ends in a
    // foot and an arm in a hand, both much bigger round than the limb behind them.
    let bulging = 0;
    for (const g of geoms) {
      let lo = Infinity, hi = 0;
      for (let k = g.tube.cap; k <= g.endIdx; k++) {
        const p = g.tube.rings[k].perimeter;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      if (hi > 1.7 * lo) bulging++;
    }
    // Fingers are all about the same thickness; arms and legs are not.
    let thin = Infinity, thick = 0;
    for (const i of fingerIdx) {
      thin = Math.min(thin, geoms[i].tube.radius);
      thick = Math.max(thick, geoms[i].tube.radius);
    }
    if (worst > 5 || minDot < -0.3 || bulging >= 2 || thick > 1.8 * thin) {
      throw new Error('This does not look like a single hand: the parts that stick out are not arranged like fingers.');
    }
  }

  // --- 4. wrist end of the mesh
  const E = new Vector3();
  if (arm && arm.rings.length) {
    E.copy(arm.rings[arm.rings.length - 1].centroid);
  } else {
    const g = new Float32Array(nV);
    let gmax = -Infinity, gmin = Infinity;
    for (let v = 0; v < nV; v++) {
      let s = 0;
      for (const t of cands) s += t.field[v];
      g[v] = s;
      if (s < Infinity) {
        if (s > gmax) gmax = s;
        if (s < gmin) gmin = s;
      }
    }
    const cut = gmax - 0.1 * (gmax - gmin);
    let cnt = 0;
    for (let v = 0; v < nV; v++) {
      if (!(g[v] >= cut) || g[v] === Infinity) continue;
      E.x += P[v * 3];
      E.y += P[v * 3 + 1];
      E.z += P[v * 3 + 2];
      cnt++;
    }
    E.multiplyScalar(1 / Math.max(1, cnt));

    // On a hollow mesh the furthest surface from the fingertips is the inside
    // of those same fingers. If the "far end" came out on the finger side of
    // the knuckles, use the end of the mesh pointing away from the fingers instead.
    const D = new Vector3(), Kb = new Vector3();
    for (const i of fingerIdx) {
      D.add(geoms[i].apex).sub(geoms[i].base);
      Kb.add(geoms[i].base);
    }
    D.normalize();
    Kb.multiplyScalar(1 / fingerIdx.length);
    if (E.clone().sub(Kb).dot(D) > 0) {
      let lo = Infinity, hi = -Infinity;
      for (let v = 0; v < nV; v++) {
        const d = P[v * 3] * D.x + P[v * 3 + 1] * D.y + P[v * 3 + 2] * D.z;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      const slab = lo + 0.06 * (hi - lo);
      E.set(0, 0, 0);
      cnt = 0;
      for (let v = 0; v < nV; v++) {
        const d = P[v * 3] * D.x + P[v * 3 + 1] * D.y + P[v * 3 + 2] * D.z;
        if (d > slab) continue;
        E.x += P[v * 3];
        E.y += P[v * 3 + 1];
        E.z += P[v * 3 + 2];
        cnt++;
      }
      E.multiplyScalar(1 / Math.max(1, cnt));
    }
  }

  // --- 5. knuckles and the palm frame
  const fullLen = geoms.map((g) => g.sEnd / FINGER_WEB_FRACTION);
  const mcp = geoms.map((g, i) => g.pointAt(fullLen[i]));
  const K = new Vector3();
  for (const i of fingerIdx) K.add(mcp[i]);
  K.multiplyScalar(1 / fingerIdx.length);
  if (arm && arm.rings.length) {
    // with a forearm attached, the wrist is the forearm cross-section about
    // one palm length below the knuckles
    let longest = 0;
    for (const i of fingerIdx) longest = Math.max(longest, fullLen[i]);
    let bd = Infinity;
    for (const r of arm.rings) {
      const d = Math.abs(r.centroid.distanceTo(K) - 0.88 * longest);
      if (d < bd) {
        bd = d;
        E.copy(r.centroid);
      }
    }
  }
  const U = K.clone().sub(E).normalize();

  const S0 = new Vector3();
  if (fingerIdx.length >= 2) {
    let bd = -1;
    for (const i of fingerIdx)
      for (const j of fingerIdx) {
        const d = mcp[i].distanceTo(mcp[j]);
        if (d > bd) {
          bd = d;
          S0.subVectors(mcp[i], mcp[j]);
        }
      }
  } else if (thumb >= 0) {
    S0.subVectors(geoms[thumb].base, K);
  }
  S0.addScaledVector(U, -S0.dot(U));
  if (S0.lengthSq() < 1e-16) throw new Error('Could not work out the orientation of this hand.');
  S0.normalize();
  if (thumb >= 0 && geoms[thumb].base.clone().sub(K).dot(S0) < 0) S0.negate();
  const N0 = new Vector3().crossVectors(S0, U).normalize();

  let curlCue = 0;
  for (const i of fingerIdx) {
    const g = geoms[i];
    const mid = g.pointAt(g.sEnd / 2);
    const chordMid = g.apex.clone().add(g.base).multiplyScalar(0.5);
    curlCue += chordMid.sub(mid).dot(N0) / g.sEnd;
  }
  curlCue /= fingerIdx.length;
  let thumbCue = 0;
  const palmMid = E.clone().lerp(K, 0.55);
  if (thumb >= 0) thumbCue = geoms[thumb].apex.clone().sub(palmMid).dot(N0) / scale;
  const cue = curlCue + 0.35 * thumbCue;
  const palmConfidence = Math.min(1, Math.abs(cue) / 0.04);
  if (palmConfidence < 0.35) warnings.push('The palm side is uncertain. If the fingers curl backwards, use "Flip palm side".');
  let sign = cue >= 0 ? 1 : -1;
  if (options.flipPalm) sign = -sign;
  const N = N0.clone().multiplyScalar(sign);
  const S = S0;
  const handedness: 'left' | 'right' = thumb < 0 ? 'right' : sign > 0 ? 'right' : 'left';

  let Lmax = 0;
  for (const i of fingerIdx) Lmax = Math.max(Lmax, fullLen[i]);
  const palmLength = Math.min(K.distanceTo(E), 0.88 * Lmax);
  const W = K.clone().addScaledVector(U, -palmLength);
  let palmWidth = 0;
  let meanR = 0;
  for (const i of fingerIdx) {
    meanR += geoms[i].tube.radius;
    for (const j of fingerIdx) palmWidth = Math.max(palmWidth, Math.abs(mcp[i].clone().sub(mcp[j]).dot(S)));
  }
  meanR /= fingerIdx.length;
  palmWidth += 2 * meanR;

  // --- 6. joints
  // order: thumb first, then fingers from the thumb side outwards
  const order = [...fingerIdx].sort((a, b) => mcp[b].dot(S) - mcp[a].dot(S));
  const names =
    order.length === 4
      ? ['index', 'middle', 'ring', 'pinky']
      : order.length === 5
        ? ['index', 'middle', 'ring', 'pinky', 'sixth']
        : order.length === 3
        ? ['index', 'middle', 'pinky']
        : order.map((_, i) => `finger${i + 1}`);
  const fingerSpecs: FingerSpec[] = [];
  const specGeom: FingerGeom[] = [];

  if (thumb >= 0) {
    const g = geoms[thumb];
    const sI0 = THUMB_IP * g.sEnd;
    const sM0 = THUMB_MCP * g.sEnd;
    const ip = g.pointAt(sI0), mc = g.pointAt(sM0);
    // the thumb's base joint sits in the heel of the palm, on the thumb side
    const target = W.clone()
      .addScaledVector(U, 0.3 * palmLength)
      .addScaledVector(S, 0.36 * palmWidth)
      .addScaledVector(N, 0.1 * palmWidth);
    const cmc = mc.clone().lerp(target, 0.9);
    const fixed = options.joints?.thumb;
    if (fixed?.length === 3) {
      cmc.set(...fixed[0]);
      mc.set(...fixed[1]);
      ip.set(...fixed[2]);
    }
    const sI = fixed ? Math.max(0.1 * g.sEnd, g.arcOf(ip)) : sI0;
    const sM = fixed ? Math.max(sI + 0.05 * g.sEnd, g.arcOf(mc)) : sM0;
    const rDist = g.radiusBetween(0, sI), rProx = g.radiusBetween(sI, sM);
    const sC = Math.max(sM + 0.05 * g.sEnd, g.sEnd + g.base.distanceTo(cmc));
    g.ext = [g.base, cmc, cmc.clone().addScaledVector(cmc.clone().sub(g.base).normalize(), 3 * rProx)];
    g.extArcs = [g.sEnd, sC, sC + 3 * rProx];
    g.jointArcs = [sC, sM, sI];
    g.blend = [1.0 * rProx, 0.7 * rProx, 0.55 * rDist];
    g.baseRadius = rProx * 1.15;
    fingerSpecs.push({
      name: 'thumb',
      isThumb: true,
      joints: [cmc, mc, ip],
      tip: g.apex.clone(),
      radii: [rProx * 1.15, rProx, rDist],
    });
    specGeom.push(g);
  }
  order.forEach((gi, n) => {
    const g = geoms[gi];
    let L = fullLen[gi];
    let sD = FINGER_DIP * L, sP = FINGER_PIP * L;
    const dip = g.pointAt(sD), pip = g.pointAt(sP), m = mcp[gi];
    const fixed = options.joints?.[names[n]];
    if (fixed?.length === 3) {
      m.set(...fixed[0]);
      pip.set(...fixed[1]);
      dip.set(...fixed[2]);
      sD = Math.max(0.08 * g.sEnd, g.arcOf(dip));
      sP = Math.max(sD + 0.08 * g.sEnd, g.arcOf(pip));
      L = Math.max(sP + 0.08 * g.sEnd, g.arcOf(m));
    }
    const rD = g.radiusBetween(0, sD), rM = g.radiusBetween(sD, sP), rP = g.radiusBetween(sP, L);
    const inward = fixed ? m.clone().sub(g.base) : g.tBase.clone();
    if (inward.lengthSq() < 1e-12) inward.copy(g.tBase);
    inward.normalize();
    g.ext = [g.base, m, m.clone().addScaledVector(inward, 3 * rP)];
    g.extArcs = [g.sEnd, L, L + 3 * rP];
    g.jointArcs = [L, sP, sD];
    g.blend = [0.9 * rP, 0.55 * rM, 0.55 * rD];
    g.baseRadius = rP;
    fingerSpecs.push({ name: names[n], isThumb: false, joints: [m, pip, dip], tip: g.apex.clone(), radii: [rP, rM, rD] });
    specGeom.push(g);
  });

  // --- 7. regions: which finger (if any) each surface vertex belongs to
  const region = new Int8Array(nV).fill(-1);
  specGeom.forEach((g, fi) => {
    const f = g.tube.field;
    for (let v = 0; v < nV; v++) if (f[v] <= g.endLevel) region[v] = fi;
  });

  // --- 8. fill the palm with spheres: cast through it and inflate to the skin
  const fullGeo = new BufferGeometry();
  fullGeo.setAttribute('position', new BufferAttribute(P.slice(), 3));
  fullGeo.setIndex(new BufferAttribute(mesh.indices.slice(), 1));
  const fullBvh = new MeshBVH(fullGeo);
  const palmTris: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
    if (region[a] < 0 && region[b] < 0 && region[c] < 0) palmTris.push(a, b, c);
  }
  const palmSpheres: { center: Vector3; radius: number }[] = [];
  const palmOrigin = W.clone().lerp(K, 0.55);
  if (palmTris.length >= 3) {
    const palmGeo = new BufferGeometry();
    palmGeo.setAttribute('position', new BufferAttribute(P.slice(), 3));
    palmGeo.setIndex(new BufferAttribute(new Uint32Array(palmTris), 1));
    const palmBvh = new MeshBVH(palmGeo);
    const ray = new Ray();
    const cast = (p: Vector3): { front: Vector3; back: Vector3 } | null => {
      ray.origin.copy(p).addScaledVector(N, scale);
      ray.direction.copy(N).negate();
      const h1 = palmBvh.raycastFirst(ray, DoubleSide);
      ray.origin.copy(p).addScaledVector(N, -scale);
      ray.direction.copy(N);
      const h2 = palmBvh.raycastFirst(ray, DoubleSide);
      if (!h1 || !h2) return null;
      const front = h1.point.clone(), back = h2.point.clone();
      if (front.clone().sub(back).dot(N) <= 0) return null;
      return { front, back };
    };
    const centre = cast(palmOrigin);
    const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
    const step = palmWidth / 5.5;
    const half = palmWidth * 0.75;
    const thickness: number[] = [];
    const raw: { front: Vector3; back: Vector3 }[] = [];
    for (let u = 0.06 * palmLength; u <= 1.02 * palmLength; u += step)
      for (let s = -half; s <= half; s += step) {
        const p = W.clone().addScaledVector(U, u).addScaledVector(S, s);
        const hit = cast(p);
        if (!hit) continue;
        raw.push(hit);
        thickness.push(hit.front.distanceTo(hit.back));
      }
    const medT = median(thickness);
    for (const hit of raw) {
      const t = hit.front.distanceTo(hit.back);
      if (t > 2.2 * medT) continue; // went through something that is not the palm slab
      let r = t / 2;
      const c = hit.front.clone().addScaledVector(N, -r);
      const near = fullBvh.closestPointToPoint(c, target);
      if (near && near.distance < r) {
        // shrink until it fits, staying tangent to the palm skin
        r = Math.max(near.distance, 0.5 * r);
        c.copy(hit.front).addScaledVector(N, -r);
      }
      if (r < 0.2 * medT) continue;
      palmSpheres.push({ center: c, radius: r });
    }
    if (centre) palmOrigin.copy(centre.front);
  }
  if (!palmSpheres.length) {
    warnings.push('The palm could not be measured, so it is approximated.');
    const r = meanR * 1.3;
    for (let u = 0.2; u <= 0.9; u += 0.35)
      for (let s = -0.3; s <= 0.3; s += 0.3)
        palmSpheres.push({
          center: W.clone().addScaledVector(U, u * palmLength).addScaledVector(S, s * palmWidth),
          radius: r,
        });
    palmOrigin.addScaledVector(N, r);
  }

  const spec: HandSpec = {
    wrist: W,
    fingers: fingerSpecs,
    up: U,
    normal: N,
    side: S,
    palmOrigin,
    palmLength,
    palmWidth,
    palmSpheres,
    handedness,
    thumbTurn: options.thumbTurn,
  };
  const model = buildHandModel(spec);

  // --- 9. skin weights
  // A vertex follows a finger if it is on that finger's surface (reached from
  // the fingertip along the skin) or simply inside that finger's volume. The
  // second rule is what makes nails, inner walls of gloves and loose pieces
  // move with the finger they belong to.
  const nBones = model.joints.length;
  const acc = new Float32Array(nBones);
  const tmp: number[] = [];
  const vp = new Vector3();
  const bounds = specGeom.map((g) => g.bound());
  const maxR = specGeom.map((g) => {
    let r = 0;
    for (let k = g.tube.cap; k <= g.endIdx; k++) r = Math.max(r, g.tube.rings[k].perimeter / (2 * Math.PI));
    return r;
  });
  // mv: the vertex's index in the main skin (so its distance along the skin from every fingertip is known), or -1
  const weigh = (x: number, y: number, z: number, r: number, level: number, outI: Uint16Array, outW: Float32Array, o: number, mv = -1) => {
    acc.fill(0);
    vp.set(x, y, z);
    let finger = r, arc = 0;
    if (finger >= 0) {
      arc = specGeom[finger].arcOfLevel(level);
    } else {
      let bestRatio = 1.35;
      for (let fi = 0; fi < specGeom.length; fi++) {
        const bd = bounds[fi];
        if (vp.distanceTo(bd.center) > bd.radius + 1.35 * maxR[fi]) continue;
        const pr = specGeom[fi].projectOnLine(vp);
        if (pr.atBase) continue;
        const ratio = pr.rho / specGeom[fi].radiusAt(pr.s);
        if (ratio < bestRatio) {
          bestRatio = ratio;
          finger = fi;
          arc = pr.s;
        }
      }
    }
    if (finger >= 0) {
      const g = specGeom[finger];
      const w = g.chainWeights(arc, tmp);
      const js = model.fingers[finger].joints;
      for (let k = 0; k < js.length; k++) acc[js[k]] += w[k];
      acc[0] += w[js.length];
    } else {
      if (mv >= 0) {
        // Palm skin. Measure, along the skin, how far past the end of each
        // finger this vertex is, and carry that finger's own bone weights on
        // by that distance: the knuckle and the fleshy base of the thumb then
        // follow their finger and fade into the palm smoothly, with no jump at
        // the edge of the finger. Where two fingers are about equally near
        // (the webs), the vertex is shared in proportion, so the web stretches
        // evenly instead of tearing.
        let sum = 0;
        const share: number[] = [];
        for (let fi = 0; fi < specGeom.length; fi++) {
          const g = specGeom[fi];
          const over = Math.max(0, g.tube.field[mv] - g.endLevel);
          const a = 1 / Math.pow(over / g.baseRadius + 0.05, 3);
          share.push(a);
          sum += a;
        }
        for (let fi = 0; fi < specGeom.length; fi++) {
          const part = share[fi] / sum;
          if (part < 0.02) continue;
          const g = specGeom[fi];
          const over = Math.max(0, g.tube.field[mv] - g.endLevel);
          const w = g.chainWeights(g.sEnd + over, tmp);
          const js = model.fingers[fi].joints;
          for (let k = 0; k < js.length; k++) acc[js[k]] += w[k] * part;
          acc[0] += w[js.length] * part;
        }
      } else {
        // A loose piece near the palm: follow the nearest finger's base part of the way.
        let near = -1, nearLateral = 0, nearS = 0;
        for (let fi = 0; fi < specGeom.length; fi++) {
          const g = specGeom[fi];
          const { s: sArc, rho } = g.projectOnExtension(vp);
          const lateral = 1 - smoothstep(1.15 * g.baseRadius, 2.1 * g.baseRadius, rho);
          if (lateral > nearLateral) {
            nearLateral = lateral;
            near = fi;
            nearS = sArc;
          }
        }
        let used = 0;
        if (near >= 0) {
          const w = specGeom[near].chainWeights(nearS, tmp);
          const js = model.fingers[near].joints;
          for (let k = 0; k < js.length; k++) {
            acc[js[k]] += w[k] * nearLateral;
            used += w[k] * nearLateral;
          }
        }
        acc[0] = 1 - used;
      }
    }
    // keep the four largest
    let total = 0;
    for (let slot = 0; slot < 4; slot++) {
      let best = -1, bw = 1e-5;
      for (let b = 0; b < nBones; b++)
        if (acc[b] > bw) {
          bw = acc[b];
          best = b;
        }
      outI[o + slot] = best < 0 ? 0 : best;
      outW[o + slot] = best < 0 ? 0 : bw;
      if (best < 0) continue;
      total += bw;
      acc[best] = 0;
    }
    if (total <= 0) {
      outI[o] = 0;
      outW[o] = 1;
    } else for (let slot = 0; slot < 4; slot++) outW[o + slot] /= total;
  };

  const mainIdx = new Uint16Array(nV * 4);
  const mainW = new Float32Array(nV * 4);
  // First the skin whose place on the hand is certain: the fingers themselves,
  // and palm skin within a few finger-widths (along the surface) of a finger's end.
  const pending: number[] = [];
  const settled = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) {
    const r = region[v];
    if (r < 0) {
      let nearest = Infinity;
      for (const g of specGeom) nearest = Math.min(nearest, (g.tube.field[v] - g.endLevel) / g.baseRadius);
      if (nearest > 3) {
        pending.push(v);
        continue;
      }
    }
    weigh(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], r, r >= 0 ? specGeom[r].tube.field[v] : 0, mainIdx, mainW, v * 4, v);
    settled[v] = 1;
  }
  // Everything else is a long way from any finger along the surface. That is
  // either ordinary palm and wrist skin, or the inside wall of a hollow glove,
  // which sits right under the outer skin but is only joined to it at the cuff.
  // Each such vertex copies the settled skin beside it, if there is any within
  // reach; that keeps an inner wall moving with the outer one instead of
  // poking through it. With nothing in reach it simply stays with the palm.
  {
    const reach = 1.5 * median(specGeom.map((g) => g.baseRadius));
    const cellOf = (x: number, y: number, z: number) => `${Math.floor(x / reach)},${Math.floor(y / reach)},${Math.floor(z / reach)}`;
    const grid = new Map<string, number[]>();
    for (let v = 0; v < nV; v++) {
      if (!settled[v]) continue;
      const key = cellOf(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      const list = grid.get(key);
      if (list) list.push(v);
      else grid.set(key, [v]);
    }
    for (const v of pending) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      const cx = Math.floor(x / reach), cy = Math.floor(y / reach), cz = Math.floor(z / reach);
      let best = -1, bd = reach;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!list) continue;
            for (const u of list) {
              const d = Math.hypot(P[u * 3] - x, P[u * 3 + 1] - y, P[u * 3 + 2] - z);
              if (d < bd) {
                bd = d;
                best = u;
              }
            }
          }
      if (best >= 0) {
        for (let slot = 0; slot < 4; slot++) {
          mainIdx[v * 4 + slot] = mainIdx[best * 4 + slot];
          mainW[v * 4 + slot] = mainW[best * 4 + slot];
        }
      } else {
        mainIdx[v * 4] = 0;
        mainW[v * 4] = 1;
      }
    }
  }

  // map back to the input vertices; pieces that are not part of the main skin are weighted by position alone
  const nIn = input.positions.length / 3;
  const skinIndices = new Uint16Array(nIn * 4);
  const skinWeights = new Float32Array(nIn * 4);
  const strayHit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const strayIndex = fullGeo.index!.array as Uint32Array;
  for (let i = 0; i < nIn; i++) {
    let m = main.fromSource[welded.remap[i]];
    if (m < 0) {
      // A loose piece (a seam, a nail, a strap): copy the skin right underneath it,
      // so the whole piece moves with the part of the hand it sits on.
      const x = input.positions[i * 3], y = input.positions[i * 3 + 1], z = input.positions[i * 3 + 2];
      const near = fullBvh.closestPointToPoint(vp.set(x, y, z), strayHit);
      if (!near) {
        weigh(x, y, z, -1, 0, skinIndices, skinWeights, i * 4);
        continue;
      }
      let bd = Infinity;
      for (let c = 0; c < 3; c++) {
        const v = strayIndex[near.faceIndex * 3 + c];
        const d = Math.hypot(P[v * 3] - x, P[v * 3 + 1] - y, P[v * 3 + 2] - z);
        if (d < bd) {
          bd = d;
          m = v;
        }
      }
    }
    for (let slot = 0; slot < 4; slot++) {
      skinIndices[i * 4 + slot] = mainIdx[m * 4 + slot];
      skinWeights[i * 4 + slot] = mainW[m * 4 + slot];
    }
  }

  // Clean-up: a vertex that follows a different finger (or the palm) from
  // every one of its neighbours is a mistake, and shows as a spike when the
  // hand bends. Give it the average of its neighbours instead.
  {
    const nW = welded.mesh.positions.length / 3;
    const first = new Int32Array(nW).fill(-1);
    for (let i = 0; i < nIn; i++) if (first[welded.remap[i]] < 0) first[welded.remap[i]] = i;
    const fingerOfBone = new Int16Array(nBones).fill(-1);
    model.fingers.forEach((f, fi) => f.joints.forEach((j) => (fingerOfBone[j] = fi)));
    const nb: number[][] = Array.from({ length: nW }, () => []);
    const wi = welded.mesh.indices;
    const link = (a: number, b: number) => {
      if (!nb[a].includes(b)) nb[a].push(b);
      if (!nb[b].includes(a)) nb[b].push(a);
    };
    for (let t = 0; t < wi.length; t += 3) {
      link(wi[t], wi[t + 1]);
      link(wi[t + 1], wi[t + 2]);
      link(wi[t + 2], wi[t]);
    }
    const owner = (w: number) => (first[w] < 0 ? -2 : fingerOfBone[skinIndices[first[w] * 4]]);
    const changed = new Uint8Array(nW);
    for (let pass = 0; pass < 2; pass++) {
      for (let w = 0; w < nW; w++) {
        if (first[w] < 0 || nb[w].length < 3) continue;
        const mine = owner(w);
        let common = owner(nb[w][0]), agree = true;
        for (const u of nb[w]) if (owner(u) !== common) agree = false;
        if (!agree || common === mine || common === -2) continue;
        acc.fill(0);
        for (const u of nb[w]) {
          const o = first[u] * 4;
          for (let slot = 0; slot < 4; slot++) acc[skinIndices[o + slot]] += skinWeights[o + slot];
        }
        let total = 0;
        const o = first[w] * 4;
        for (let slot = 0; slot < 4; slot++) {
          let best = -1, bw = 1e-6;
          for (let bi = 0; bi < nBones; bi++)
            if (acc[bi] > bw) {
              bw = acc[bi];
              best = bi;
            }
          skinIndices[o + slot] = best < 0 ? 0 : best;
          skinWeights[o + slot] = best < 0 ? 0 : bw;
          if (best >= 0) {
            total += bw;
            acc[best] = 0;
          }
        }
        if (total > 0) for (let slot = 0; slot < 4; slot++) skinWeights[o + slot] /= total;
        changed[w] = 1;
      }
    }
    for (let i = 0; i < nIn; i++) {
      const w = welded.remap[i];
      if (!changed[w] || first[w] === i) continue;
      for (let slot = 0; slot < 4; slot++) {
        skinIndices[i * 4 + slot] = skinIndices[first[w] * 4 + slot];
        skinWeights[i * 4 + slot] = skinWeights[first[w] * 4 + slot];
      }
    }
  }

  const rings = specGeom.map((g) =>
    g.tube.rings.slice(g.tube.cap, g.endIdx + 1).map((r) => ({ center: r.centroid, radius: r.perimeter / (2 * Math.PI) })),
  );
  const probeI = new Uint16Array(4), probeW = new Float32Array(4);
  const jointAt = (x: number, y: number, z: number): number => {
    weigh(x, y, z, -1, 0, probeI, probeW, 0);
    return probeI[0];
  };
  return { spec, model, skinIndices, skinWeights, warnings, palmConfidence, rings, jointAt };
}
