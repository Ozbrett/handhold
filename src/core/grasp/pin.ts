import { Matrix4, Vector3 } from 'three';
import { type HandModel, poseMatrices } from '../hand/model';

/**
 * Bends one finger so its tip lands on a chosen spot, leaving the rest of the
 * hand as it is. Used for things like a finger on a trigger or a thumb on a
 * button. `target` is in the hand's rest space (the grip's wrist transform
 * already undone). Returns the new angles and how far short the tip still is.
 */
export function reachFingertip(
  model: HandModel,
  angles: ArrayLike<number>,
  finger: number,
  target: Vector3,
): { angles: Float32Array; miss: number } {
  const f = model.fingers[finger];
  const dofs: { index: number; min: number; max: number }[] = [];
  for (const j of f.joints) {
    const joint = model.joints[j];
    joint.dofs.forEach((d, k) => dofs.push({ index: joint.dofStart + k, min: d.min, max: d.max }));
  }
  const distal = f.joints[f.joints.length - 1];
  const mats = model.joints.map(() => new Matrix4());
  const tip = new Vector3();
  const miss = (a: Float32Array) => {
    poseMatrices(model, a, mats);
    return tip.copy(f.tip).applyMatrix4(mats[distal]).distanceTo(target);
  };

  let best = Float32Array.from(angles);
  let bestMiss = miss(best);
  // start from the grip itself, from an open finger and from a half-curled one, and keep the best
  for (const seed of [-1, 0, 0.5]) {
    const a = Float32Array.from(angles);
    if (seed >= 0) for (const d of dofs) a[d.index] = d.min + (d.max - d.min) * (seed === 0 ? 0.15 : 0.5);
    let cur = miss(a);
    let step = 0.35;
    for (let iter = 0; iter < 80 && step > 0.002; iter++) {
      let improved = false;
      for (const d of dofs) {
        for (const dir of [1, -1]) {
          const old = a[d.index];
          const next = Math.min(d.max, Math.max(d.min, old + dir * step));
          if (next === old) continue;
          a[d.index] = next;
          const m = miss(a);
          if (m < cur - 1e-9) {
            cur = m;
            improved = true;
          } else a[d.index] = old;
        }
      }
      if (!improved) step *= 0.6;
    }
    if (cur < bestMiss) {
      bestMiss = cur;
      best = a;
    }
  }
  return { angles: best, miss: bestMiss };
}
