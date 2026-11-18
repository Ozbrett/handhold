/**
 * Minimal indexed triangle mesh utilities used by the hand analysis.
 * Everything here is DOM-free so it can run in Node tests and Web Workers.
 */

export interface TriMesh {
  /** xyz triples */
  positions: Float32Array;
  /** vertex index triples */
  indices: Uint32Array;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  diag: number;
}

export function computeBounds(positions: ArrayLike<number>): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return { min, max, diag };
}

/**
 * Merge vertices that share a position (UV seams, hard edges and exporters
 * split them) so the mesh has real connectivity. Returns the welded mesh and
 * a map from every original vertex to its welded vertex.
 */
export function weldMesh(mesh: TriMesh, eps?: number): { mesh: TriMesh; remap: Uint32Array } {
  const { positions, indices } = mesh;
  const n = positions.length / 3;
  const b = computeBounds(positions);
  const cell = eps ?? Math.max(b.diag * 1e-6, 1e-12);
  const inv = 1 / cell;
  const map = new Map<string, number>();
  const remap = new Uint32Array(n);
  const out: number[] = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let id = map.get(key);
    if (id === undefined) {
      id = count++;
      map.set(key, id);
      out.push(x, y, z);
    }
    remap[i] = id;
  }
  const tris: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], bb = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === bb || bb === c || a === c) continue;
    tris.push(a, bb, c);
  }
  return {
    mesh: { positions: new Float32Array(out), indices: new Uint32Array(tris) },
    remap,
  };
}

/** Label connected components (by shared vertices). Returns per-vertex label and sizes. */
export function connectedComponents(mesh: TriMesh): { labels: Int32Array; sizes: number[] } {
  const n = mesh.positions.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[find(c)] = a2;
  }
  const labels = new Int32Array(n).fill(-1);
  const rootLabel = new Map<number, number>();
  const sizes: number[] = [];
  const used = new Uint8Array(n);
  for (let t = 0; t < idx.length; t++) used[idx[t]] = 1;
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const r = find(i);
    let l = rootLabel.get(r);
    if (l === undefined) {
      l = sizes.length;
      rootLabel.set(r, l);
      sizes.push(0);
    }
    labels[i] = l;
    sizes[l]++;
  }
  return { labels, sizes };
}

/**
 * Keep only the triangles of one component. Vertices are re-indexed;
 * `toSource` maps new vertex -> source vertex, `fromSource` the reverse (-1 if dropped).
 */
export function extractComponent(
  mesh: TriMesh,
  labels: Int32Array,
  label: number,
): { mesh: TriMesh; toSource: Uint32Array; fromSource: Int32Array } {
  const n = mesh.positions.length / 3;
  const fromSource = new Int32Array(n).fill(-1);
  const toSource: number[] = [];
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (labels[i] !== label) continue;
    fromSource[i] = toSource.length;
    toSource.push(i);
    pos.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
  }
  const tris: number[] = [];
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    if (labels[idx[t]] !== label) continue;
    tris.push(fromSource[idx[t]], fromSource[idx[t + 1]], fromSource[idx[t + 2]]);
  }
  return {
    mesh: { positions: new Float32Array(pos), indices: new Uint32Array(tris) },
    toSource: new Uint32Array(toSource),
    fromSource,
  };
}

/** Compressed adjacency with edge lengths. */
export interface Graph {
  offsets: Uint32Array;
  neighbors: Uint32Array;
  weights: Float32Array;
}

/**
 * Vertex graph for geodesic distances. Besides mesh edges it adds a shortcut
 * across every pair of triangles sharing an edge (unfolded flat), which makes
 * graph distances much closer to true surface distances on coarse meshes.
 */
export function buildGraph(mesh: TriMesh): Graph {
  const { positions: p, indices: idx } = mesh;
  const n = p.length / 3;
  const adj: number[][] = new Array(n);
  const adjW: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    adj[i] = [];
    adjW[i] = [];
  }
  const dist = (a: number, b: number) =>
    Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  const addEdge = (a: number, b: number, w: number) => {
    const la = adj[a];
    for (let k = 0; k < la.length; k++) {
      if (la[k] === b) {
        if (w < adjW[a][k]) {
          adjW[a][k] = w;
          const lb = adj[b];
          for (let m = 0; m < lb.length; m++) if (lb[m] === a) adjW[b][m] = w;
        }
        return;
      }
    }
    la.push(b);
    adjW[a].push(w);
    adj[b].push(a);
    adjW[b].push(w);
  };
  // edge -> opposite vertices
  const opp = new Map<number, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const tri = [a, b, c];
    for (let e = 0; e < 3; e++) {
      const u = tri[e], v = tri[(e + 1) % 3], o = tri[(e + 2) % 3];
      addEdge(u, v, dist(u, v));
      const k = edgeKey(u, v);
      const list = opp.get(k);
      if (list) list.push(o);
      else opp.set(k, [o]);
    }
  }
  // unfolded shortcuts
  for (const [k, list] of opp) {
    if (list.length !== 2) continue;
    const a = Math.floor(k / n), b = k - a * n;
    const c = list[0], d = list[1];
    if (c === d) continue;
    const L = dist(a, b);
    if (L < 1e-20) continue;
    const ac = dist(a, c), bc = dist(b, c), ad = dist(a, d), bd = dist(b, d);
    // 2D layout: a at origin, b at (L,0), c above, d below
    const cx = (ac * ac - bc * bc + L * L) / (2 * L);
    const cy2 = ac * ac - cx * cx;
    const dx = (ad * ad - bd * bd + L * L) / (2 * L);
    const dy2 = ad * ad - dx * dx;
    if (cy2 <= 0 || dy2 <= 0) continue;
    const cy = Math.sqrt(cy2), dy = -Math.sqrt(dy2);
    const xs = cx + ((dx - cx) * cy) / (cy - dy);
    if (xs < 0 || xs > L) continue;
    addEdge(c, d, Math.hypot(cx - dx, cy - dy));
  }
  const offsets = new Uint32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = total;
    total += adj[i].length;
  }
  offsets[n] = total;
  const neighbors = new Uint32Array(total);
  const weights = new Float32Array(total);
  for (let i = 0; i < n; i++) {
    neighbors.set(adj[i], offsets[i]);
    weights.set(adjW[i], offsets[i]);
  }
  return { offsets, neighbors, weights };
}

/** Multi-source Dijkstra over the vertex graph. Unreached vertices are Infinity. */
export function dijkstra(g: Graph, sources: number[]): Float32Array {
  const n = g.offsets.length - 1;
  const dist = new Float32Array(n).fill(Infinity);
  // binary heap with lazy deletion
  let cap = 1024;
  let hv = new Uint32Array(cap);
  let hk = new Float32Array(cap);
  let size = 0;
  const push = (v: number, k: number) => {
    if (size === cap) {
      cap *= 2;
      const nv = new Uint32Array(cap);
      nv.set(hv);
      hv = nv;
      const nk = new Float32Array(cap);
      nk.set(hk);
      hk = nk;
    }
    let i = size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (hk[parent] <= k) break;
      hv[i] = hv[parent];
      hk[i] = hk[parent];
      i = parent;
    }
    hv[i] = v;
    hk[i] = k;
  };
  const pop = () => {
    const lastV = hv[--size], lastK = hk[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= lastK) break;
      hv[i] = hv[c];
      hk[i] = hk[c];
      i = c;
    }
    hv[i] = lastV;
    hk[i] = lastK;
  };
  for (const s of sources) {
    dist[s] = 0;
    push(s, 0);
  }
  while (size > 0) {
    const v = hv[0], k = hk[0];
    pop();
    if (k > dist[v]) continue;
    for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
      const u = g.neighbors[e];
      // Round to the stored precision before comparing. Otherwise a path that
      // is shorter only in the discarded digits is "improved" again and again,
      // which on very regular meshes (many equal-length paths) never ends.
      const nd = Math.fround(k + g.weights[e]);
      if (nd < dist[u]) {
        dist[u] = nd;
        push(u, nd);
      }
    }
  }
  return dist;
}

/** Vertices lying on an open boundary (edges used by exactly one triangle). */
export function boundaryVertices(mesh: TriMesh): Uint8Array {
  const n = mesh.positions.length / 3;
  const count = new Map<number, number>();
  const idx = mesh.indices;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = key(idx[t + e], idx[t + ((e + 1) % 3)]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const flags = new Uint8Array(n);
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const a = Math.floor(k / n);
    flags[a] = 1;
    flags[k - a * n] = 1;
  }
  return flags;
}

/** Signed volume and centre of mass of a (roughly closed) mesh. */
export function volumeAndCentroid(mesh: TriMesh): { volume: number; centroid: [number, number, number] } {
  const { positions: p, indices: idx } = mesh;
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const v =
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
    vol += v;
    cx += (v * (p[a] + p[b] + p[c])) / 4;
    cy += (v * (p[a + 1] + p[b + 1] + p[c + 1])) / 4;
    cz += (v * (p[a + 2] + p[b + 2] + p[c + 2])) / 4;
  }
  if (Math.abs(vol) < 1e-20) return { volume: 0, centroid: [0, 0, 0] };
  return { volume: vol, centroid: [cx / vol, cy / vol, cz / vol] };
}

/** Area-weighted surface centroid; a fallback centre of mass for open meshes. */
export function surfaceCentroid(mesh: TriMesh): [number, number, number] {
  const { positions: p, indices: idx } = mesh;
  let area = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area += ar;
    cx += (ar * (p[a] + p[b] + p[c])) / 3;
    cy += (ar * (p[a + 1] + p[b + 1] + p[c + 1])) / 3;
    cz += (ar * (p[a + 2] + p[b + 2] + p[c + 2])) / 3;
  }
  if (area < 1e-20) return [0, 0, 0];
  return [cx / area, cy / area, cz / area];
}
