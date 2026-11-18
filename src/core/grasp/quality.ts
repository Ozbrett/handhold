import { Vector3 } from 'three';
import { solveLP } from './lp';

/** A point where the hand touches the object. */
export interface Contact {
  point: Vector3;
  /** Unit normal pointing out of the object, towards the hand. */
  normal: Vector3;
  /** Finger index, -1 for the palm. */
  finger: number;
  link: number;
}

export interface QualityOptions {
  /** Coefficient of friction between skin and object. */
  friction: number;
  /** Unit direction of gravity. */
  gravity: Vector3;
  /** Object's centre of mass. */
  com: Vector3;
  /** Length that converts torques into comparable forces (roughly the object's radius). */
  lever: number;
  /** 'fixed': the object keeps this way up. 'any': it gets swung around, so it must hold in every direction. */
  mode: 'fixed' | 'any';
}

export interface Quality {
  /** Can the contacts hold the object's weight at all? */
  stable: boolean;
  /**
   * Total grip force needed to hold the weight, in multiples of the weight.
   * 1 means the hand simply carries it; larger means it has to squeeze.
   */
  effort: number;
  /** 0..1, how well the grip also resists being bumped and twisted. */
  robustness: number;
}

const CONE_EDGES = 6;
const AXES = [
  new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0), new Vector3(0, -1, 0),
  new Vector3(0, 0, 1), new Vector3(0, 0, -1),
];

/**
 * Physical check of a grip. Every contact can push on the object anywhere
 * inside its friction cone; a linear program finds the smallest total force
 * that balances gravity (and then gravity plus a set of bumps and twists).
 * Supporting the object from below or wrapping around it needs little force,
 * pinching it from the sides needs a lot, and some grips cannot hold at all.
 */
export function graspQuality(contacts: Contact[], opt: QualityOptions): Quality {
  const nc = contacts.length;
  if (nc === 0) return { stable: false, effort: Infinity, robustness: 0 };
  // per contact: the cone's edges plus its axis (a plain push with no friction)
  const per = CONE_EDGES + 1;
  const n = nc * per;
  const A = new Float64Array(6 * n);
  const cost = new Float64Array(n).fill(1);
  const t1 = new Vector3(), t2 = new Vector3(), d = new Vector3(), arm = new Vector3(), tau = new Vector3();
  for (let i = 0; i < nc; i++) {
    const c = contacts[i];
    // tangent basis
    if (Math.abs(c.normal.x) < 0.9) t1.set(1, 0, 0);
    else t1.set(0, 1, 0);
    t1.addScaledVector(c.normal, -t1.dot(c.normal)).normalize();
    t2.crossVectors(c.normal, t1);
    arm.subVectors(c.point, opt.com);
    for (let k = 0; k < per; k++) {
      d.copy(c.normal).negate();
      if (k < CONE_EDGES) {
        const phi = (k / CONE_EDGES) * Math.PI * 2;
        d.addScaledVector(t1, opt.friction * Math.cos(phi))
          .addScaledVector(t2, opt.friction * Math.sin(phi))
          .normalize();
      }
      tau.crossVectors(arm, d).multiplyScalar(1 / opt.lever);
      const col = i * per + k;
      A[0 * n + col] = d.x;
      A[1 * n + col] = d.y;
      A[2 * n + col] = d.z;
      A[3 * n + col] = tau.x;
      A[4 * n + col] = tau.y;
      A[5 * n + col] = tau.z;
    }
  }
  const b = new Float64Array(6);
  // how efficiently an external wrench (force f, torque t/lever) is resisted:
  // load / grip force in 0..1, or 0 if these contacts cannot resist it at all
  const resist = (fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): number => {
    b[0] = -fx;
    b[1] = -fy;
    b[2] = -fz;
    b[3] = -tx;
    b[4] = -ty;
    b[5] = -tz;
    const r = solveLP(A, b, cost, 6, n);
    if (!r.feasible || !(r.value > 0)) return 0;
    return Math.min(1, Math.hypot(fx, fy, fz, tx, ty, tz) / r.value);
  };

  // Robustness: turn the object any way up, and twist it about any axis.
  // Being able to resist at all counts most; doing it without a hard squeeze counts a little more.
  const pulls = AXES.map((a) => resist(a.x, a.y, a.z, 0, 0, 0));
  let robust = 0;
  for (const q of pulls) robust += q > 0 ? 0.5 + 0.5 * q : 0;
  for (const a of AXES) {
    const q = resist(0, 0, 0, a.x * 0.5, a.y * 0.5, a.z * 0.5);
    robust += q > 0 ? 0.5 + 0.5 * q : 0;
  }
  robust /= 12;

  if (opt.mode === 'any') {
    // must carry its weight whichever way it is turned
    let worst = 1, sum = 0;
    for (const q of pulls) {
      worst = Math.min(worst, q);
      sum += q;
    }
    return { stable: worst > 0, effort: worst > 0 ? 6 / sum : Infinity, robustness: worst > 0 ? robust : 0 };
  }

  const g = opt.gravity;
  const hold = resist(g.x, g.y, g.z, 0, 0, 0);
  if (hold <= 0) return { stable: false, effort: Infinity, robustness: 0 };
  return { stable: true, effort: 1 / hold, robustness: robust };
}
