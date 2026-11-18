import { Matrix4, Quaternion, Vector3 } from 'three';

export interface PointFit {
  /** Maps a `from` point onto its `to` point: to ≈ scale · rotation · from + translation. */
  rotation: Quaternion;
  translation: Vector3;
  /** Best uniform scale between the two sets (reported, not applied by `matrix`). */
  scale: number;
  /** Root-mean-square distance left between the moved `from` points and the `to` points, with the scale applied. */
  rms: number;
  /** The rigid part (rotation and translation for scale 1) as a matrix. */
  matrix: Matrix4;
}

/**
 * The turn and shift that best lay one set of points onto another (Horn's quaternion method, least squares), with the
 * uniform scale between them. Needs at least three points not on one line.
 */
export function fitPoints(from: Vector3[], to: Vector3[]): PointFit | null {
  const n = Math.min(from.length, to.length);
  if (n < 3) return null;
  const cf = new Vector3(), ct = new Vector3();
  for (let i = 0; i < n; i++) {
    cf.add(from[i]);
    ct.add(to[i]);
  }
  cf.divideScalar(n);
  ct.divideScalar(n);
  // cross-covariance
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  const a = new Vector3(), b = new Vector3();
  for (let i = 0; i < n; i++) {
    a.subVectors(from[i], cf);
    b.subVectors(to[i], ct);
    sxx += a.x * b.x; sxy += a.x * b.y; sxz += a.x * b.z;
    syx += a.y * b.x; syy += a.y * b.y; syz += a.y * b.z;
    szx += a.z * b.x; szy += a.z * b.y; szz += a.z * b.z;
  }
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const v = largestEigenvector(N);
  const rotation = new Quaternion(v[1], v[2], v[3], v[0]).normalize();
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    a.subVectors(from[i], cf).applyQuaternion(rotation);
    b.subVectors(to[i], ct);
    num += a.dot(b);
    den += a.lengthSq();
  }
  const scale = den > 0 ? num / den : 1;
  let err = 0;
  for (let i = 0; i < n; i++) {
    a.subVectors(from[i], cf).applyQuaternion(rotation).multiplyScalar(scale).add(ct);
    err += a.distanceToSquared(to[i]);
  }
  const translation = ct.clone().sub(cf.clone().applyQuaternion(rotation));
  const matrix = new Matrix4().makeRotationFromQuaternion(rotation).setPosition(translation);
  return { rotation, translation, scale, rms: Math.sqrt(err / n), matrix };
}

/** The eigenvector of a symmetric 4x4 matrix with the largest eigenvalue (cyclic Jacobi). */
function largestEigenvector(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++)
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (a[k][k] > a[best][best]) best = k;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}
