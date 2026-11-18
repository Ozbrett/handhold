/**
 * Close-ups of a game's hands as the game itself poses them: for every hold in a game-holds manifest, loads the game_*.obj that
 * the game wrote (the held thing plus its arms, posed by the game's own code) and shoots it from both sides of
 * the hand, from the same places game-holds.mjs --shots uses. Headless; nothing opens on screen.
 *
 *   node scripts/game-view.mjs --in <folder with manifest.json and game_*.obj> [--out folder] [--only grip,reload] [--frames 3,4]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[argv[i].slice(2)] = true;
  else args[argv[i++].slice(2)] = next;
}
if (!args.in) {
  console.log('usage: node scripts/game-view.mjs --in <folder with manifest.json> [--out folder] [--only grip,reload] [--frames 3,4]');
  process.exit(2);
}
const inDir = resolve(args.in);
const out = resolve(args.out ?? join(inDir, 'views'));
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(inDir, 'manifest.json'), 'utf8'));
const only = args.only ? String(args.only).split(',') : null;
const frames = args.frames ? String(args.frames).split(',').map(Number) : null;
const items = manifest.items.filter((it) => it.pose !== 'idle' && (!only || only.includes(it.pose)) && (!frames || frames.includes(it.frame)));

process.chdir(root);
const server = await preview({ preview: { port: 4180 + Math.floor(Math.random() * 400), strictPort: false, host: '127.0.0.1' } });
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const problems = [];
let shots = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForSelector('.steps');
  for (const it of items) {
    const file = it.pose === 'torch' ? 'game_torch.obj' : `game_${it.pose === 'reload' ? 'reload' : 'grip'}_${it.frame}_${it.name}.obj`;
    if (!existsSync(join(inDir, file))) { problems.push(`${file} is missing`); continue; }
    // the middle of the hand's bones as the game placed them, in the held thing's (mirrored) axes, the same axes as the OBJ
    const pts = String(it.place).split(';').map((p) => p.split(':')[1]?.split(',').map(Number)).filter((p) => p?.length === 3);
    if (!pts.length) { problems.push(`${it.pose} ${it.frame}: no place`); continue; }
    const at = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    const ok = await page.evaluate(
      async ({ obj, file }) => {
        const hh = window.__handhold;
        await hh.actions.objectFile(new File([obj], file));
        return !!hh.object;
      },
      { obj: readFileSync(join(inDir, file), 'utf8'), file },
    );
    if (!ok) { problems.push(`${file} did not load`); continue; }
    const tag = `${it.pose}_${it.frame}_${it.side}`;
    for (const [i, s] of [1, -1].entries()) {
      await page.evaluate(
        ({ at, s }) => {
          const hh = window.__handhold;
          const v = hh.viewer;
          const V = v.camera.up.constructor;
          const size = 0.2; // about a hand's length, in the OBJ's units (metres)
          v.camTween = null;
          const m = hh.object.source.matrixWorld;
          v.controls.target.copy(new V(...at).applyMatrix4(m));
          v.camera.position.copy(new V(at[0] + s * size * 2.2, at[1] + size * 0.6, at[2] - size * 0.5).applyMatrix4(m));
          v.controls.update();
          v.invalidate();
        },
        { at, s },
      );
      await page.waitForTimeout(i === 0 ? 700 : 250);
      await page.screenshot({ path: join(out, `${tag}-${'ab'[i]}.png`), clip: { x: 350, y: 0, width: 750, height: 760 } });
      shots++;
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`${shots} shots of ${items.length} holds in ${out}${problems.length ? `; problems: ${problems.join('; ')}` : ''}`);
process.exit(problems.length ? 1 : 0);
