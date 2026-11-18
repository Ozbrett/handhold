import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { type TriMesh, computeBounds, surfaceCentroid, volumeAndCentroid, weldMesh } from '../trimesh';

const _hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _p = new Vector3();

/**
 * The thing being held: a triangle mesh with fast "how far is the surface
 * from here" queries, plus its centre of mass.
 */
export class GraspObject {
  readonly bvh: MeshBVH;
  readonly positions: Float32Array;
  readonly index: Uint32Array;
  readonly com = new Vector3();
  readonly center = new Vector3();
  /** Radius of the bounding sphere around the centre of mass. */
  readonly radius: number;
  readonly diag: number;
  readonly watertight: boolean;
  /** -1 if the mesh is inside-out (faces wound the wrong way). */
  readonly flip: 1 | -1;
  /** Point on the surface and its outward normal for the most recent distance() call. */
  readonly lastPoint = new Vector3();
  readonly lastNormal = new Vector3();
  queries = 0;

  constructor(mesh: TriMesh) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(mesh.positions.slice(), 3));
    geo.setIndex(new BufferAttribute(mesh.indices.slice(), 1));
    this.bvh = new MeshBVH(geo);
    this.positions = geo.getAttribute('position').array as Float32Array;
    this.index = geo.index!.array as Uint32Array;
    const b = computeBounds(this.positions);
    this.diag = b.diag;
    this.center.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);

    // centre of mass: of the volume if the mesh is closed, of the surface otherwise
    const welded = weldMesh(mesh).mesh;
    const vc = volumeAndCentroid(welded);
    const boxVol = Math.max(1e-30, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]));
    const c = new Vector3(...vc.centroid);
    const inside =
      c.x >= b.min[0] && c.x <= b.max[0] && c.y >= b.min[1] && c.y <= b.max[1] && c.z >= b.min[2] && c.z <= b.max[2];
    this.watertight = Math.abs(vc.volume) > 1e-4 * boxVol && inside;
    // a mesh whose faces all point inwards still has a well-defined outside
    this.flip = this.watertight && vc.volume < 0 ? -1 : 1;
    if (this.watertight) this.com.copy(c);
    else this.com.set(...surfaceCentroid(welded));
    let r = 0;
    for (let i = 0; i < this.positions.length; i += 3) {
      r = Math.max(
        r,
        Math.hypot(this.positions[i] - this.com.x, this.positions[i + 1] - this.com.y, this.positions[i + 2] - this.com.z),
      );
    }
    this.radius = r;
  }

  /**
   * Signed distance from a point to the surface (negative inside).
   * Also records the closest surface point and the direction out of the object.
   */
  distance(x: number, y: number, z: number): number {
    this.queries++;
    _p.set(x, y, z);
    const h = this.bvh.closestPointToPoint(_p, _hit);
    if (!h) return Infinity;
    const P = this.positions, I = this.index;
    const a = I[h.faceIndex * 3] * 3, b = I[h.faceIndex * 3 + 1] * 3, c = I[h.faceIndex * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dx = x - h.point.x, dy = y - h.point.y, dz = z - h.point.z;
    const side = (dx * nx + dy * ny + dz * nz) * this.flip;
    this.lastPoint.copy(h.point);
    const d = h.distance;
    if (d > 1e-9) {
      const s = side >= 0 ? 1 / d : -1 / d;
      this.lastNormal.set(dx * s, dy * s, dz * s);
    } else {
      const l = Math.hypot(nx, ny, nz) || 1;
      this.lastNormal.set((nx / l) * this.flip, (ny / l) * this.flip, (nz / l) * this.flip);
    }
    return side >= 0 ? d : -d;
  }
}
