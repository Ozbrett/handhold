import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createProceduralHand } from '../core/sample/proceduralHand';
import { createProceduralHead } from '../core/sample/proceduralHead';
import type { TriMesh } from '../core/trimesh';
import { clayMaterial } from './loaders';

/** The built-in mannequin hand, as an ordinary un-rigged mesh. */
export function sampleHand(left = false): Object3D {
  const { mesh } = createProceduralHand({ left });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geo.setIndex(new BufferAttribute(mesh.indices, 1));
  geo.computeVertexNormals();
  const m = new Mesh(geo, clayMaterial());
  m.name = 'SampleHand';
  const g = new Group();
  g.name = left ? 'Sample hand (left)' : 'Sample hand';
  g.add(m);
  return g;
}

type V3 = [number, number, number];

/** A bone and the segment it covers (its pivot to the next pivot down the chain), for skinning. */
interface Seg {
  bone: number;
  a: Vector3;
  b: Vector3;
}

/**
 * Skins a body part smoothly: each vertex follows the bones whose segments it is
 * nearest, blended by inverse distance (to the 4th power), so a joint bends as one
 * soft piece instead of two rigid ones meeting. Only the segments given can be used,
 * which keeps an arm's skin off the chest and a leg's off the other leg.
 */
function skin(geo: BufferGeometry, segs: Seg[]): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const n = pos.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const v = new Vector3(), d = new Vector3(), q = new Vector3();
  const near: { bone: number; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    near.length = 0;
    for (const s of segs) {
      d.copy(s.b).sub(s.a);
      const len2 = d.lengthSq();
      const t = len2 > 0 ? Math.min(1, Math.max(0, q.copy(v).sub(s.a).dot(d) / len2)) : 0;
      const dist = Math.max(1e-3, q.copy(s.a).addScaledVector(d, t).distanceTo(v));
      const w = 1 / dist ** 4;
      const same = near.find((x) => x.bone === s.bone);
      if (same) same.w = Math.max(same.w, w);
      else near.push({ bone: s.bone, w });
    }
    near.sort((x, y) => y.w - x.w);
    const top = near.slice(0, 3);
    let sum = top.reduce((acc, x) => acc + x.w, 0);
    // drop the faint ones so a joint's influence stays near that joint
    const kept = top.filter((x) => x.w / sum > 0.04);
    sum = kept.reduce((acc, x) => acc + x.w, 0);
    kept.forEach((x, k) => {
      si[i * 4 + k] = x.bone;
      sw[i * 4 + k] = x.w / sum;
    });
  }
  g.setAttribute('skinIndex', new BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new BufferAttribute(sw, 4));
  return g;
}

/** A capsule (or a tapered rod with round ends) from `a` to `b`. */
function rod(a: V3, b: V3, r: number, r2 = r, sides = 32): BufferGeometry {
  const va = new Vector3(...a), vb = new Vector3(...b);
  const len = va.distanceTo(vb);
  const parts = [
    new CylinderGeometry(r2, r, len, sides, 8, true).translate(0, len / 2, 0),
    new SphereGeometry(r, sides, 16).toNonIndexed(),
    new SphereGeometry(r2, sides, 16).translate(0, len, 0).toNonIndexed(),
  ].map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    return n;
  });
  const g = mergeGeometries(parts)!;
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q).translate(va.x, va.y, va.z);
  return g;
}

const ball = (c: V3, r: number, sx = 1, sy = 1, sz = 1) => {
  const g = new SphereGeometry(r, 36, 24).scale(sx, sy, sz).translate(...c).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
};

/** A round body of revolution from (radius, height) pairs, squashed front to back by `depth`. */
function lathe(profile: [number, number][], depth: number, segments = 56): BufferGeometry {
  const g = new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), segments).scale(1, 1, depth).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
}

const merge = (parts: BufferGeometry[]) => mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;

/**
 * The built-in demo player: a clean mannequin about 1.79 m tall, standing in a
 * T-pose and facing +Z, with a full skeleton (named like a Mixamo rig, without
 * the prefix) and the sample hands on the ends of its arms. Each finger has
 * three bones plus an end bone, so grips can be put on its own skeleton. The
 * body is skinned smoothly across every joint, so it bends cleanly in any animation.
 */
export function sampleCharacter(): Object3D {
  const root = new Group();
  root.name = 'Sample player';
  const bones: Bone[] = [];
  const at: Vector3[] = [];
  const index = new Map<string, number>();
  const bone = (name: string, parent: string | null, p: V3) => {
    const b = new Bone();
    b.name = name;
    const pw = new Vector3(...p);
    if (parent) {
      const pi = index.get(parent)!;
      b.position.copy(pw).sub(at[pi]);
      bones[pi].add(b);
    } else {
      b.position.copy(pw);
      root.add(b);
    }
    index.set(name, bones.length);
    bones.push(b);
    at.push(pw);
    return bones.length - 1;
  };
  /** The segment from bone `from` to the pivot of bone `to` (or to a point). */
  const seg = (from: string, to: string | V3): Seg => {
    const i = index.get(from)!;
    return { bone: i, a: at[i], b: typeof to === 'string' ? at[index.get(to)!] : new Vector3(...to) };
  };

  const shoulderY = 1.43, shoulderX = 0.17, elbowX = 0.45, wristX = 0.71;
  bone('Hips', null, [0, 0.95, 0]);
  bone('Spine', 'Hips', [0, 1.05, 0]);
  bone('Spine1', 'Spine', [0, 1.18, 0]);
  bone('Spine2', 'Spine1', [0, 1.3, 0]);
  bone('Neck', 'Spine2', [0, 1.48, 0]);
  const head = bone('Head', 'Neck', [0, 1.57, 0]);
  bone('HeadTop_End', 'Head', [0, 1.79, 0]);
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1;
    bone(`${side}Shoulder`, 'Spine2', [0.06 * s, shoulderY, 0]);
    bone(`${side}Arm`, `${side}Shoulder`, [shoulderX * s, shoulderY, 0]);
    bone(`${side}ForeArm`, `${side}Arm`, [elbowX * s, shoulderY, 0]);
    bone(`${side}Hand`, `${side}ForeArm`, [wristX * s, shoulderY, 0]);
  }
  for (const side of ['Left', 'Right'] as const) {
    const x = side === 'Left' ? 0.09 : -0.09;
    bone(`${side}UpLeg`, 'Hips', [x, 0.9, 0]);
    bone(`${side}Leg`, `${side}UpLeg`, [x, 0.5, 0]);
    bone(`${side}Foot`, `${side}Leg`, [x, 0.085, 0]);
    bone(`${side}ToeBase`, `${side}Foot`, [x, 0.03, 0.13]);
    bone(`${side}Toe_End`, `${side}ToeBase`, [x, 0.03, 0.2]);
  }

  const shirt: BufferGeometry[] = [];
  const pants: BufferGeometry[] = [];
  const shoes: BufferGeometry[] = [];
  const bare: BufferGeometry[] = [];

  // torso: one smooth shell over the whole spine, wider than it is deep
  const spineSegs = [seg('Hips', 'Spine'), seg('Spine', 'Spine1'), seg('Spine1', 'Spine2'), seg('Spine2', 'Neck')];
  const collarSegs = (['Left', 'Right'] as const).map((side) => seg(`${side}Shoulder`, `${side}Arm`));
  shirt.push(
    skin(
      lathe(
        [
          [0.001, 0.985], [0.148, 0.99], [0.152, 1.03], [0.141, 1.09], [0.143, 1.16], [0.156, 1.24], [0.17, 1.32],
          [0.176, 1.38], [0.168, 1.425], [0.138, 1.462], [0.1, 1.488], [0.074, 1.503], [0.05, 1.509], [0.001, 1.51],
        ],
        0.6,
      ),
      [...spineSegs, ...collarSegs],
    ),
  );
  // pelvis
  pants.push(skin(ball([0, 0.94, 0], 0.158, 1.02, 0.62, 0.66), [seg('Hips', 'Spine'), seg('LeftUpLeg', 'LeftLeg'), seg('RightUpLeg', 'RightLeg')]));
  // neck, then the head (one bone, so it stays rigid)
  bare.push(skin(rod([0, 1.43, -0.014], [0, 1.6, -0.01], 0.062, 0.055), [seg('Spine2', 'Neck'), seg('Neck', 'Head'), seg('Head', 'HeadTop_End')]));
  const headOnly = [{ bone: head, a: at[head], b: at[head] }];
  // the head is sculpted rather than built from primitives: see proceduralHead.ts
  const sculpted = createProceduralHead();
  const headPart = (m: TriMesh) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.positions, 3));
    g.setIndex(new BufferAttribute(m.indices, 1));
    g.computeVertexNormals();
    return skin(g, headOnly);
  };
  bare.push(headPart(sculpted.skin));
  const hair = [headPart(sculpted.dark)];
  const eyes = [headPart(sculpted.white)];
  const lips = [headPart(sculpted.lips)];

  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1;
    const armSegs = [
      seg(`${side}Shoulder`, `${side}Arm`),
      seg(`${side}Arm`, `${side}ForeArm`),
      seg(`${side}ForeArm`, `${side}Hand`),
      seg(`${side}Hand`, [(wristX + 0.08) * s, shoulderY, 0]),
    ];
    const upper = [...armSegs.slice(0, 3), seg('Spine2', 'Neck')];
    // shoulder cap and sleeve
    shirt.push(
      skin(ball([0.158 * s, shoulderY - 0.008, 0], 0.07, 1.05, 0.95, 0.9), upper),
      skin(rod([shoulderX * s, shoulderY, 0], [(elbowX - 0.01) * s, shoulderY, 0], 0.054, 0.044), upper),
    );
    // bare forearm, running into the hand
    bare.push(skin(rod([(elbowX - 0.04) * s, shoulderY, 0], [(wristX - 0.02) * s, shoulderY, 0], 0.042, 0.029), armSegs.slice(1)));
  }

  for (const side of ['Left', 'Right'] as const) {
    const x = side === 'Left' ? 0.09 : -0.09;
    const legSegs = [seg('Hips', `${side}UpLeg`), seg(`${side}UpLeg`, `${side}Leg`), seg(`${side}Leg`, `${side}Foot`), seg(`${side}Foot`, `${side}ToeBase`)];
    pants.push(
      skin(rod([x * 1.02, 0.93, 0.004], [x, 0.52, 0.006], 0.088, 0.058), legSegs), // thigh
      skin(rod([x, 0.5, 0.006], [x, 0.11, -0.004], 0.056, 0.04), legSegs), // shin
      skin(ball([x, 0.37, -0.016], 0.052, 1, 2.3, 1), legSegs), // calf
    );
    const footSegs = [seg(`${side}Leg`, `${side}Foot`), seg(`${side}Foot`, `${side}ToeBase`), seg(`${side}ToeBase`, `${side}Toe_End`)];
    shoes.push(
      skin(ball([x, 0.055, 0.045], 0.06, 0.88, 0.78, 2.05), footSegs),
      skin(new BoxGeometry(0.098, 0.022, 0.25, 2, 1, 4).translate(x, 0.011, 0.045), footSegs), // sole
    );
  }

  // the sample hands, turned so the fingers run out along the arm, palm down, thumb forward:
  // hand +Y (fingers) -> outward, +Z (palm) -> down, thumb side -> forward
  const handMeshes: SkinnedMesh[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1;
    const hand = index.get(`${side}Hand`)!;
    const { mesh, truth } = createProceduralHand({ left: side === 'Left' });
    const basis = new Matrix4().makeBasis(new Vector3(0, 0, s === 1 ? -1 : 1), new Vector3(s, 0, 0), new Vector3(0, -1, 0));
    basis.setPosition(wristX * s, shoulderY, 0);
    const toWorld = (p: V3) => new Vector3(...p).applyMatrix4(basis);
    const short = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' } as Record<string, string>;
    const chains = truth.fingers.map((f) => {
      const name = `${side}Hand${short[f.name]}`;
      const pts = [...f.joints, f.tip].map(toWorld);
      const ids: number[] = [];
      pts.forEach((p, k) => ids.push(bone(`${name}${k + 1}`, k ? `${name}${k}` : `${side}Hand`, [p.x, p.y, p.z])));
      return { pts, ids, radii: f.radii };
    });

    // skin weights: a vertex follows the finger segment it lies on, fading into the palm at the knuckle
    const pos = mesh.positions;
    const n = pos.length / 3;
    const world = new Float32Array(pos.length);
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const v = new Vector3(), d = new Vector3(), q = new Vector3();
    for (let i = 0; i < n; i++) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(basis);
      world[i * 3] = v.x;
      world[i * 3 + 1] = v.y;
      world[i * 3 + 2] = v.z;
      let best = Infinity, bestBone = hand, bestT = 1, first = false;
      for (const c of chains)
        for (let k = 0; k < 3; k++) {
          const a = c.pts[k], b = c.pts[k + 1];
          d.copy(b).sub(a);
          const t = Math.min(1, Math.max(0, q.copy(v).sub(a).dot(d) / d.lengthSq()));
          const dist = q.copy(a).addScaledVector(d, t).distanceTo(v) - c.radii[k];
          if (dist < best) {
            best = dist;
            bestBone = c.ids[k];
            bestT = t;
            first = k === 0;
          }
        }
      // far from every finger: the palm
      if (best > 0.006) bestBone = hand;
      const w = bestBone === hand ? 0 : first ? Math.min(1, bestT / 0.35) : 1;
      si[i * 4] = bestBone;
      sw[i * 4] = w;
      si[i * 4 + 1] = hand;
      sw[i * 4 + 1] = 1 - w;
    }
    const hg = new BufferGeometry();
    hg.setAttribute('position', new BufferAttribute(world, 3));
    hg.setIndex(new BufferAttribute(mesh.indices, 1));
    hg.setAttribute('skinIndex', new BufferAttribute(si, 4));
    hg.setAttribute('skinWeight', new BufferAttribute(sw, 4));
    // flip the winding if the turn mirrored the hand
    if (basis.determinant() < 0) {
      const idx = hg.index!.array as Uint32Array;
      for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    }
    hg.computeVertexNormals();
    const handMesh = new SkinnedMesh(hg, clayMaterial());
    handMesh.name = `${side}HandMesh`;
    handMeshes.push(handMesh);
  }

  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  const part = (name: string, parts: BufferGeometry[], material: MeshStandardMaterial) => {
    const m = new SkinnedMesh(merge(parts), material);
    m.name = name;
    return m;
  };
  root.add(
    ...handMeshes,
    part('Shirt', shirt, new MeshStandardMaterial({ color: 0x4d6a80, roughness: 0.78 })),
    part('Pants', pants, new MeshStandardMaterial({ color: 0x2c333d, roughness: 0.8 })),
    part('Shoes', shoes, new MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.55 })),
    part('Skin', bare, clayMaterial()),
    part('Hair', hair, new MeshStandardMaterial({ color: 0x3b2f28, roughness: 0.9 })),
    part('Eyes', eyes, new MeshStandardMaterial({ color: 0xf2eee8, roughness: 0.4 })),
    part('Lips', lips, new MeshStandardMaterial({ color: 0xc9998a, roughness: 0.6 })),
  );
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) {
      const m = o as SkinnedMesh;
      m.castShadow = true;
      m.bind(skeleton, new Matrix4());
    }
  });
  return root;
}

export interface SampleObject {
  id: string;
  label: string;
  build: () => Object3D;
  /** A sensible place to hold it, used when the sample is first loaded. */
  grip: { point: Vector3; normal: Vector3 };
}

const objectMaterial = (color: number, roughness = 0.5, metalness = 0.05) =>
  new MeshStandardMaterial({ color, roughness, metalness });

function wrap(name: string, ...meshes: Mesh[]): Object3D {
  const g = new Group();
  g.name = name;
  for (const m of meshes) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

export const SAMPLE_OBJECTS: SampleObject[] = [
  {
    id: 'stick',
    label: 'Stick',
    build: () => wrap('Stick', new Mesh(new CylinderGeometry(0.016, 0.016, 0.34, 40, 12), objectMaterial(0x7a5c43, 0.7))),
    grip: { point: new Vector3(0.016, 0, 0), normal: new Vector3(1, 0, 0) },
  },
  {
    id: 'box',
    label: 'Box',
    build: () => wrap('Box', new Mesh(new BoxGeometry(0.11, 0.075, 0.085, 6, 4, 5), objectMaterial(0xb08d57, 0.8))),
    grip: { point: new Vector3(0, -0.0375, 0), normal: new Vector3(0, -1, 0) },
  },
  {
    id: 'ball',
    label: 'Ball',
    build: () => wrap('Ball', new Mesh(new SphereGeometry(0.036, 48, 32), objectMaterial(0xc4532f, 0.6))),
    grip: { point: new Vector3(0, -0.036, 0), normal: new Vector3(0, -1, 0) },
  },
  {
    id: 'mug',
    label: 'Mug',
    build: () => {
      // a cup with real wall thickness, plus a handle
      const profile = [
        new Vector2(0.0, 0.0),
        new Vector2(0.034, 0.0),
        new Vector2(0.04, 0.006),
        new Vector2(0.04, 0.095),
        new Vector2(0.0365, 0.095),
        new Vector2(0.0365, 0.01),
        new Vector2(0.0, 0.01),
      ];
      const cup = new LatheGeometry(profile, 48).translate(0, -0.0475, 0);
      const handle = new TorusGeometry(0.026, 0.0065, 14, 28, Math.PI)
        .rotateZ(-Math.PI / 2)
        .translate(0.0435, 0.002, 0);
      const merged = mergeGeometries([cup.toNonIndexed(), handle.toNonIndexed()]);
      merged.computeVertexNormals();
      return wrap('Mug', new Mesh(merged, objectMaterial(0xe9e4dc, 0.35)));
    },
    grip: { point: new Vector3(-0.04, 0, 0), normal: new Vector3(-1, 0, 0) },
  },
  {
    id: 'hammer',
    label: 'Hammer',
    build: () => {
      const handle = new Mesh(new CylinderGeometry(0.0145, 0.0165, 0.27, 32, 10), objectMaterial(0x8a6a48, 0.75));
      const head = new Mesh(new BoxGeometry(0.105, 0.036, 0.036, 6, 3, 3), objectMaterial(0x5d6672, 0.35, 0.6));
      head.position.y = 0.135;
      return wrap('Hammer', handle, head);
    },
    grip: { point: new Vector3(0, -0.07, 0.0158), normal: new Vector3(0, 0, 1) },
  },
];
