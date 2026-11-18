#!/usr/bin/env node
/**
 * Checks every clip in a motion file (docs/motion-check.md) frame by frame on Handhold's own copy of the character: the
 * whole-pose checks on every frame (worst frame kept), each hand staying on what it holds, joint speed, and the ends against
 * the hold or each other. Writes <out>/<clip>/sheet.png (about eight moments, every view) and records each clip in
 * <out>/review.json for a verdict (scripts/review.mjs).
 *
 *   node scripts/motion-check.mjs --motion <motion.json> --out <dir> [--unreviewed]
 *
 * Exit code: 0 when every check passes and every clip in the review is approved; 3 when anything fails, is pending or is
 * rejected (--unreviewed: only failures count); 1 on an error. Headless: no window, no browser.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { importTs } from './lib/ts.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
if (!opt('motion') || !opt('out')) {
  console.error('motion-check: usage: motion-check.mjs --motion <motion.json> --out <dir> [--unreviewed] (see the top of scripts/motion-check.mjs)');
  process.exit(1);
}
const out = resolve(opt('out'));
mkdirSync(out, { recursive: true });
const { checkMotion } = await importTs('src/check/motion.ts');
const R = await importTs('src/check/review.ts');
const reviewPath = resolve(out, 'review.json');
const review = R.readReview(reviewPath);
let results;
try {
  results = await checkMotion(resolve(opt('motion')), out, review);
} catch (e) {
  console.error(`motion-check: ${e.message}`);
  process.exit(1);
}
R.writeReview(reviewPath, review);
for (const r of results) {
  const bad = r.checks.filter((c) => !c.pass);
  console.log(`${r.clip}: ${bad.length ? `${bad.length} FAIL` : 'every check passes'}  sheet: ${r.sheet}`);
  for (const c of bad) console.log(`  FAIL ${c.id}  ${c.value}${c.unit} (${c.below ? '<=' : '>='} ${c.limit})${c.frame !== undefined ? ` at frame ${c.frame}` : ''}  ${c.about}`);
}
const left = R.blocking(review).filter((b) => !args.includes('--unreviewed') || /fails/.test(b));
if (left.length) {
  console.log(`not done:\n  ${left.join('\n  ')}`);
  process.exit(3);
}
