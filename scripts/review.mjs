#!/usr/bin/env node
/**
 * The verdicts on checked holds and motions. hold-check.mjs and motion-check.mjs put each result in <dir>/review.json as
 * "pending"; a person or Claude looks at its sheet and approves or rejects it here. A failing item cannot be approved, and an
 * item whose inputs or checks change goes back to pending.
 *
 *   node scripts/review.mjs status  <dir>
 *   node scripts/review.mjs approve <dir> <name> --note "<what the sheet shows>"
 *   node scripts/review.mjs reject  <dir> <name> --note "<what is wrong>"
 *
 * Exit code: status exits 3 while anything is pending, rejected or failing, 0 when everything is approved; 1 on an error.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { importTs } from './lib/ts.mjs';

const [cmd, dir, name] = process.argv.slice(2);
const i = process.argv.indexOf('--note');
const note = i >= 0 ? process.argv[i + 1] ?? '' : '';
if (!['status', 'approve', 'reject'].includes(cmd) || !dir || (cmd !== 'status' && !name)) {
  console.error('review: usage: review.mjs status <dir> | approve|reject <dir> <name> --note "<why>" (see the top of scripts/review.mjs)');
  process.exit(1);
}
const path = resolve(dir, 'review.json');
if (!existsSync(path)) {
  console.error(`review: no ${path}; run hold-check.mjs or motion-check.mjs with --out ${dir} first`);
  process.exit(1);
}
const R = await importTs('src/check/review.ts');
const review = R.readReview(path);
if (cmd !== 'status') {
  if (!note.trim()) {
    console.error('review: a verdict needs --note saying what the sheet shows');
    process.exit(1);
  }
  try {
    const it = R.setVerdict(review, name, cmd === 'approve' ? 'approved' : 'rejected', note);
    R.writeReview(path, review);
    console.log(`${it.name}: ${it.verdict}`);
  } catch (e) {
    console.error(`review: ${e.message}`);
    process.exit(1);
  }
}
for (const it of review.items) {
  const bad = it.checks.filter((c) => !c.pass).length;
  console.log(`${it.verdict.padEnd(8)} ${bad ? `${bad} FAIL` : 'checks pass'}  ${it.name}  ${resolve(dir, it.sheet)}${it.note ? `  (${it.note})` : ''}`);
}
const left = R.blocking(review);
if (cmd === 'status' && left.length) process.exit(3);
