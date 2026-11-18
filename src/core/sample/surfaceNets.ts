import type { TriMesh } from '../trimesh';

/**
 * Naive surface nets: turns a signed distance function into a triangle mesh
 * with outward-facing normals (towards positive distance).
 */
export function surfaceNets(
  sdf: (x: number, y: number, z: number) => number,
  min: [number, number, number],
  max: [number, number, number],
  cell: number,
): TriMesh {
  const dims = [0, 1, 2].map((a) => Math.ceil((max[a] - min[a]) / cell) + 1);
  const [nx, ny, nz] = dims;
  const f = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        f[i + nx * (j + ny * k)] = sdf(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);

  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const positions: number[] = [];
  const corner = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const v = new Float32Array(8);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = f[i + corner[c][0] + nx * (j + corner[c][1] + ny * (k + corner[c][2]))];
          if (v[c] < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of edges) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
          sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
          cnt++;
        }
        cellVert[i + cx * (j + cy * k)] = positions.length / 3;
        positions.push(
          min[0] + (i + sx / cnt) * cell,
          min[1] + (j + sy / cnt) * cell,
          min[2] + (k + sz / cnt) * cell,
        );
      }

  const indices: number[] = [];
  const cellAt = (i: number, j: number, k: number) => cellVert[i + cx * (j + cy * k)];
  const p = [0, 0, 0];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        p[0] = i;
        p[1] = j;
        p[2] = k;
        const f0 = f[i + nx * (j + ny * k)];
        for (let a = 0; a < 3; a++) {
          const u = (a + 1) % 3, w = (a + 2) % 3;
          if (p[a] + 1 >= dims[a]) continue;
          if (p[u] < 1 || p[w] < 1 || p[u] > dims[u] - 2 || p[w] > dims[w] - 2) continue;
          const q = [i, j, k];
          q[a]++;
          const f1 = f[q[0] + nx * (q[1] + ny * q[2])];
          if (f0 < 0 === f1 < 0) continue;
          const c = [i, j, k];
          const get = (du: number, dw: number) => {
            const cc = [c[0], c[1], c[2]];
            cc[u] += du;
            cc[w] += dw;
            return cellAt(cc[0], cc[1], cc[2]);
          };
          const v00 = get(-1, -1), v10 = get(0, -1), v11 = get(0, 0), v01 = get(-1, 0);
          if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
          if (f0 < 0) indices.push(v00, v10, v11, v00, v11, v01);
          else indices.push(v00, v11, v10, v00, v01, v11);
        }
      }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
