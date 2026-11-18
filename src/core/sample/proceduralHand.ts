import type { TriMesh } from '../trimesh';
import { surfaceNets } from './surfaceNets';

type V3 = [number, number, number];

export interface ProceduralHandOptions {
  /** Mirror into a left hand. */
  left?: boolean;
  /** 5 = human, 4 = cartoon hand (thumb + three fingers). */
  fingerCount?: 4 | 5;
  /** Rest-pose curl multiplier; 1 is a relaxed hand, 0 is flat. */
  curl?: number;
  /** Extra forearm length in metres. */
  forearm?: number;
  /** Meshing resolution in metres. */
  cell?: number;
  /**
   * Make the hand a hollow glove with walls this thick (metres): an outer and
   * an inner surface joined round an open wrist, like many scanned or
   * generated gloves.
   */
  hollow?: number;
}

export interface ProceduralHandTruth {
  wrist: V3;
  up: V3;
  palmNormal: V3;
  handedness: 'left' | 'right';
  fingers: { name: string; joints: V3[]; tip: V3; radii: number[] }[];
}

export interface ProceduralHand {
  mesh: TriMesh;
  truth: ProceduralHandTruth;
  /** With `hollow`: vertices before this index are the outer wall, the rest the inner wall. */
  outerVertices?: number;
}

/** Drops the triangles below a height and joins the two open rims of an outer and inner wall. */
function joinWalls(outer: TriMesh, inner: TriMesh, cutY: number): TriMesh {
  const nO = outer.positions.length / 3;
  const positions = new Float32Array(outer.positions.length + inner.positions.length);
  positions.set(outer.positions);
  positions.set(inner.positions, outer.positions.length);
  const tris: number[] = [];
  const add = (src: TriMesh, offset: number) => {
    for (let t = 0; t < src.indices.length; t += 3) {
      const a = src.indices[t], b = src.indices[t + 1], c = src.indices[t + 2];
      const y = (src.positions[a * 3 + 1] + src.positions[b * 3 + 1] + src.positions[c * 3 + 1]) / 3;
      if (y >= cutY) tris.push(a + offset, b + offset, c + offset);
    }
  };
  add(outer, 0);
  add(inner, nO);
  // open edges: used by exactly one triangle
  const n = positions.length / 3;
  const count = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let t = 0; t < tris.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const k = key(tris[t + e], tris[t + ((e + 1) % 3)]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  const rim: [number, number][] = [];
  for (const [k, c] of count) if (c === 1) rim.push([Math.floor(k / n), k % n]);
  const rimVerts = { outer: new Set<number>(), inner: new Set<number>() };
  for (const [a, b] of rim) for (const v of [a, b]) (v < nO ? rimVerts.outer : rimVerts.inner).add(v);
  const nearest = (v: number, pool: Set<number>, mx: number, my: number, mz: number) => {
    let best = v, bd = Infinity;
    for (const u of pool) {
      const d = Math.hypot(positions[u * 3] - mx, positions[u * 3 + 1] - my, positions[u * 3 + 2] - mz);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  };
  for (const [a, b] of rim) {
    const pool = a < nO ? rimVerts.inner : rimVerts.outer;
    if (!pool.size) continue;
    const mx = (positions[a * 3] + positions[b * 3]) / 2;
    const my = (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2;
    const mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2;
    tris.push(a, b, nearest(a, pool, mx, my, mz));
  }
  return { positions, indices: new Uint32Array(tris) };
}

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const rot = (v: V3, axis: V3, ang: number): V3 => {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = cross(axis, v), d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
};
const DEG = Math.PI / 180;

interface Capsule {
  a: V3;
  b: V3;
  r: number;
}

function capsuleSdf(x: number, y: number, z: number, c: Capsule): number {
  const bax = c.b[0] - c.a[0], bay = c.b[1] - c.a[1], baz = c.b[2] - c.a[2];
  const pax = x - c.a[0], pay = y - c.a[1], paz = z - c.a[2];
  let h = (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - c.r;
}

function roundBoxSdf(x: number, y: number, z: number, c: V3, h: V3, r: number): number {
  const qx = Math.abs(x - c[0]) - (h[0] - r), qy = Math.abs(y - c[1]) - (h[1] - r), qz = Math.abs(z - c[2]) - (h[2] - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * A simple mannequin hand built from capsules and a rounded palm.
 * Used as the built-in sample hand and as ground truth in tests:
 * the true joint positions are returned alongside the mesh.
 * Right hand layout: wrist at the origin, fingers along +Y, palm facing +Z, thumb towards +X.
 */
export function createProceduralHand(options: ProceduralHandOptions = {}): ProceduralHand {
  const curl = options.curl ?? 1;
  const fingerCount = options.fingerCount ?? 5;
  const forearm = options.forearm ?? 0;
  const cell = options.cell ?? 0.0016;
  const N: V3 = [0, 0, 1];

  // Knuckle joints sit inside the palm: the visible finger starts at the web,
  // about a quarter of the finger's length beyond the joint.
  const defs = [
    { name: 'index', mcp: [0.031, 0.0715, 0] as V3, len: [0.042, 0.025, 0.018], r: [0.0088, 0.008, 0.0074], spread: 7 },
    { name: 'middle', mcp: [0.0095, 0.0755, 0] as V3, len: [0.046, 0.029, 0.019], r: [0.009, 0.0082, 0.0076], spread: 1.5 },
    { name: 'ring', mcp: [-0.012, 0.0725, 0] as V3, len: [0.042, 0.027, 0.019], r: [0.0085, 0.0077, 0.0071], spread: -4.5 },
    { name: 'pinky', mcp: [-0.0325, 0.062, 0] as V3, len: [0.033, 0.02, 0.0165], r: [0.0076, 0.0068, 0.0063], spread: -12 },
  ].slice(0, fingerCount - 1);

  const capsules: Capsule[][] = [];
  const truthFingers: ProceduralHandTruth['fingers'] = [];

  // thumb
  {
    const cmc: V3 = [0.03, 0.022, 0.006];
    const f0 = norm([0.7, 0.6, 0.38]);
    const padRaw: V3 = [-0.7, 0, 0.7];
    const pad = norm(add(padRaw, f0, -dot(padRaw, f0)));
    const axis = norm(cross(f0, pad));
    const len = [0.044, 0.032, 0.021];
    const r = [0.0135, 0.011, 0.0098];
    const mcp = add(cmc, f0, len[0]);
    const d1 = rot(f0, axis, 8 * DEG * curl);
    const ip = add(mcp, d1, len[1]);
    const d2 = rot(d1, axis, 10 * DEG * curl);
    const end = add(ip, d2, len[2]);
    capsules.push([
      { a: cmc, b: mcp, r: r[0] },
      { a: mcp, b: ip, r: r[1] },
      { a: ip, b: end, r: r[2] },
    ]);
    truthFingers.push({ name: 'thumb', joints: [cmc, mcp, ip], tip: add(end, d2, r[2]), radii: r });
  }

  for (const d of defs) {
    const s = d.spread * DEG;
    const dir0: V3 = [Math.sin(s), Math.cos(s), 0];
    const axis = norm(cross(dir0, N));
    const d1 = rot(dir0, axis, 10 * DEG * curl);
    const pip = add(d.mcp, d1, d.len[0]);
    const d2 = rot(d1, axis, 14 * DEG * curl);
    const dip = add(pip, d2, d.len[1]);
    const d3 = rot(d2, axis, 8 * DEG * curl);
    const end = add(dip, d3, d.len[2]);
    capsules.push([
      { a: d.mcp, b: pip, r: d.r[0] },
      { a: pip, b: dip, r: d.r[1] },
      { a: dip, b: end, r: d.r[2] },
    ]);
    truthFingers.push({ name: d.name, joints: [d.mcp, pip, dip], tip: add(end, d3, d.r[2]), radii: d.r });
  }

  const palmC: V3 = [-0.001, 0.047, 0];
  const wristC: V3 = [0, -0.012 - forearm / 2, 0];
  const wristH: V3 = [0.029, 0.022 + forearm / 2, 0.018];
  const mirror = options.left ? -1 : 1;

  // the fleshy base of the thumb, so the thumb leaves the palm near its middle joint
  const thumbChain = capsules[0];
  const thenar: Capsule = {
    a: thumbChain[0].a,
    b: add(thumbChain[0].a, [thumbChain[0].b[0] - thumbChain[0].a[0], thumbChain[0].b[1] - thumbChain[0].a[1], thumbChain[0].b[2] - thumbChain[0].a[2]], 0.8),
    r: 0.0165,
  };

  const sdf = (xIn: number, y: number, z: number): number => {
    const x = xIn * mirror;
    // palm narrows towards the wrist; its top edge arcs down towards the little finger
    const t = Math.min(Math.max(y / 0.09, 0), 1);
    const hx = 0.034 + 0.0075 * t * t * (3 - 2 * t);
    const arc = 12 * (x - 0.008) * (x - 0.008) - 0.006;
    const yw = y + arc * Math.min(1, Math.max(0, (y - 0.03) / 0.04));
    const palm = roundBoxSdf(x, yw, z, palmC, [hx, 0.047, 0.0135], 0.0115);
    const wrist = roundBoxSdf(x, y, z, wristC, wristH, 0.015);
    const body = smin(smin(palm, wrist, 0.012), capsuleSdf(x, y, z, thenar), 0.012);
    let d = body;
    for (const chain of capsules) {
      let fd = Infinity;
      for (const c of chain) fd = Math.min(fd, capsuleSdf(x, y, z, c));
      d = Math.min(d, smin(body, fd, 0.007));
    }
    return d;
  };

  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: V3, r: number) => {
    for (let a = 0; a < 3; a++) {
      const v = a === 0 ? p[a] * mirror : p[a];
      min[a] = Math.min(min[a], v - r);
      max[a] = Math.max(max[a], v + r);
    }
  };
  for (const chain of capsules)
    for (const c of chain) {
      grow(c.a, c.r);
      grow(c.b, c.r);
    }
  grow([palmC[0] - 0.045, palmC[1] - 0.05, -0.02], 0);
  grow([palmC[0] + 0.045, palmC[1] + 0.05, 0.02], 0);
  grow([wristC[0] - wristH[0], wristC[1] - wristH[1], -wristH[2]], 0);
  grow([wristC[0] + wristH[0], wristC[1] + wristH[1], wristH[2]], 0);
  const pad = cell * 3;
  const lo: V3 = [min[0] - pad, min[1] - pad, min[2] - pad];
  const hi: V3 = [max[0] + pad, max[1] + pad, max[2] + pad];
  let mesh = surfaceNets(sdf, lo, hi, cell);
  let outerVertices: number | undefined;
  if (options.hollow) {
    const wall = options.hollow;
    const inner = surfaceNets((x, y, z) => -(sdf(x, y, z) + wall), lo, hi, cell);
    outerVertices = mesh.positions.length / 3;
    mesh = joinWalls(mesh, inner, wristC[1] - wristH[1] + 0.012);
  }

  const mx = (p: V3): V3 => [p[0] * mirror, p[1], p[2]];
  return {
    mesh,
    outerVertices,
    truth: {
      wrist: [0, 0, 0],
      up: [0, 1, 0],
      palmNormal: [0, 0, 1],
      handedness: options.left ? 'left' : 'right',
      fingers: truthFingers.map((f) => ({ name: f.name, joints: f.joints.map(mx), tip: mx(f.tip), radii: f.radii })),
    },
  };
}
