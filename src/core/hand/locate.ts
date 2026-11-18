import {
  type TriMesh,
  buildGraph,
  connectedComponents,
  dijkstra,
  extractComponent,
  weldMesh,
} from '../trimesh';
import { type AnalyzeOptions, type HandAnalysis, analyzeHandMesh } from './analyze';

/** A hand found somewhere inside a larger model. */
export interface LocatedHand {
  /** One flag per input vertex: 1 if it belongs to this hand. */
  keep: Uint8Array;
  /** The same hand with more of the forearm left on; a fallback if `keep` cannot be rigged. */
  keepWide: Uint8Array;
  handedness: 'left' | 'right';
  fingers: number;
  center: [number, number, number];
  /** Direction the palm was judged to face, and how sure that judgement is (0..1). */
  palmNormal: [number, number, number];
  palmConfidence: number;
  /** True if the palm side should be flipped when this hand is analysed on its own. */
  flip: boolean;
}

export interface LocateResult {
  /**
   * 'hand': the model is a single hand, `analysis` is ready to use.
   * 'character': the model is something bigger and `hands` lists the hands found on it.
   * 'none': no hand could be found; `error` says why.
   */
  kind: 'hand' | 'character' | 'none';
  analysis?: HandAnalysis;
  hands: LocatedHand[];
  error?: string;
}

function tryHand(mesh: TriMesh): HandAnalysis | null {
  try {
    const a = analyzeHandMesh(mesh);
    if (a.spec.fingers.length < 4 || !a.spec.fingers.some((f) => f.isThumb)) return null;
    return a;
  } catch {
    return null;
  }
}

function centerOf(mesh: TriMesh): [number, number, number] {
  let x = 0, y = 0, z = 0;
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    x += mesh.positions[i * 3];
    y += mesh.positions[i * 3 + 1];
    z += mesh.positions[i * 3 + 2];
  }
  return [x / n, y / n, z / n];
}

/**
 * Works out whether a model is a single hand or something with hands on it
 * (a whole character, an arm, a pair of hands) and, in the second case, finds
 * each hand and marks the vertices that belong to it.
 *
 * Hands on a body are found two ways: as separate pieces of the mesh, and by
 * walking to the far ends of the surface (the ends of the arms) and testing
 * the region around each end.
 */
export function locateHands(input: TriMesh, options: AnalyzeOptions & { character?: boolean } = {}): LocateResult {
  const nIn = input.positions.length / 3;
  const welded = weldMesh(input);
  const comps = connectedComponents(welded.mesh);
  const minSize = Math.max(60, Math.floor(0.004 * (welded.mesh.positions.length / 3)));
  const sizeable = comps.sizes
    .map((size, label) => ({ size, label }))
    .filter((c) => c.size >= minSize)
    .sort((a, b) => b.size - a.size)
    .slice(0, 12);

  // the ordinary case: the whole model is one hand
  let error: string | undefined;
  const second = sizeable.length > 1 ? sizeable[1].size / sizeable[0].size : 0;
  if (!options.character && second < 0.35) {
    try {
      return { kind: 'hand', analysis: analyzeHandMesh(input, options), hands: [] };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const hands: LocatedHand[] = [];
  const maskFromWelded = (inSet: (weldedVertex: number) => boolean): Uint8Array => {
    const keep = new Uint8Array(nIn);
    for (let i = 0; i < nIn; i++) if (inSet(welded.remap[i])) keep[i] = 1;
    return keep;
  };

  for (const c of sizeable) {
    const part = extractComponent(welded.mesh, comps.labels, c.label);
    // a piece that is a hand by itself (hands are often attached as separate meshes)
    if (sizeable.length > 1) {
      const a = tryHand(part.mesh);
      if (a) {
        const whole = maskFromWelded((w) => comps.labels[w] === c.label);
        hands.push({
          keep: whole,
          keepWide: whole,
          handedness: a.model.handedness,
          fingers: a.spec.fingers.length,
          center: centerOf(part.mesh),
          palmNormal: a.spec.normal.toArray(),
          palmConfidence: a.palmConfidence,
          flip: false,
        });
        continue;
      }
    }
    // otherwise look at the far ends of this piece: arms end in hands
    const n = part.mesh.positions.length / 3;
    if (n < 200) continue;
    const graph = buildGraph(part.mesh);
    const argmax = (f: Float32Array) => {
      let b = -1, bv = -Infinity;
      for (let i = 0; i < f.length; i++)
        if (f[i] < Infinity && f[i] > bv) {
          bv = f[i];
          b = i;
        }
      return b;
    };
    let e = argmax(dijkstra(graph, [0]));
    if (e < 0) continue;
    const minD = new Float32Array(n).fill(Infinity);
    const taken = new Uint8Array(n);
    let span = 0;
    for (let it = 0; it < 8 && e >= 0; it++) {
      const d = dijkstra(graph, [e]);
      if (it === 0) span = d[argmax(d)];
      for (let v = 0; v < n; v++) if (d[v] < minD[v]) minD[v] = d[v];
      if (!taken[e]) {
        // Try the region within reach of this end: first a generous one (hand
        // and most of the forearm), then a tighter one (hand and wrist only).
        for (const fraction of [0.2, 0.13]) {
          const reach = fraction * span;
          const map = new Int32Array(n).fill(-1);
          const pos: number[] = [];
          let count = 0;
          for (let v = 0; v < n; v++) {
            if (d[v] > reach) continue;
            map[v] = count++;
            pos.push(part.mesh.positions[v * 3], part.mesh.positions[v * 3 + 1], part.mesh.positions[v * 3 + 2]);
          }
          const tris: number[] = [];
          const idx = part.mesh.indices;
          for (let t = 0; t < idx.length; t += 3) {
            const a = map[idx[t]], b = map[idx[t + 1]], c2 = map[idx[t + 2]];
            if (a >= 0 && b >= 0 && c2 >= 0) tris.push(a, b, c2);
          }
          if (count < 40 || tris.length < 60) continue;
          const crop: TriMesh = { positions: new Float32Array(pos), indices: new Uint32Array(tris) };
          const a = tryHand(crop);
          if (!a) continue;
          // keep the hand and a short cuff: cut straight across, a little below the wrist
          const w = a.spec.wrist, up = a.spec.up;
          const cuff = 0.35 * a.model.size;
          const inCrop = new Uint8Array(welded.mesh.positions.length / 3);
          const inWide = new Uint8Array(welded.mesh.positions.length / 3);
          const kept: number[] = [];
          for (let v = 0; v < n; v++) {
            if (map[v] < 0) continue;
            taken[v] = 1;
            inWide[part.toSource[v]] = 1;
            const px = part.mesh.positions[v * 3], py = part.mesh.positions[v * 3 + 1], pz = part.mesh.positions[v * 3 + 2];
            if ((px - w.x) * up.x + (py - w.y) * up.y + (pz - w.z) * up.z < -cuff) continue;
            inCrop[part.toSource[v]] = 1;
            kept.push(px, py, pz);
          }
          hands.push({
            keep: maskFromWelded((wv) => inCrop[wv] === 1),
            keepWide: maskFromWelded((wv) => inWide[wv] === 1),
            handedness: a.model.handedness,
            fingers: a.spec.fingers.length,
            center: centerOf({ positions: new Float32Array(kept), indices: new Uint32Array(0) }),
            palmNormal: a.spec.normal.toArray(),
            palmConfidence: a.palmConfidence,
            flip: false,
          });
          break;
        }
      }
      e = argmax(minD);
      if (e < 0 || minD[e] < 0.2 * span) break;
    }
  }

  // Note: two hands on one body are not always a left and a right. Characters
  // are often built with the same hand mesh turned round for the other side,
  // so each hand is reported as measured.
  if (hands.length) return { kind: 'character', hands };
  return {
    kind: 'none',
    hands,
    error:
      options.character || sizeable.length > 1 || /does not look like a single hand/.test(error ?? '')
        ? 'No open hand with separate fingers could be found in this model. Fists, mittens and fused fingers are not supported yet.'
        : error,
  };
}
