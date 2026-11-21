import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { type TriMesh, computeBounds, surfaceCentroid, volumeAndCentroid, weldMesh } from '../trimesh';

const _hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _p = new Vector3();
const _c = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();
const _n = new Vector3();
const _sum = new Vector3();
const _on = new Vector3();
const _A = new Vector3();
const _B = new Vector3();
const _C = new Vector3();
/** Two points nearer than this are the same point of the surface (metres): well over a file's rounding, well under any part's thickness. */
const SAME = 2e-5;

/** How far `p` is from the segment ab. */
function offSegment(p: Vector3, a: Vector3, b: Vector3): number {
  _e1.subVectors(b, a);
  const l = _e1.lengthSq();
  const t = l > 0 ? Math.max(0, Math.min(1, _e2.subVectors(p, a).dot(_e1) / l)) : 0;
  return _e2.copy(a).addScaledVector(_e1, t).distanceTo(p);
}

/** Whether a point of triangle abc lies on one of its edges or corners, where the triangle alone cannot say which side is out. */
export function onTriangleEdge(p: Vector3, a: Vector3, b: Vector3, c: Vector3): boolean {
  return offSegment(p, a, b) < SAME || offSegment(p, b, c) < SAME || offSegment(p, c, a) < SAME;
}

/**
 * The faces of a mesh meeting at a point of its surface, added up into `out`: each face's unit normal (by its own winding) times the
 * angle the face takes up round the point (a corner's own angle, a half turn on an edge, a whole turn inside a face). False when they
 * cancel out or none is found.
 */
export function facesAround(bvh: MeshBVH, at: Vector3, out: Vector3): boolean {
  out.set(0, 0, 0);
  bvh.shapecast({
    intersectsBounds: (box) => box.distanceToPoint(at) <= SAME,
    intersectsTriangle: (tri) => {
      if (tri.closestPointToPoint(at, _on).distanceTo(at) > SAME) return false;
      _n.subVectors(tri.b, tri.a).cross(_e2.subVectors(tri.c, tri.a));
      const area = _n.length();
      if (area < 1e-14) return false;
      _n.multiplyScalar(1 / area);
      const corner = (v: Vector3, u: Vector3, w: Vector3) => _on.subVectors(u, v).angleTo(_e2.subVectors(w, v));
      let angle = 2 * Math.PI;
      if (at.distanceTo(tri.a) < SAME) angle = corner(tri.a, tri.b, tri.c);
      else if (at.distanceTo(tri.b) < SAME) angle = corner(tri.b, tri.c, tri.a);
      else if (at.distanceTo(tri.c) < SAME) angle = corner(tri.c, tri.a, tri.b);
      else if (onTriangleEdge(at, tri.a, tri.b, tri.c)) angle = Math.PI;
      out.addScaledVector(_n, angle);
      return false;
    },
  });
  return out.lengthSq() > 1e-6;
}

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
    let side = (dx * nx + dy * ny + dz * nz) * this.flip;
    // On an edge or a corner one face cannot say which side the point is on: where two faces meet sharper than a right angle, a point
    // outside is still behind one of them. Every face that meets there says, each by the angle it takes up round the point.
    const d0 = h.distance;
    if (d0 > 1e-9) {
      const A = _A.set(P[a], P[a + 1], P[a + 2]), B = _B.set(P[b], P[b + 1], P[b + 2]), C = _C.set(P[c], P[c + 1], P[c + 2]);
      _c.copy(h.point);
      if (onTriangleEdge(_c, A, B, C) && facesAround(this.bvh, _c, _sum)) side = (dx * _sum.x + dy * _sum.y + dz * _sum.z) * this.flip;
    }
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
