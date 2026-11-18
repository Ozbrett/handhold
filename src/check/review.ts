import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Check } from './poseCheck';

/**
 * The review file: every pose or animation a run drew, its checks, its contact sheet and the verdict on it. A run writes
 * "pending" for anything new or changed; only `review.mjs approve|reject` writes a verdict. An export or a game-holds run stops
 * while anything is pending, rejected or failing, so a hold the machine passes still waits for someone to look at it.
 */

export type Verdict = 'pending' | 'approved' | 'rejected';

export interface ReviewItem {
  name: string;
  kind: 'pose' | 'motion';
  sheet: string;
  pass: boolean;
  checks: Check[];
  verdict: Verdict;
  note: string;
  /** What was drawn and measured: a verdict is kept only while this is unchanged. */
  fingerprint: string;
}

export interface Review {
  format: 'handhold-review';
  version: 1;
  items: ReviewItem[];
}

export const empty = (): Review => ({ format: 'handhold-review', version: 1, items: [] });

export function readReview(path: string): Review {
  if (!existsSync(path)) return empty();
  const r = JSON.parse(readFileSync(path, 'utf8')) as Review;
  if (r.format !== 'handhold-review') throw new Error(`${path} is not a handhold review file`);
  return r;
}

export function writeReview(path: string, r: Review) {
  r.items.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(path, JSON.stringify(r, null, 1));
}

/** A fingerprint of the inputs and every measured value (to a tenth of a unit). */
export function fingerprint(inputs: string[], checks: Check[]): string {
  const h = createHash('sha1');
  for (const i of inputs) h.update(i);
  for (const c of checks) h.update(`${c.id}=${c.value};`);
  return h.digest('hex').slice(0, 16);
}

/** Puts a run's result in the review: a verdict already given stays only if nothing it was given on has changed. */
export function record(r: Review, item: Omit<ReviewItem, 'verdict' | 'note'>): ReviewItem {
  const old = r.items.find((x) => x.name === item.name);
  const keep = old && old.fingerprint === item.fingerprint;
  const next: ReviewItem = { ...item, verdict: keep ? old!.verdict : 'pending', note: keep ? old!.note : '' };
  if (old) r.items[r.items.indexOf(old)] = next;
  else r.items.push(next);
  return next;
}

export function setVerdict(r: Review, name: string, verdict: Exclude<Verdict, 'pending'>, note: string): ReviewItem {
  const it = r.items.find((x) => x.name === name);
  if (!it) throw new Error(`no ${name} in the review (there are: ${r.items.map((x) => x.name).join(', ') || 'none'})`);
  if (verdict === 'approved' && !it.pass) throw new Error(`${name} fails ${it.checks.filter((c) => !c.pass).length} checks: fix it, it cannot be approved`);
  it.verdict = verdict;
  it.note = note;
  return it;
}

/** What still stops an export: anything failing, pending or rejected. */
export function blocking(r: Review): string[] {
  return r.items.flatMap((x) => (!x.pass ? [`${x.name}: fails ${x.checks.filter((c) => !c.pass).map((c) => c.id).join(', ')}`] : x.verdict !== 'approved' ? [`${x.name}: ${x.verdict}${x.note ? ` (${x.note})` : ''}`] : []));
}
