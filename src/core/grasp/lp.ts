/**
 * Small dense two-phase simplex solver:
 *   minimise c.x  subject to  A x = b,  x >= 0
 * A is m x n, row-major. Built for the grasp wrench problems, which have six
 * rows and a few hundred columns.
 */
export interface LpResult {
  feasible: boolean;
  value: number;
  x: Float64Array;
}

export function solveLP(A: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, m: number, n: number): LpResult {
  const cols = n + m + 1;
  const rhs = cols - 1;
  const T = new Float64Array((m + 1) * cols);
  const basis = new Int32Array(m);
  const EPS = 1e-9;
  let scale = 0;
  for (let i = 0; i < m; i++) {
    const s = b[i] < 0 ? -1 : 1;
    for (let j = 0; j < n; j++) T[i * cols + j] = s * A[i * n + j];
    T[i * cols + n + i] = 1;
    T[i * cols + rhs] = s * b[i];
    basis[i] = n + i;
    scale += Math.abs(b[i]);
  }
  const obj = m * cols;

  const pivot = (r: number, col: number) => {
    const pr = r * cols;
    const pv = T[pr + col];
    for (let j = 0; j < cols; j++) T[pr + j] /= pv;
    for (let i = 0; i <= m; i++) {
      if (i === r) continue;
      const f = T[i * cols + col];
      if (f === 0) continue;
      const ir = i * cols;
      for (let j = 0; j < cols; j++) T[ir + j] -= f * T[pr + j];
    }
    basis[r] = col;
  };

  const run = (limit: number): boolean => {
    for (let iter = 0; iter < 600; iter++) {
      // entering column: most negative reduced cost, Bland's rule late on to rule out cycling
      let col = -1;
      if (iter < 250) {
        let best = -EPS;
        for (let j = 0; j < limit; j++)
          if (T[obj + j] < best) {
            best = T[obj + j];
            col = j;
          }
      } else {
        for (let j = 0; j < limit; j++)
          if (T[obj + j] < -EPS) {
            col = j;
            break;
          }
      }
      if (col < 0) return true;
      let row = -1, ratio = Infinity;
      for (let i = 0; i < m; i++) {
        const a = T[i * cols + col];
        if (a <= EPS || (basis[i] >= n && a <= 1e-7)) continue;
        const q = T[i * cols + rhs] / a;
        if (q < ratio - 1e-12 || (q < ratio + 1e-12 && row >= 0 && basis[i] < basis[row])) {
          ratio = q;
          row = i;
        }
      }
      if (row < 0) return false; // unbounded
      pivot(row, col);
    }
    return true;
  };

  // phase 1: minimise the sum of the artificial variables
  for (let j = 0; j < cols; j++) {
    if (j >= n && j < n + m) continue;
    let s = 0;
    for (let i = 0; i < m; i++) s += T[i * cols + j];
    T[obj + j] = -s;
  }
  run(n);
  const infeasibility = -T[obj + rhs];
  const x = new Float64Array(n);
  if (infeasibility > 1e-7 * (1 + scale)) return { feasible: false, value: Infinity, x };

  // move any leftover artificial variables out of the basis
  for (let i = 0; i < m; i++) {
    if (basis[i] < n) continue;
    for (let j = 0; j < n; j++)
      if (Math.abs(T[i * cols + j]) > 1e-7) {
        pivot(i, j);
        break;
      }
  }

  // phase 2
  for (let j = 0; j < cols; j++) T[obj + j] = j < n ? c[j] : 0;
  for (let i = 0; i < m; i++) {
    if (basis[i] >= n) continue;
    const cb = c[basis[i]];
    if (cb === 0) continue;
    for (let j = 0; j < cols; j++) T[obj + j] -= cb * T[i * cols + j];
  }
  run(n);
  let value = 0;
  for (let i = 0; i < m; i++) {
    if (basis[i] < n) {
      x[basis[i]] = T[i * cols + rhs];
      value += c[basis[i]] * x[basis[i]];
    }
  }
  return { feasible: true, value, x };
}
