import { Quaternion, Vector3 } from 'three';
import { type Body, Region, posedSkin, worldDelta, worldPos } from './body';
import type { HeldItem } from './items';
import { type Picture, blit, label, picture } from './png';
import { type Drawable, type View, render } from './raster';

/**
 * Contact sheets: one pose drawn from the front, both sides, the back, above and the character's own eye, so a person (or Claude) can see
 * what the checks measured. The hands and arms are coloured apart (right hand orange, left hand blue) so which hand is where
 * reads at a glance; held items are green, a second item yellow.
 */

export const VIEWS = ['front', 'left', 'right', 'back', 'above', 'eye'] as const;
export type ViewName = (typeof VIEWS)[number];

const REGION_COLOUR: Record<number, [number, number, number]> = {
  [Region.Torso]: [92, 98, 110],
  [Region.Head]: [150, 132, 122],
  [Region.Legs]: [70, 76, 88],
  [Region.UpperR]: [150, 120, 100],
  [Region.ForeR]: [185, 140, 105],
  [Region.HandR]: [235, 160, 90],
  [Region.UpperL]: [100, 120, 150],
  [Region.ForeL]: [110, 145, 190],
  [Region.HandL]: [100, 175, 235],
};
const ITEM_COLOURS: [number, number, number][] = [[90, 200, 120], [215, 205, 90], [200, 120, 210], [120, 210, 210]];
/** Skin inside something it should not be in is painted this colour. */
export const MARK: [number, number, number] = [255, 40, 40];

export interface SheetScene {
  body: Body;
  items: HeldItem[];
  /** Per skin part, per vertex: paint it as a fault. */
  marks?: Uint8Array[];
}

function drawables(scene: SheetScene, skipHead: boolean): Drawable[] {
  const { body } = scene;
  const skin = posedSkin(body);
  const out: Drawable[] = [];
  body.skin.forEach((part, pi) => {
    const n = part.region.length;
    const colours = new Uint8Array(n * 3);
    for (let v = 0; v < n; v++) colours.set(scene.marks?.[pi]?.[v] ? MARK : REGION_COLOUR[part.region[v]] ?? [128, 128, 128], v * 3);
    let index = part.index;
    if (skipHead) {
      const keep: number[] = [];
      for (let t = 0; t + 2 < index.length; t += 3) if (part.region[index[t]] !== Region.Head) keep.push(index[t], index[t + 1], index[t + 2]);
      index = Uint32Array.from(keep);
    }
    out.push({ positions: skin[pi], index, colour: [128, 128, 128], colours });
  });
  scene.items.forEach((it, k) => {
    for (const p of it.pieces) out.push({ positions: p.positions, index: p.index, colour: ITEM_COLOURS[k % ITEM_COLOURS.length], matrix: it.matrix });
  });
  return out;
}

/** The body's facing and up as posed now (the chest's turn carries the rest facing). */
function frame(body: Body) {
  const chest = body.spine.length ? body.spine[body.spine.length - 1] : null;
  const q = chest ? worldDelta(body, chest) : new Quaternion();
  const forward = body.forward.clone().applyQuaternion(q).setY(0).normalize();
  const up = new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(forward, up).normalize();
  return { forward, up, right };
}

/** Where to look: the arms, hands and whatever they hold. */
function focus(body: Body, items: HeldItem[]): { centre: Vector3; half: number } {
  const pts: Vector3[] = [];
  for (const l of Object.values(body.limbs)) if (l) pts.push(worldPos(l.upper), worldPos(l.fore), worldPos(l.hand), ...l.fingers.map((f) => worldPos(f.bones[f.bones.length - 1])));
  for (const it of items) for (const c of [it.min, it.max]) pts.push(c.clone().applyMatrix4(it.matrix));
  const lo = new Vector3(Infinity, Infinity, Infinity), hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of pts) { lo.min(p); hi.max(p); }
  const centre = lo.clone().add(hi).multiplyScalar(0.5);
  return { centre, half: Math.max(0.12, hi.clone().sub(lo).length() * 0.5 + 0.04) };
}

export function views(body: Body, items: HeldItem[]): Record<ViewName, View> {
  const { forward, up, right } = frame(body);
  const { centre, half } = focus(body, items);
  const far = 3;
  const head = body.head ? worldPos(body.head) : centre.clone().addScaledVector(up, 0.4);
  // the eye: in front of the head bone, a little above it, looking ahead and down to where the hands work
  const eye = head.clone().addScaledVector(up, 0.08).addScaledVector(forward, 0.1);
  return {
    front: { name: 'front', eye: centre.clone().addScaledVector(forward, far), target: centre, up, half },
    left: { name: 'left', eye: centre.clone().addScaledVector(right, -far), target: centre, up, half },
    right: { name: 'right', eye: centre.clone().addScaledVector(right, far), target: centre, up, half },
    // shoulder blades and the backs of the arms, where a raised arm stretches the skin
    back: { name: 'back', eye: centre.clone().addScaledVector(forward, -far), target: centre, up, half },
    above: { name: 'above', eye: centre.clone().addScaledVector(up, far), target: centre, up: forward, half },
    eye: { name: 'eye', eye, target: eye.clone().addScaledVector(forward, 1).addScaledVector(up, -0.35), up, fov: 75 },
  };
}

export interface Tile {
  caption: string;
  /** Short words in red under the caption, such as how many checks fail. */
  warn?: string;
}

/** One row of the five views of the scene as it is posed now. */
export function poseRow(scene: SheetScene, size = 300, tile?: Tile): Picture[] {
  const vs = views(scene.body, scene.items);
  const all = drawables(scene, false), noHead = drawables(scene, true);
  return VIEWS.map((v) => {
    const p = render(v === 'eye' ? noHead : all, vs[v], size, size);
    label(p, `${tile?.caption ?? ''} ${v}`.trim(), 6, 6, [235, 235, 235]);
    if (tile?.warn) label(p, tile.warn, 6, 20, [255, 80, 80]);
    return p;
  });
}

/** Rows of tiles stacked into one picture, with a gap between tiles. */
export function stack(rows: Picture[][], gap = 4): Picture {
  const w = Math.max(...rows.map((r) => r.reduce((n, p) => n + p.width + gap, gap)));
  const h = rows.reduce((n, r) => n + Math.max(...r.map((p) => p.height)) + gap, gap);
  const out = picture(w, h, [8, 8, 10]);
  let y = gap;
  for (const r of rows) {
    let x = gap;
    for (const p of r) { blit(out, p, x, y); x += p.width + gap; }
    y += Math.max(...r.map((p) => p.height)) + gap;
  }
  return out;
}
