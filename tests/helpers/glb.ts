import { readFileSync } from 'node:fs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { TriMesh } from '../../src/core/trimesh';

export interface GlbHand {
  mesh: TriMesh;
  /** World position of every joint node by name. */
  joints: Record<string, Vector3>;
  skinJointNames: string[];
  jointIndices: Uint16Array;
  jointWeights: Float32Array;
}

const COMPONENTS: Record<number, { size: number; read: (dv: DataView, o: number) => number }> = {
  5120: { size: 1, read: (dv, o) => dv.getInt8(o) },
  5121: { size: 1, read: (dv, o) => dv.getUint8(o) },
  5122: { size: 2, read: (dv, o) => dv.getInt16(o, true) },
  5123: { size: 2, read: (dv, o) => dv.getUint16(o, true) },
  5125: { size: 4, read: (dv, o) => dv.getUint32(o, true) },
  5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true) },
};
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Minimal GLB reader for tests: one skinned mesh, posed with its default node transforms. */
export function loadGlbHand(path: string): GlbHand {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const accessor = (i: number): number[] => {
    const acc = json.accessors[i];
    const view = json.bufferViews[acc.bufferView];
    const comp = COMPONENTS[acc.componentType];
    const n = TYPE_SIZE[acc.type];
    const stride = view.byteStride ?? comp.size * n;
    const base = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out: number[] = new Array(acc.count * n);
    for (let e = 0; e < acc.count; e++)
      for (let c = 0; c < n; c++) out[e * n + c] = comp.read(dv, base + e * stride + c * comp.size);
    return out;
  };

  const local: Matrix4[] = json.nodes.map((n: any) => {
    if (n.matrix) return new Matrix4().fromArray(n.matrix);
    return new Matrix4().compose(
      new Vector3(...(n.translation ?? [0, 0, 0])),
      new Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
      new Vector3(...(n.scale ?? [1, 1, 1])),
    );
  });
  const world: Matrix4[] = json.nodes.map(() => new Matrix4());
  const visit = (i: number, parent: Matrix4) => {
    world[i].multiplyMatrices(parent, local[i]);
    for (const c of json.nodes[i].children ?? []) visit(c, world[i]);
  };
  for (const r of json.scenes[json.scene ?? 0].nodes) visit(r, new Matrix4());

  const meshNode = json.nodes.findIndex((n: any) => n.mesh !== undefined);
  const prim = json.meshes[json.nodes[meshNode].mesh].primitives[0];
  const pos = accessor(prim.attributes.POSITION);
  const idx = accessor(prim.indices);
  const skin = json.skins[json.nodes[meshNode].skin];
  const ibm = accessor(skin.inverseBindMatrices);
  const ji = accessor(prim.attributes.JOINTS_0);
  const jw = accessor(prim.attributes.WEIGHTS_0);
  const skinMats: Matrix4[] = skin.joints.map((node: number, k: number) =>
    new Matrix4().multiplyMatrices(world[node], new Matrix4().fromArray(ibm, k * 16)),
  );
  const count = pos.length / 3;
  const positions = new Float32Array(pos.length);
  const v = new Vector3(), acc = new Vector3(), t = new Vector3();
  for (let i = 0; i < count; i++) {
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    acc.set(0, 0, 0);
    let total = 0;
    for (let s = 0; s < 4; s++) {
      const w = jw[i * 4 + s];
      if (w <= 0) continue;
      acc.addScaledVector(t.copy(v).applyMatrix4(skinMats[ji[i * 4 + s]]), w);
      total += w;
    }
    if (total > 0) acc.multiplyScalar(1 / total);
    else acc.copy(v).applyMatrix4(world[meshNode]);
    positions[i * 3] = acc.x;
    positions[i * 3 + 1] = acc.y;
    positions[i * 3 + 2] = acc.z;
  }
  const joints: Record<string, Vector3> = {};
  json.nodes.forEach((n: any, i: number) => {
    if (n.name) joints[n.name] = new Vector3().setFromMatrixPosition(world[i]);
  });
  return {
    mesh: { positions, indices: new Uint32Array(idx) },
    joints,
    skinJointNames: skin.joints.map((n: number) => json.nodes[n].name),
    jointIndices: new Uint16Array(ji),
    jointWeights: new Float32Array(jw),
  };
}
