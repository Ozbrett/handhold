import type { TriMesh } from './trimesh';

/** One connected piece of a level set of a scalar field on the mesh surface. */
export interface Loop {
  /** xyz triples along the curve */
  points: number[];
  closed: boolean;
  length: number;
  centroid: [number, number, number];
  /** mean distance of the curve from its centroid */
  radius: number;
}

/**
 * Extract the curves where a per-vertex scalar field crosses `level`
 * (marching triangles). `triangles` optionally restricts the search to a
 * subset of triangle indices.
 */
export function levelLoops(
  mesh: TriMesh,
  field: Float32Array,
  level: number,
  triangles?: ArrayLike<number>,
): Loop[] {
  const { positions: p, indices: idx } = mesh;
  const n = p.length / 3;
  // crossing point per mesh edge
  const nodeOf = new Map<number, number>();
  const px: number[] = [];
  const link1: number[] = [];
  const link2: number[] = [];
  const node = (a: number, b: number): number => {
    const key = a < b ? a * n + b : b * n + a;
    let id = nodeOf.get(key);
    if (id !== undefined) return id;
    id = link1.length;
    nodeOf.set(key, id);
    const fa = field[a], fb = field[b];
    const t = (level - fa) / (fb - fa);
    px.push(
      p[a * 3] + (p[b * 3] - p[a * 3]) * t,
      p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * t,
      p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * t,
    );
    link1.push(-1);
    link2.push(-1);
    return id;
  };
  const connect = (u: number, v: number) => {
    if (link1[u] === -1) link1[u] = v;
    else if (link2[u] === -1) link2[u] = v;
    if (link1[v] === -1) link1[v] = u;
    else if (link2[v] === -1) link2[v] = u;
  };
  const count = triangles ? triangles.length : idx.length / 3;
  for (let i = 0; i < count; i++) {
    const t = (triangles ? triangles[i] : i) * 3;
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const fa = field[a], fb = field[b], fc = field[c];
    if (!(fa < Infinity && fb < Infinity && fc < Infinity)) continue;
    const ua = fa >= level, ub = fb >= level, uc = fc >= level;
    if (ua === ub && ub === uc) continue;
    let n1: number, n2: number;
    if (ua !== ub && ua !== uc) {
      n1 = node(a, b);
      n2 = node(a, c);
    } else if (ub !== ua && ub !== uc) {
      n1 = node(b, a);
      n2 = node(b, c);
    } else {
      n1 = node(c, a);
      n2 = node(c, b);
    }
    if (n1 !== n2) connect(n1, n2);
  }
  const m = link1.length;
  const visited = new Uint8Array(m);
  const loops: Loop[] = [];
  const walk = (start: number, first: number): number[] => {
    // follow links from start via `first`, returns visited node ids (excluding start)
    const out: number[] = [];
    let prev = start, cur = first;
    while (cur !== -1 && !visited[cur]) {
      visited[cur] = 1;
      out.push(cur);
      const next = link1[cur] === prev ? link2[cur] : link1[cur];
      prev = cur;
      cur = next;
    }
    return out;
  };
  for (let s = 0; s < m; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const fwd = walk(s, link1[s]);
    let chain: number[];
    let closed = false;
    if (fwd.length > 0) {
      const last = fwd[fwd.length - 1];
      // closed if the last node links back to the start
      closed = fwd.length > 1 && (link1[last] === s || link2[last] === s);
    }
    if (closed) {
      chain = [s, ...fwd];
    } else {
      const back = walk(s, link2[s]);
      chain = [...back.reverse(), s, ...fwd];
    }
    if (chain.length < 2) continue;
    const pts: number[] = new Array(chain.length * 3);
    for (let i = 0; i < chain.length; i++) {
      pts[i * 3] = px[chain[i] * 3];
      pts[i * 3 + 1] = px[chain[i] * 3 + 1];
      pts[i * 3 + 2] = px[chain[i] * 3 + 2];
    }
    loops.push(measureLoop(pts, closed));
  }
  return loops;
}

function measureLoop(pts: number[], closed: boolean): Loop {
  const k = pts.length / 3;
  let length = 0, cx = 0, cy = 0, cz = 0;
  const segs = closed ? k : k - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = ((i + 1) % k) * 3;
    const l = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]);
    length += l;
    cx += (l * (pts[a] + pts[b])) / 2;
    cy += (l * (pts[a + 1] + pts[b + 1])) / 2;
    cz += (l * (pts[a + 2] + pts[b + 2])) / 2;
  }
  if (length < 1e-20) {
    return { points: pts, closed, length: 0, centroid: [pts[0], pts[1], pts[2]], radius: 0 };
  }
  cx /= length;
  cy /= length;
  cz /= length;
  let r = 0;
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = ((i + 1) % k) * 3;
    const l = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]);
    const mx = (pts[a] + pts[b]) / 2 - cx, my = (pts[a + 1] + pts[b + 1]) / 2 - cy, mz = (pts[a + 2] + pts[b + 2]) / 2 - cz;
    r += l * Math.hypot(mx, my, mz);
  }
  return { points: pts, closed, length, centroid: [cx, cy, cz], radius: r / length };
}

/**
 * Bucket triangles by which levels (multiples of `delta`) cross them, so
 * repeated level-set extraction only touches relevant triangles.
 */
export function bucketTrianglesByLevel(
  mesh: TriMesh,
  field: Float32Array,
  delta: number,
  maxLevel: number,
): number[][] {
  const buckets: number[][] = [];
  for (let k = 0; k <= maxLevel; k++) buckets.push([]);
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const fa = field[idx[t]], fb = field[idx[t + 1]], fc = field[idx[t + 2]];
    const lo = Math.min(fa, fb, fc), hi = Math.max(fa, fb, fc);
    if (!(hi < Infinity)) continue;
    const k0 = Math.max(1, Math.ceil(lo / delta));
    const k1 = Math.min(maxLevel, Math.floor(hi / delta));
    for (let k = k0; k <= k1; k++) buckets[k].push(t / 3);
  }
  return buckets;
}
