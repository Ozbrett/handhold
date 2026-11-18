import type { TriMesh } from '../trimesh';
import { surfaceNets } from './surfaceNets';

/**
 * The sample player's head. The skin is a simple, smooth sculpt (skull, jaw, brow, nose,
 * ears) made from signed distance shapes and meshed with surface nets. The features that
 * need crisp edges (hair, eyebrows, eyes, lips) are thin layers that follow that surface,
 * meshed on a much finer grid, one mesh per colour.
 *
 * In the character's own space, metres: the chin is near y = 1.57, the crown near
 * y = 1.79, and the face looks along +Z.
 */
export interface ProceduralHead {
  skin: TriMesh;
  /** Hair, eyebrows, lash lines, irises and the line of the mouth. */
  dark: TriMesh;
  /** The whites of the eyes. */
  white: TriMesh;
  lips: TriMesh;
}

type V3 = [number, number, number];

const sph = (x: number, y: number, z: number, c: V3, r: number) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;

/** A close approximation of the distance to an ellipsoid. */
function ell(x: number, y: number, z: number, c: V3, r: V3): number {
  const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(r[0], r[1], r[2]);
}

/** A capsule from `a` to `b` whose radius goes from `ra` to `rb`. */
function cap(x: number, y: number, z: number, a: V3, b: V3, ra: number, rb = ra): number {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const px = x - a[0], py = y - a[1], pz = z - a[2];
  let h = (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  return Math.hypot(px - bx * h, py - by * h, pz - bz * h) - (ra + (rb - ra) * h);
}

/** Smooth union and smooth intersection: `k` is how wide the blend is. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

/** 0 at `from`, 1 at `to`, eased at both ends. */
function ramp(v: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (v - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

// where the features sit
const EYE_X = 0.0315;
const EYE_Y = 1.678;
const MOUTH_Y = 1.619;

/** The head with no features: skull, face, jaw and chin. */
function blank(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = ell(x, y, z, [0, 1.703, -0.011], [0.0745, 0.0865, 0.093]);
  d = smin(d, ell(x, y, z, [0, 1.654, 0.017], [0.0575, 0.079, 0.0705]), 0.03);
  // the jaw, from under the ear to the chin
  d = smin(d, cap(ax, y, z, [0.009, 1.5945, 0.05], [0.032, 1.63, -0.004], 0.0195, 0.0205), 0.03);
  d = smin(d, ell(x, y, z, [0, 1.593, 0.052], [0.026, 0.0225, 0.025]), 0.03);
  return d;
}

/** How far forward the blank head's face reaches at (x, y). */
function faceZ(x: number, y: number): number {
  let lo = 0.02, hi = 0.16;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (blank(x, y, mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function createProceduralHead(): ProceduralHead {
  // features are placed on the blank face, so they stay on the surface whatever its shape
  const zBrow = faceZ(0.006, 1.6955), zBrowEnd = faceZ(0.046, 1.694);
  const zCheek = faceZ(0.044, 1.659);
  const zEye = faceZ(EYE_X, EYE_Y);
  const zBridge = faceZ(0, 1.69), zTip = faceZ(0, 1.652);
  const zWing = faceZ(0.0105, 1.648);
  const zLip = faceZ(0, MOUTH_Y);

  /** The head without ears (the hair and the painted features follow this one). */
  const bare = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    let d = blank(x, y, z);
    // brow ridge and cheekbones, both gentle
    d = smin(d, cap(ax, y, z, [0.006, 1.6955, zBrow - 0.0075], [0.046, 1.694, zBrowEnd - 0.0085], 0.0098, 0.0085), 0.018);
    d = smin(d, sph(ax, y, z, [0.044, 1.66, zCheek - 0.0165], 0.0185), 0.032);
    // the eyes sit in shallow hollows under the brow, on a slight swell for the eyeball
    d = smax(d, -ell(ax, y, z, [EYE_X + 0.001, EYE_Y + 0.0015, zEye + 0.0122], [0.0205, 0.014, 0.0155]), 0.012);
    d = smin(d, ell(ax, y, z, [EYE_X, EYE_Y, zEye - 0.0118], [0.0135, 0.0105, 0.0115]), 0.008);
    // nose: bridge, tip and wings
    d = smin(d, cap(x, y, z, [0, 1.6915, zBridge - 0.0035], [0, 1.655, zTip + 0.011], 0.0062, 0.0084), 0.015);
    d = smin(d, sph(x, y, z, [0, 1.6525, zTip + 0.012], 0.009), 0.008);
    d = smin(d, sph(ax, y, z, [0.0098, 1.649, zWing + 0.002], 0.0066), 0.008);
    // a soft swell for the mouth, and the dip under the lower lip
    d = smin(d, ell(x, y, z, [0, MOUTH_Y, zLip - 0.0062], [0.027, 0.012, 0.009]), 0.02);
    d = smax(d, -ell(x, y, z, [0, 1.6035, zLip + 0.012], [0.015, 0.006, 0.009]), 0.01);
    return d;
  };

  /** An ear: a tilted disc with a hollow and a lobe, standing a little off the head at the back. */
  const ear = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    // lean the top of the ear back a little
    const dy = y - 1.669, dz = z + 0.013;
    const c = Math.cos(0.2), s = Math.sin(0.2);
    const ry = dy * c - dz * s, rz = dy * s + dz * c;
    // and swing the back of it away from the head
    const lx = ax - 0.073 - Math.max(0, 0.005 - rz) * 0.42;
    let d = ell(lx, ry, rz, [0, 0, 0], [0.0056, 0.0265, 0.0148]);
    d = smin(d, ell(lx, ry, rz, [-0.001, -0.0225, 0.0035], [0.005, 0.0082, 0.0072]), 0.007);
    d = smax(d, -ell(lx, ry, rz, [0.0064, 0.004, 0.001], [0.0046, 0.0155, 0.0072]), 0.004);
    return d;
  };

  const skinSdf = (x: number, y: number, z: number) => smin(bare(x, y, z), ear(x, y, z), 0.006);

  // ---- thin layers that follow the surface: drawn on the plane of the face, raised a little off the skin
  const front = (z: number) => 0.045 - z;
  /** Positive outside the eye's almond-shaped opening. */
  const almond = (ax: number, y: number, grow = 0): number => {
    const u = (ax - EYE_X) / (0.015 + grow);
    const half = 1 - u * u;
    if (half <= 0) return 1;
    // the upper lid arches more than the lower one, and the outer corner sits a touch higher
    const mid = EYE_Y + 0.0004 + 0.001 * u;
    const top = mid + (0.006 + grow) * Math.pow(half, 0.75), bottom = mid - (0.0042 + grow) * Math.sqrt(half);
    return Math.max(y - top, bottom - y);
  };
  /** The line between the lips: it lifts a little towards the corners. */
  const mouthLine = (ax: number) => MOUTH_Y + 0.0002 + 0.0014 * (ax / 0.023) ** 2;
  /** Positive outside the lips. */
  const lipShape = (ax: number, y: number): number => {
    const u = ax / 0.023;
    const half = 1 - u * u;
    if (half <= 0) return 1;
    const mid = mouthLine(ax);
    // the upper lip dips in the middle; the lower one is fuller
    const top = mid + 0.005 * Math.pow(half, 0.85) - 0.0014 * Math.exp(-((ax / 0.004) ** 2));
    const bottom = mid - 0.0064 * Math.pow(half, 0.6);
    return Math.max(y - top, bottom - y);
  };

  /** A layer on the skin inside a flat `shape`; the skin is only sampled close to the shape. */
  const near = (shape: number, layer: () => number) => (shape > 0.003 ? shape : Math.max(layer(), shape));
  const white = (x: number, y: number, z: number): number => near(almond(Math.abs(x), y), () => Math.max(bare(x, y, z) - 0.0016, front(z)));
  const lips = (x: number, y: number, z: number): number => near(lipShape(Math.abs(x), y), () => Math.max(bare(x, y, z) - 0.0014, front(z)));

  /** Where hair grows: negative inside. */
  const hairline = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    // straight across the forehead (a little higher at the temples), round the corner,
    // over the ear, then down behind it to the nape
    const line =
      1.7385 + 0.0045 * Math.exp(-(((ax - 0.036) / 0.013) ** 2)) - 0.036 * ramp(z, 0.056, 0.024) - 0.084 * ramp(z, -0.03, -0.084);
    // sideburns in front of the ears
    const burn = cap(ax, y, z, [0.0715, 1.704, 0.014], [0.0705, 1.676, 0.012], 0.009, 0.004);
    return smin(line - y, burn, 0.006);
  };
  const hair = (x: number, y: number, z: number): number => {
    const edge = hairline(x, y, z);
    if (edge > 0.02) return edge;
    const head = bare(x, y, z);
    // short hair: thin where it starts, fuller on top, brushed forward and a little to one side
    let d = head - (0.003 + 0.0027 * ramp(-edge, 0, 0.03));
    d = smin(d, ell(x, y, z, [0.002, 1.742, -0.01], [0.073, 0.058, 0.092]), 0.012);
    d = smin(d, ell(x, y, z, [0.01, 1.759, 0.034], [0.05, 0.021, 0.036]), 0.012);
    // broad furrows from the crown, so it reads as brushed hair and not a cap
    const round = Math.atan2(x - 0.006, z + 0.03);
    d += 0.0012 * Math.sin(round * 17 + 28 * (y - 1.7));
    return smax(d, edge, 0.006);
  };

  /** Eyebrows, irises, lash lines and the line of the mouth. */
  const features = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    let flat = 1;
    // eyebrows: fullest near the nose, arching up and tapering out
    const along = (ax - 0.0105) / 0.0345;
    if (along > 0 && along < 1) {
      const line = 1.6925 + 0.0048 * Math.sin(along * 2) - 0.003 * along * along;
      flat = Math.abs(y - line) - 0.0027 * (1 - 0.7 * along * along);
    }
    // irises, looking straight ahead, tucked under the upper lid
    const eye = almond(ax, y);
    flat = Math.min(flat, Math.max(Math.hypot(ax - EYE_X, y - (EYE_Y + 0.0008)) - 0.0055, eye));
    // the lash line along the upper lid
    flat = Math.min(flat, Math.max(almond(ax, y, 0.0016), -eye, EYE_Y + 0.0012 - y));
    // the line between the lips
    if (ax < 0.019) flat = Math.min(flat, Math.abs(y - mouthLine(ax)) - 0.0007 * (1 - (ax / 0.019) ** 2) - 0.0002);
    if (flat > 0.003) return flat;
    return Math.max(bare(x, y, z) - 0.0023, flat, front(z));
  };
  const skin = smooth(surfaceNets(skinSdf, [-0.1, 1.535, -0.12], [0.1, 1.802, 0.125], 0.0026), 4);
  // the hair is coarse; the brows, eyes and mouth are small, so they get a much finer grid
  const locks = smooth(surfaceNets(hair, [-0.1, 1.6, -0.125], [0.1, 1.815, 0.13], 0.0026), 2);
  const fine = 0.0008;
  return {
    skin,
    dark: join(locks, surfaceNets(features, [-0.05, 1.612, 0.045], [0.05, 1.704, 0.116], fine)),
    white: surfaceNets(white, [-0.052, 1.668, 0.05], [0.052, 1.69, 0.115], fine),
    lips: surfaceNets(lips, [-0.03, 1.606, 0.05], [0.03, 1.63, 0.118], fine),
  };
}

/**
 * Taubin smoothing: evens out the small steps surface nets leaves behind without
 * shrinking the shape (a shrinking pass followed by a slightly larger growing one).
 */
function smooth(mesh: TriMesh, passes: number): TriMesh {
  const n = mesh.positions.length / 3;
  const near: number[][] = Array.from({ length: n }, () => []);
  const link = (a: number, b: number) => {
    if (!near[a].includes(b)) near[a].push(b);
  };
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    link(a, b), link(b, a), link(b, c), link(c, b), link(c, a), link(a, c);
  }
  let p = mesh.positions.slice();
  const step = (amount: number) => {
    const q = new Float32Array(p.length);
    for (let i = 0; i < n; i++) {
      const list = near[i];
      if (!list.length) {
        q.set(p.subarray(i * 3, i * 3 + 3), i * 3);
        continue;
      }
      for (let a = 0; a < 3; a++) {
        let sum = 0;
        for (const j of list) sum += p[j * 3 + a];
        q[i * 3 + a] = p[i * 3 + a] + amount * (sum / list.length - p[i * 3 + a]);
      }
    }
    p = q;
  };
  for (let k = 0; k < passes; k++) {
    step(0.5);
    step(-0.53);
  }
  return { positions: p, indices: mesh.indices };
}

function join(...meshes: TriMesh[]): TriMesh {
  const positions = new Float32Array(meshes.reduce((n, m) => n + m.positions.length, 0));
  const indices = new Uint32Array(meshes.reduce((n, m) => n + m.indices.length, 0));
  let p = 0, i = 0;
  for (const m of meshes) {
    positions.set(m.positions, p);
    for (let k = 0; k < m.indices.length; k++) indices[i + k] = m.indices[k] + p / 3;
    p += m.positions.length;
    i += m.indices.length;
  }
  return { positions, indices };
}
