import { Matrix4, Vector3 } from 'three';
import { type Picture, picture } from './png';

/**
 * A small software renderer for contact sheets: flat-shaded triangles with a depth buffer, lit from the eye, both sides drawn.
 * It needs no GPU and no window, so the command line can draw a pose anywhere and Claude can look at the result.
 */

export interface Drawable {
  positions: Float32Array;
  index: Uint32Array;
  /** One colour for the whole mesh, or one per vertex (three bytes each). */
  colour: [number, number, number];
  colours?: Uint8Array;
  /** Its own space to world; world when left out. */
  matrix?: Matrix4;
  /** Drawn through whatever is in front of it: a fault buried inside the body still shows. */
  onTop?: boolean;
}

export interface View {
  name: string;
  eye: Vector3;
  target: Vector3;
  up: Vector3;
  /** Half the picture's height in metres for a straight-on (orthographic) view; a perspective view gives `fov` instead. */
  half?: number;
  fov?: number;
}

export function render(items: Drawable[], view: View, width: number, height: number, background: [number, number, number] = [24, 26, 30]): Picture {
  const pic = picture(width, height, background);
  const depth = new Float32Array(width * height).fill(Infinity);
  const look = new Matrix4().lookAt(view.eye, view.target, view.up);
  look.setPosition(view.eye);
  const toCam = look.clone().invert();
  const aspect = width / height;
  const persp = view.half === undefined;
  const f = persp ? 1 / Math.tan(((view.fov ?? 60) * Math.PI) / 360) : 1 / view.half!;
  const near = 0.02;
  const v = new Vector3();
  for (const d of items) {
    const m = d.matrix ? toCam.clone().multiply(d.matrix) : toCam;
    const P = d.positions, n = P.length / 3;
    const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
    const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(m);
      cx[i] = v.x; cy[i] = v.y; cz[i] = v.z;
      // the camera looks down -z
      const z = -v.z;
      sz[i] = z;
      const k = persp ? f / Math.max(near, z) : f;
      sx[i] = (v.x * k / aspect * 0.5 + 0.5) * width;
      sy[i] = (0.5 - v.y * k * 0.5) * height;
    }
    const I = d.index;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (persp && (sz[a] < near || sz[b] < near || sz[c] < near)) continue;
      // facing: lit from the eye, both sides
      const ux = cx[b] - cx[a], uy = cy[b] - cy[a], uz = cz[b] - cz[a];
      const wx = cx[c] - cx[a], wy = cy[c] - cy[a], wz = cz[c] - cz[a];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-14) continue;
      nx /= nl; ny /= nl; nz /= nl;
      let lx = -cx[a], ly = -cy[a], lz = -cz[a];
      if (!persp) { lx = 0; ly = 0; lz = 1; }
      const ll = Math.hypot(lx, ly, lz) || 1;
      const lit = 0.3 + 0.7 * Math.abs((nx * lx + ny * ly + nz * lz) / ll);
      const col = d.colours
        ? [0, 1, 2].map((k) => (d.colours![a * 3 + k] + d.colours![b * 3 + k] + d.colours![c * 3 + k]) / 3)
        : d.colour;
      const r = Math.min(255, col[0] * lit), g = Math.min(255, col[1] * lit), bl = Math.min(255, col[2] * lit);
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(width - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(height - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
      if (x0 > x1 || y0 > y1) continue;
      const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
      if (Math.abs(area) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((sx[b] - px) * (sy[c] - py) - (sx[c] - px) * (sy[b] - py)) / area;
        const w1 = ((sx[c] - px) * (sy[a] - py) - (sx[a] - px) * (sy[c] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
        const o = y * width + x;
        if (!d.onTop && z >= depth[o]) continue;
        depth[o] = z;
        pic.rgb[o * 3] = r; pic.rgb[o * 3 + 1] = g; pic.rgb[o * 3 + 2] = bl;
      }
    }
  }
  return pic;
}
