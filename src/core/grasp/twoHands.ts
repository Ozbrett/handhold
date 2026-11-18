import { Vector3 } from 'three';
import type { HandModel } from '../hand/model';
import type { GraspObject } from './object';
import { graspSpheres } from './pose';
import { graspQuality } from './quality';
import type { Grasp } from './solver';

/** One grip for each hand on the same object, checked together. */
export interface TwoHandGrasp {
  /** The main hand (the one the object is carried by). */
  a: Grasp;
  /** The second (support) hand. */
  b: Grasp;
  /** Can both hands together hold the weight? */
  stable: boolean;
  /** Grip force both hands need together, in multiples of the weight. */
  effort: number;
  robustness: number;
  /** Deepest the two hands sink into each other, in metres (0 if they do not touch). */
  overlap: number;
  /** Extra cost from the caller (for example: the second arm cannot reach). */
  penalty: number;
  score: number;
}

export interface PairOptions {
  gravity?: Vector3;
  friction?: number;
  mode?: 'fixed' | 'any';
  maxResults?: number;
  /** 0 when this pair is fine, larger when worse (unreachable, strained). Pairs above 1 are dropped. */
  penalty?: (a: Grasp, b: Grasp) => number;
}

/** How deep any sphere of one hand sinks into any sphere of the other. */
export function handOverlap(modelA: HandModel, a: Grasp, modelB: HandModel, b: Grasp): number {
  const sa = graspSpheres(modelA, a), sb = graspSpheres(modelB, b);
  let worst = 0;
  for (const p of sa)
    for (const q of sb) {
      const d = p.radius + q.radius - p.center.distanceTo(q.center);
      if (d > worst) worst = d;
    }
  return worst;
}

/**
 * Pairs grips of two hands found separately (each around its own grip
 * point) into two-handed grips. Pairs whose hands run into each other are
 * dropped; the rest are checked physically with both hands' contacts at
 * once, so a hand that only cradles the object counts when the other one
 * holds it. Best first, stable before unstable.
 */
export function pairGrasps(
  modelA: HandModel,
  graspsA: Grasp[],
  modelB: HandModel,
  graspsB: Grasp[],
  object: GraspObject,
  options: PairOptions = {},
): TwoHandGrasp[] {
  const gravity = (options.gravity ?? new Vector3(0, -1, 0)).clone().normalize();
  const size = Math.max(modelA.size, modelB.size);
  // two hands can push and pull at either end of a long object, so torques use the object's own length
  const lever = Math.min(Math.max(object.radius, 0.1 * size), 2 * size);
  const allowed = 0.02 * size;
  const out: TwoHandGrasp[] = [];
  for (const a of graspsA)
    for (const b of graspsB) {
      const overlap = handOverlap(modelA, a, modelB, b);
      if (overlap > allowed) continue;
      const penalty = options.penalty?.(a, b) ?? 0;
      if (penalty > 1) continue;
      const q = graspQuality([...a.contacts, ...b.contacts], {
        friction: options.friction ?? 0.6,
        gravity,
        com: object.com,
        lever,
        mode: options.mode ?? 'fixed',
      });
      if (q.stable && q.effort > 12) q.stable = false;
      const hold = q.stable ? Math.min(1, Math.max(0.05, 1 - (q.effort - 1) / 6)) : 0;
      const score = 0.3 * hold + 0.3 * q.robustness + 0.2 * a.score + 0.2 * b.score - 0.5 * penalty;
      out.push({ a, b, stable: q.stable, effort: q.effort, robustness: q.robustness, overlap: Math.max(0, overlap), penalty, score });
    }
  out.sort((x, y) => Number(y.stable) - Number(x.stable) || y.score - x.score);
  // keep the list varied: a different main-hand grip for each result first, then the best of the rest
  const max = options.maxResults ?? 5;
  const picked: TwoHandGrasp[] = [];
  const seen = new Set<Grasp>();
  for (const p of out) if (picked.length < max && !seen.has(p.a)) (picked.push(p), seen.add(p.a));
  for (const p of out) if (picked.length < max && !picked.includes(p)) picked.push(p);
  return picked.sort((x, y) => Number(y.stable) - Number(x.stable) || y.score - x.score);
}
