import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ObjPart } from './load';

/** What a held thing is, for its way up: a gun's top is up and its muzzle away; a tool's head is at the far end; a thing or a part has no way up. */
export type ItemStyle = 'gun' | 'tool' | 'thing' | 'part';

/** One closed piece of a held thing, with its own tree for "is this point inside it". */
export interface ItemPiece {
  name: string;
  positions: Float32Array;
  index: Uint32Array;
  bvh: MeshBVH;
}

export interface HeldItem {
  name: string;
  pieces: ItemPiece[];
  /** Its own space to world. */
  matrix: Matrix4;
  style: ItemStyle;
  /** In its own space: muzzle (or handle to head) and top. */
  forward: Vector3;
  up: Vector3;
  /** Items it is meant to sit in or on: not checked against them. */
  mates: string[];
  /** Corners and points along every edge (2 mm apart), in its own space: a thin edge cutting between skin points is caught too. */
  samples: Float32Array;
  /** Its own bounds. */
  min: Vector3;
  max: Vector3;
}

const EDGE_STEP = 0.002;

function edgeSamples(P: Float32Array, I: Uint32Array, out: number[]) {
  for (let i = 0; i < P.length; i++) out.push(P[i]);
  const seen = new Set<number>();
  const n = P.length / 3;
  for (let t = 0; t + 2 < I.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      if (seen.has(k)) continue;
      seen.add(k);
      const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2];
      const m = Math.floor(Math.hypot(dx, dy, dz) / EDGE_STEP);
      for (let s = 1; s <= m; s++) {
        const f = s / (m + 1);
        out.push(P[a * 3] + dx * f, P[a * 3 + 1] + dy * f, P[a * 3 + 2] + dz * f);
      }
    }
  }
}

/** The volume a closed surface encloses: positive when its faces wind counter-clockwise seen from outside. */
export function signedVolume(P: ArrayLike<number>, I: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

export function makeItem(
  name: string,
  parts: ObjPart[],
  options: { style?: ItemStyle; forward?: Vector3; up?: Vector3; mates?: string[]; matrix?: Matrix4 } = {},
): HeldItem {
  const pieces: ItemPiece[] = [];
  const samples: number[] = [];
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of parts) {
    // a piece whose faces wind inwards (an exporter that mirrored it without turning its faces) is turned the right way out:
    // every inside test reads the faces' winding
    if (signedVolume(p.positions, p.index) < 0) for (let t = 0; t + 2 < p.index.length; t += 3) [p.index[t + 1], p.index[t + 2]] = [p.index[t + 2], p.index[t + 1]];
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(p.positions, 3));
    g.setIndex(new BufferAttribute(p.index, 1));
    pieces.push({ name: p.name, positions: p.positions, index: p.index, bvh: new MeshBVH(g) });
    edgeSamples(p.positions, p.index, samples);
    for (let i = 0; i < p.positions.length; i += 3) {
      min.min(new Vector3(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
      max.max(new Vector3(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
    }
  }
  return {
    name,
    pieces,
    matrix: options.matrix?.clone() ?? new Matrix4(),
    style: options.style ?? 'thing',
    forward: (options.forward ?? new Vector3(0, 0, 1)).clone().normalize(),
    up: (options.up ?? new Vector3(0, 1, 0)).clone().normalize(),
    mates: options.mates ?? [],
    samples: Float32Array.from(samples),
    min,
    max,
  };
}

const _hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _n = new Vector3();

/** The face normal of triangle `face` of a mesh (from its winding). */
export function faceNormal(P: ArrayLike<number>, I: ArrayLike<number>, face: number, out = new Vector3()): Vector3 {
  const i = face * 3;
  _a.fromArray(P as number[], I[i] * 3);
  _b.fromArray(P as number[], I[i + 1] * 3);
  _c.fromArray(P as number[], I[i + 2] * 3);
  // counter-clockwise seen from outside, as three draws a front face
  return out.subVectors(_b, _a).cross(_c.sub(_a)).normalize();
}

/**
 * How deep a point (in the surface's own space) is inside a closed surface: the distance to its nearest face when it is on that
 * face's inner side, else 0. `within` bounds the search: a point further than that from the surface counts as outside (it is
 * past the far wall of anything that thin, or the surface is open there).
 */
export function depthInside(bvh: MeshBVH, P: ArrayLike<number>, I: ArrayLike<number>, p: Vector3, within: number): number {
  const hit = bvh.closestPointToPoint(p, _hit, 0, within);
  if (!hit) return 0;
  faceNormal(P, I, hit.faceIndex, _n);
  const v = _a.subVectors(p, hit.point);
  return v.dot(_n) < 0 ? hit.distance : 0;
}

/** Nearest distance from a point (in the item's own space) to any piece of the item. */
export function distanceToItem(item: HeldItem, p: Vector3, within = Infinity): number {
  let best = within;
  for (const piece of item.pieces) {
    const h = piece.bvh.closestPointToPoint(p, _hit, 0, best);
    if (h) best = Math.min(best, h.distance);
  }
  return best;
}

/** The deepest a point (in the item's own space) is inside any piece of the item. */
export function depthInItem(item: HeldItem, p: Vector3, within = 0.03): number {
  let d = 0;
  for (const piece of item.pieces) d = Math.max(d, depthInside(piece.bvh, piece.positions, piece.index, p, within));
  return d;
}
