import type { Bone, SkinnedMesh } from 'three';
import { type AnalyzeOptions, type HandAnalysis, analyzeHandMesh } from '../core/hand/analyze';
import { type CharacterRig, buildCharacterRig } from './characterRig';
import type { Baked } from './loaders';

/**
 * A character's hand is solved, cleared and drawn on its own skeleton and its own weights.
 *
 * The solver rigs the hand it finds with joints it places itself and skin weights it works out itself. On a character that has
 * bones of its own, the export turns the character's bones instead, and the game skins them with the character's weights: the
 * two hands bend about different points with different weights, so the drawn hand (and every contact, depth and "holds" read
 * off it) differed from what the game draws by up to 3 cm at a fingertip. Here the solver's joints are put on the character's
 * own bone pivots and the drawn hand takes the character's own weights, joint for bone, so both skin the same way and a pose
 * shown is the pose exported.
 */

type Joints = NonNullable<AnalyzeOptions['joints']>;

const depthOf = (b: Bone) => {
  let d = 0;
  for (let p = b.parent; p; p = p.parent) d++;
  return d;
};

/** Where the character's own finger bones pivot at rest, finger by finger, for the joints the solver's hand has. */
export function bonePivots(char: CharacterRig, analysis: HandAnalysis): Joints {
  const model = analysis.model;
  const out: Joints = {};
  for (const f of model.fingers) {
    // the character's bones of this finger, knuckle first: the solver's own joints may sit a segment off, so the chain is
    // taken by its order along the finger, not by which solved segment each bone's middle falls in
    const chain = char.bones
      .map((b, i) => ({ b, i, depth: depthOf(b) }))
      .filter(({ i }) => f.joints.includes(char.jointOf[i]))
      .sort((a, b) => a.depth - b.depth);
    // only a single chain (each bone the parent of the next) is a finger
    const ok = chain.every((c, k) => k === 0 || c.b.parent === chain[k - 1].b);
    if (!ok || chain.length < f.joints.length) continue;
    out[f.name] = chain.slice(0, f.joints.length).map(({ i }) => char.restHead[i].toArray() as [number, number, number]);
  }
  return out;
}

/**
 * Gives each bone of a finger the solved joint it now pivots on, by its place along the finger (the k-th bone is the k-th joint,
 * bones past the last joint go with it), and aims it at the next one. Matching a bone by where its middle falls is ambiguous
 * once the joints sit exactly on the pivots: a last bone with no child has its middle on its own pivot, the boundary between
 * two segments, and was given the segment before, so its skin did not bend at the last knuckle.
 */
function followChains(char: CharacterRig, before: CharacterRig, analysis: HandAnalysis) {
  const model = analysis.model;
  const byFinger = new Map<number, number[]>();
  // which finger each bone was in before the joints moved: the finger is never in doubt, only the segment
  const fingerOfJoint = new Map<number, number>();
  model.fingers.forEach((f, fi) => f.joints.forEach((j) => fingerOfJoint.set(j, fi)));
  char.bones.forEach((b, i) => {
    const bi = before.bones.indexOf(b);
    const j = bi >= 0 ? before.jointOf[bi] : char.jointOf[i];
    const fi = fingerOfJoint.get(j);
    if (fi === undefined || j === 0) return;
    (byFinger.get(fi) ?? byFinger.set(fi, []).get(fi)!).push(i);
  });
  for (const [fi, list] of byFinger) {
    const f = model.fingers[fi];
    list.sort((a, b) => depthOf(char.bones[a]) - depthOf(char.bones[b]));
    list.forEach((i, k) => {
      char.jointOf[i] = f.joints[Math.min(k, f.joints.length - 1)];
    });
    list.forEach((i, k) => {
      const next = list[k + 1];
      if (next !== undefined && k + 1 < f.joints.length && char.restHead[next].distanceTo(char.restHead[i]) > 0.03 * model.size) {
        char.aim[i] = { point: char.restHead[next].clone(), joint: f.joints[k + 1] };
      } else if (k >= f.joints.length - 1 && f.tip.distanceTo(char.restHead[i]) >= 0.05 * model.size) {
        char.aim[i] = { point: f.tip.clone(), joint: f.joints[f.joints.length - 1] };
      } else char.aim[i] = null;
    });
  }
}

const restKey =(x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;

/**
 * Replaces the analysis's skin weights with the character's own, mapped bone to joint (a bone the solver does not move, such as
 * the forearm, counts as the wrist). Vertices are found in the character by their rest position. Returns how many were matched.
 */
export function useOwnWeights(analysis: HandAnalysis, baked: Baked, full: Baked, char: CharacterRig): number {
  const where = new Map<string, { mesh: SkinnedMesh; i: number }>();
  for (const part of full.parts) {
    const mesh = part.mesh as unknown as SkinnedMesh;
    if (!mesh.isSkinnedMesh) continue;
    const P = full.mesh.positions;
    for (let i = 0; i < part.count; i++) {
      const v = (part.start + i) * 3;
      where.set(restKey(P[v], P[v + 1], P[v + 2]), { mesh, i });
    }
  }
  const jointOfBone = new Map<Bone, number>();
  char.bones.forEach((b, i) => jointOfBone.set(b, char.jointOf[i]));
  const P = baked.mesh.positions;
  const n = P.length / 3;
  let matched = 0;
  const acc = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    const hit = where.get(restKey(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]));
    if (!hit) continue;
    const g = hit.mesh.geometry;
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!si || !sw) continue;
    acc.clear();
    let total = 0;
    for (let k = 0; k < si.itemSize; k++) {
      const w = sw.getComponent(hit.i, k);
      if (w <= 0) continue;
      const bone = hit.mesh.skeleton.bones[si.getComponent(hit.i, k)];
      const j = (bone && jointOfBone.get(bone)) ?? 0;
      acc.set(j, (acc.get(j) ?? 0) + w);
      total += w;
    }
    if (!(total > 0)) continue;
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0);
    for (let k = 0; k < 4; k++) {
      analysis.skinIndices[v * 4 + k] = top[k]?.[0] ?? 0;
      analysis.skinWeights[v * 4 + k] = top[k] ? top[k][1] / sum : 0;
    }
    matched++;
  }
  return matched;
}

/**
 * Analyses a character's hand again with its joints on the character's own bone pivots (joints edited by hand still win), maps
 * it to the character's bones and gives it the character's weights. Returns the plain analysis and rig when the character has no
 * finger bones of its own, or when the hand cannot be analysed on them.
 */
export function onOwnSkeleton(
  source: Parameters<typeof buildCharacterRig>[0],
  full: Baked,
  subset: Uint8Array | null,
  baked: Baked,
  analysis: HandAnalysis,
  options: AnalyzeOptions,
): { analysis: HandAnalysis; char: CharacterRig | null; pivots: Joints | null } {
  const first = buildCharacterRig(source, full, subset, analysis);
  if (!first) return { analysis, char: null, pivots: null };
  const pivots = bonePivots(first, analysis);
  if (!Object.keys(pivots).length) return { analysis, char: first, pivots: null };
  let again: HandAnalysis;
  try {
    again = analyzeHandMesh(baked.mesh, { ...options, joints: { ...pivots, ...(options.joints ?? {}) } });
  } catch {
    return { analysis, char: first, pivots: null };
  }
  if (again.model.fingers.length < analysis.model.fingers.length) return { analysis, char: first, pivots: null };
  const char = buildCharacterRig(source, full, subset, again);
  if (!char) return { analysis, char: first, pivots: null };
  followChains(char, first, again);
  useOwnWeights(again, baked, full, char);
  return { analysis: again, char, pivots };
}
