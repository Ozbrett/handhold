import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry, type Object3D } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeSubBones } from '../app/loaders';

/**
 * Loading a character and held things outside the browser, for the command-line checks. Textures are not needed to measure a
 * pose, and three's loaders reach for the page's document to decode them, so a stand-in that never loads anything is put there.
 */

function noDocument() {
  const g = globalThis as Record<string, unknown>;
  if (g.document) return;
  g.document = { createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {}, set src(_v: string) {} }) };
}

export async function loadCharacter(path: string): Promise<Object3D> {
  noDocument();
  const buf = readFileSync(path);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'fbx') {
    const root = new FBXLoader().parse(data, '');
    mergeSubBones(root);
    root.updateMatrixWorld(true);
    return root;
  }
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(data, '');
    gltf.scene.updateMatrixWorld(true);
    return gltf.scene;
  }
  throw new Error(`${path}: a character must be .fbx or .glb`);
}

/** One named part of an OBJ (its `o` or `g` line): triangles in the file's own space. */
export interface ObjPart {
  name: string;
  positions: Float32Array;
  index: Uint32Array;
}

/** Reads an OBJ as its named parts, each its own triangle mesh (faces fanned into triangles). `mirror` flips X and the winding with it. */
export function parseObj(text: string, mirror = false): ObjPart[] {
  const verts: number[] = [];
  const parts: { name: string; faces: number[] }[] = [];
  let cur: { name: string; faces: number[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const v = line.slice(2).trim().split(/\s+/).map(Number);
      verts.push(mirror ? -v[0] : v[0], v[1], v[2]);
    } else if (line.startsWith('o ') || line.startsWith('g ')) {
      cur = { name: line.slice(2).trim(), faces: [] };
      parts.push(cur);
    } else if (line.startsWith('f ')) {
      if (!cur) { cur = { name: 'part', faces: [] }; parts.push(cur); }
      const ids = line.slice(2).trim().split(/\s+/).map((t) => {
        const i = parseInt(t.split('/')[0], 10);
        return i < 0 ? verts.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) {
        if (mirror) cur.faces.push(ids[0], ids[k + 1], ids[k]);
        else cur.faces.push(ids[0], ids[k], ids[k + 1]);
      }
    }
  }
  const out: ObjPart[] = [];
  for (const p of parts) {
    if (!p.faces.length) continue;
    const remap = new Map<number, number>();
    const pos: number[] = [];
    const index = new Uint32Array(p.faces.length);
    p.faces.forEach((v, i) => {
      let j = remap.get(v);
      if (j === undefined) {
        j = remap.size;
        remap.set(v, j);
        pos.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
      }
      index[i] = j;
    });
    out.push({ name: p.name, positions: Float32Array.from(pos), index });
  }
  return out;
}

export function loadObj(path: string, mirror = false): ObjPart[] {
  return parseObj(readFileSync(path, 'utf8'), mirror);
}

export function partGeometry(p: ObjPart): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p.positions, 3));
  g.setIndex(new BufferAttribute(p.index, 1));
  return g;
}
