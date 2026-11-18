import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix3,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  Vector3,
} from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { TriMesh } from '../core/trimesh';

export const SUPPORTED = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];
export const ACCEPT = SUPPORTED.map((e) => '.' + e).join(',');

export function clayMaterial(color = 0xd8c7b8): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: new Color(color), roughness: 0.72, metalness: 0 });
}

/** Reads a 3D model file into a three.js object. Throws a readable error for unsupported files. */
export async function loadModelFile(file: File): Promise<Object3D> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`"${file.name}" is not a supported 3D file. Use GLB, FBX, OBJ, STL or PLY.`);
  }
  const buffer = await file.arrayBuffer();
  let root: Object3D;
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      root = gltf.scene;
    } else if (ext === 'fbx') {
      root = new FBXLoader().parse(buffer, '');
      dropMissingTextures(root);
    } else if (ext === 'obj') {
      root = new OBJLoader().parse(new TextDecoder().decode(buffer));
    } else {
      const geometry: BufferGeometry = ext === 'stl' ? new STLLoader().parse(buffer) : new PLYLoader().parse(buffer);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      root = new Group().add(new Mesh(geometry, clayMaterial()));
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `"${file.name}" could not be read (${detail}). If it is a .gltf with separate files, export it as a single .glb instead.`,
    );
  }
  root.name = root.name || file.name;
  root.updateMatrixWorld(true);
  if (collectMeshes(root).length === 0) throw new Error(`"${file.name}" contains no mesh.`);
  return root;
}

/**
 * An FBX names its textures as files beside it, which a single dropped file does not bring: those maps never load and drew the
 * whole model black. Only pictures packed inside the file (blob: or data: addresses) are kept.
 */
function dropMissingTextures(root: Object3D) {
  root.traverse((o) => {
    const mats = (o as Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      const mat = m as unknown as Record<string, unknown>;
      let dropped = false;
      for (const key of Object.keys(mat)) {
        const v = mat[key] as { isTexture?: boolean; image?: { src?: string } } | null;
        if (!v || !v.isTexture) continue;
        const src = v.image?.src ?? '';
        if (!/^(blob|data):/.test(src)) {
          mat[key] = null;
          dropped = true;
        }
      }
      // A colour that multiplies a texture is often written as black (the texture alone was meant): with the texture it draws a
      // black silhouette, and without one too. White under a texture, a light clay without.
      const c = (m as { color?: Color }).color;
      if (c && c.r + c.g + c.b < 0.6) c.set(mat.map ? 0xffffff : 0xb8aa9c);
      if (dropped || c) (m as { needsUpdate: boolean }).needsUpdate = true;
    }
  });
}

export function collectMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && m.geometry?.getAttribute('position')) out.push(m);
  });
  return out;
}

export interface BakedPart {
  mesh: Mesh;
  /** First vertex of this mesh in the combined vertex list. */
  start: number;
  count: number;
}

export interface Baked {
  mesh: TriMesh;
  parts: BakedPart[];
}

/**
 * Flattens every mesh under `root` into one triangle list in world space,
 * exactly as currently displayed (skinning and morph targets applied).
 */
export function bakeToTriMesh(root: Object3D): Baked {
  root.updateMatrixWorld(true);
  const meshes = collectMeshes(root);
  let nVerts = 0, nIdx = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    nVerts += pos.count;
    nIdx += m.geometry.index ? m.geometry.index.count : pos.count;
  }
  const positions = new Float32Array(nVerts * 3);
  const indices = new Uint32Array(nIdx - (nIdx % 3));
  const parts: BakedPart[] = [];
  const v = new Vector3();
  let vo = 0, io = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    const skinned = (m as SkinnedMesh).isSkinnedMesh;
    for (let i = 0; i < pos.count; i++) {
      if (skinned) (m as SkinnedMesh).getVertexPosition(i, v);
      else m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld);
      positions[(vo + i) * 3] = v.x;
      positions[(vo + i) * 3 + 1] = v.y;
      positions[(vo + i) * 3 + 2] = v.z;
    }
    const index = m.geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count && io + 2 < indices.length; i += 3) {
      for (let k = 0; k < 3; k++) indices[io++] = vo + (index ? index.getX(i + k) : i + k);
    }
    parts.push({ mesh: m, start: vo, count: pos.count });
    vo += pos.count;
  }
  return { mesh: { positions, indices: indices.subarray(0, io) }, parts };
}

/** True if the file carries a full-body skeleton (so it is a character, not a bare hand). */
export function looksLikeCharacter(root: Object3D): boolean {
  let bones = 0, body = false;
  root.traverse((o) => {
    if (!(o as { isBone?: boolean }).isBone) return;
    bones++;
    if (/hips|pelvis|spine|head|neck|leg|thigh|foot/i.test(o.name)) body = true;
  });
  return bones > 30 || body;
}

/**
 * Cuts part of a baked model out as new, plain meshes in world space.
 * `keep` holds one flag per vertex of `baked.mesh`.
 */
export function subsetBaked(baked: Baked, keep: Uint8Array): Baked {
  const parts: BakedPart[] = [];
  const positions: number[] = [];
  const indices: number[] = [];
  const normalMatrix = new Matrix3();
  const v = new Vector3();
  let vo = 0;
  for (const part of baked.parts) {
    const src = part.mesh.geometry;
    const map = new Int32Array(part.count).fill(-1);
    let n = 0;
    for (let i = 0; i < part.count; i++) if (keep[part.start + i]) map[i] = n++;
    if (n === 0) continue;
    const tris: number[] = [];
    const index = src.index;
    const count = index ? index.count : part.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const a = map[index ? index.getX(i) : i];
      const b = map[index ? index.getX(i + 1) : i + 1];
      const c = map[index ? index.getX(i + 2) : i + 2];
      if (a >= 0 && b >= 0 && c >= 0) tris.push(a, b, c);
    }
    if (!tris.length) continue;
    const geo = new BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < part.count; i++) {
      const k = map[i];
      if (k < 0) continue;
      for (let c = 0; c < 3; c++) pos[k * 3 + c] = baked.mesh.positions[(part.start + i) * 3 + c];
    }
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setIndex(tris);
    const posed = (part.mesh as unknown as SkinnedMesh).isSkinnedMesh || !!src.morphAttributes.position;
    for (const name of ['normal', 'uv', 'uv1', 'uv2', 'color']) {
      const attr = src.getAttribute(name);
      if (!attr || (name === 'normal' && posed)) continue;
      const size = attr.itemSize;
      const out = new Float32Array(n * size);
      for (let i = 0; i < part.count; i++) {
        const k = map[i];
        if (k < 0) continue;
        for (let c = 0; c < size; c++) out[k * size + c] = attr.getComponent(i, c);
      }
      if (name === 'normal') {
        normalMatrix.getNormalMatrix(part.mesh.matrixWorld);
        for (let k = 0; k < n; k++) {
          v.set(out[k * 3], out[k * 3 + 1], out[k * 3 + 2]).applyMatrix3(normalMatrix).normalize();
          out[k * 3] = v.x;
          out[k * 3 + 1] = v.y;
          out[k * 3 + 2] = v.z;
        }
      }
      geo.setAttribute(name, new BufferAttribute(out, size));
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const material = Array.isArray(part.mesh.material) ? part.mesh.material[0] : part.mesh.material;
    const mesh = new Mesh(geo, material);
    mesh.name = part.mesh.name || 'Hand';
    mesh.updateMatrixWorld(true);
    parts.push({ mesh, start: vo, count: n });
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    for (const t of tris) indices.push(t + vo);
    vo += n;
  }
  return { mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) }, parts };
}
