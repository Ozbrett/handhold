import { type Bone, Quaternion, type SkinnedMesh, Vector3 } from 'three';

/**
 * Looking at a whole character's skin at the wrists, in the app: which part of each mesh follows the hand, and how the wrist bends
 * when the hand rolls or bends. The same picture Rig Doctor (blender/rig_doctor.py) renders headless, so what the app shows and what
 * Claude checks agree.
 */

export interface ArmBones {
  upper: Bone;
  fore: Bone;
  hand: Bone;
}

const kids = (b: Bone) => b.children.filter((c): c is Bone => (c as Bone).isBone === true);
const count = (b: Bone): number => kids(b).reduce((n, c) => n + 1 + count(c), 0);

/** The bone an arm carries on through below `b` (not a twist or helper bone): the child with the most bones under it. */
export function mainChild(b: Bone): Bone | null {
  let best: Bone | null = null, most = -1;
  for (const c of kids(b)) {
    const n = count(c);
    if (n > most) { best = c; most = n; }
  }
  return best;
}

function subtree(b: Bone, into = new Set<Bone>()): Set<Bone> {
  into.add(b);
  for (const c of kids(b)) subtree(c, into);
  return into;
}

/** Colours, red for the hand and fingers, blue for the forearm, pale blue for the upper arm, grey for the rest of the body. */
export const FOLLOW_COLOURS = {
  hand: [0.86, 0.22, 0.16],
  fore: [0.2, 0.42, 0.9],
  upper: [0.55, 0.7, 0.95],
  body: [0.42, 0.42, 0.42],
} as const;

/**
 * One colour per vertex of `mesh` (rgb, 0 to 1), mixed by the vertex's weights: red where it follows a hand, blue where it stays
 * with the forearm. A sleeve cuff that is red turns with the wrist; a glove red to the end of the sleeve and blue under it turns
 * cleanly.
 */
export function followColours(mesh: SkinnedMesh, arms: ArmBones[]): Float32Array {
  const role = new Map<Bone, keyof typeof FOLLOW_COLOURS>();
  for (const a of arms) {
    role.set(a.upper, 'upper');
    role.set(a.fore, 'fore');
    for (const b of subtree(a.hand)) role.set(b, 'hand');
  }
  const g = mesh.geometry;
  const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
  const bones = mesh.skeleton?.bones ?? [];
  const out = new Float32Array((si?.count ?? 0) * 3);
  if (!si || !sw) return out;
  for (let i = 0; i < si.count; i++) {
    let r = 0, gg = 0, b = 0, total = 0;
    for (let k = 0; k < si.itemSize; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      const c = FOLLOW_COLOURS[role.get(bones[si.getComponent(i, k)]) ?? 'body'];
      r += c[0] * w; gg += c[1] * w; b += c[2] * w; total += w;
    }
    const t = total > 0 ? 1 / total : 0;
    out[i * 3] = r * t; out[i * 3 + 1] = gg * t; out[i * 3 + 2] = b * t;
  }
  return out;
}

/**
 * Turns the hand on its forearm, on top of whatever pose it has: `roll` degrees about the forearm's own line, then `bend` degrees
 * across it (toward the palm for plus, as far as the rig's own axes say which way the palm is). The forearm does not move, so the
 * skin between them shows exactly what the weights do.
 */
export function turnWrist(arm: ArmBones, roll: number, bend: number) {
  if (!roll && !bend) return;
  arm.hand.updateWorldMatrix(true, false);
  const wrist = arm.hand.getWorldPosition(new Vector3());
  const elbow = arm.fore.getWorldPosition(new Vector3());
  const along = wrist.clone().sub(elbow);
  if (along.lengthSq() < 1e-12) return;
  along.normalize();
  const world = arm.hand.getWorldQuaternion(new Quaternion());
  // the bend's axis: the hand's own x, kept square to the forearm (a hinge across the wrist)
  const across = new Vector3(1, 0, 0).applyQuaternion(world).projectOnVector(along).negate()
    .add(new Vector3(1, 0, 0).applyQuaternion(world));
  if (across.lengthSq() < 1e-8) across.set(0, 1, 0).cross(along);
  across.normalize();
  const turn = new Quaternion().setFromAxisAngle(across, (bend * Math.PI) / 180)
    .multiply(new Quaternion().setFromAxisAngle(along, (roll * Math.PI) / 180));
  const parent = arm.hand.parent ? arm.hand.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
  arm.hand.quaternion.copy(parent.invert().multiply(turn.multiply(world)));
  arm.hand.updateMatrixWorld(true);
}
