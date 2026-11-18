import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { type Body, type FingerName, type Side, buildBody, posedSkin } from './body';
import { type HeldItem, depthInItem } from './items';
import { loadCharacter } from './load';
import { encodePng } from './png';
import { type Check, type GripSpec, checkPose, skinChecks } from './poseCheck';
import type { PoseFile } from './poseFile';
import { type Review, fingerprint, record } from './review';
import { type ItemSpec, aimFor, holdOn, loadItem } from './scene';
import { poseRow, stack } from './sheet';

/**
 * One hold checked end to end: a character, a held item aimed the way the game aims it, a pose file for each hand on it; the
 * arms solved, every whole-pose check run, a contact sheet drawn and the result put in the review file.
 */

export interface HandSpec {
  side: Side;
  pose: string;
  /** This hand holds a grip: the pieces that are the grip and the fingers that wrap it. */
  grip?: { pieces: string[]; wrap: FingerName[] };
}

export interface HoldSpec {
  name: string;
  character: string;
  item: ItemSpec;
  hands: HandSpec[];
}

const bodies = new Map<string, Body>();

export async function bodyFor(path: string): Promise<Body> {
  let b = bodies.get(path);
  if (!b) {
    const found = buildBody(await loadCharacter(path));
    if (!found) throw new Error(`${path}: no arm with a hand and fingers found`);
    b = found;
    bodies.set(path, b);
  }
  return b;
}

/** Skin inside the items (deeper than `limit` metres), torn or folded, per part and vertex, to paint on the sheet. */
export function marksInside(body: Body, items: HeldItem[], limit = 0.002): Uint8Array[] {
  const skin = posedSkin(body);
  const p = new Vector3();
  const marks = body.skin.map((s, pi) => {
    const m = new Uint8Array(s.region.length);
    for (const it of items) {
      const inv = it.matrix.clone().invert();
      for (let v = 0; v < m.length; v++) {
        p.fromArray(skin[pi], v * 3).applyMatrix4(inv);
        if (p.x < it.min.x || p.y < it.min.y || p.z < it.min.z || p.x > it.max.x || p.y > it.max.y || p.z > it.max.z) continue;
        if (depthInItem(it, p) > limit) m[v] = 1;
      }
    }
    return m;
  });
  skinChecks(body, skin, marks);
  return marks;
}

/** The solver's own word on each hand: how far the hand bone ended from where its pose file puts it on the item. */
export function reachChecks(gaps: Partial<Record<Side, number>>, item: string): Check[] {
  return (Object.entries(gaps) as [Side, number][]).map(([side, g]) => {
    const mm = Math.round(g * 10000) / 10;
    return { id: `${side}.reach`, about: `${side} hand reaches its place on ${item}`, value: mm, unit: 'mm', limit: 1, below: true, pass: mm <= 1 };
  });
}

export async function checkHold(spec: HoldSpec, outDir: string, review: Review): Promise<{ checks: Check[]; sheet: string }> {
  const body = await bodyFor(spec.character);
  const item = loadItem(spec.item);
  const poses = spec.hands.map((h) => ({ side: h.side, pose: JSON.parse(readFileSync(h.pose, 'utf8')) as PoseFile }));
  const solved = holdOn(body, item, aimFor(body, item, poses), poses);
  const grips: GripSpec[] = spec.hands.filter((h) => h.grip).map((h) => ({ side: h.side, item: item.name, pieces: h.grip!.pieces, wrap: h.grip!.wrap }));
  const checks = [...checkPose({ body, items: [item], grips, sides: spec.hands.map((h) => h.side) }), ...reachChecks(solved.gaps, item.name)];
  const bad = checks.filter((c) => !c.pass).length;
  const dir = join(outDir, spec.name);
  mkdirSync(dir, { recursive: true });
  const row = poseRow({ body, items: [item], marks: marksInside(body, [item]) }, 300, { caption: spec.name, warn: bad ? `${bad} FAIL` : undefined });
  const sheet = join(dir, 'sheet.png');
  writeFileSync(sheet, encodePng(stack([row])));
  const inputs = [spec.character, spec.item.obj, ...spec.hands.map((h) => readFileSync(h.pose, 'utf8'))];
  record(review, { name: spec.name, kind: 'pose', sheet: `${spec.name}/sheet.png`, pass: bad === 0, checks, fingerprint: fingerprint(inputs, checks) });
  return { checks, sheet };
}
