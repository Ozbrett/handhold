#!/usr/bin/env node
/**
 * Rig Doctor from the command line: checks and fixes how a character's skin follows its arms (sleeves over the hand, cuffs
 * weighted to the hand, loose scraps, a wrist that pinches when it turns), headless in Blender. Built so Claude can look at a
 * character, fix it and prove the fix without a window.
 *
 *   node scripts/rig-doctor.mjs check <model> [--shots <prefix>] [--report <file.json>] [--side l|r|both]
 *   node scripts/rig-doctor.mjs fix   <model> [--trim] [--scraps] [--cuff] [--blend] [--seams] [--save <out.blend>] [--export <out.fbx|.glb>]
 *                                             [--trim-past m] [--scrap-max share] [--cuff-follow share] [--cuff-band m] [--blend-len m]
 *
 * <model> is a .blend (fixed in place only with --save; its actions are kept), .fbx, .glb or .gltf. Every option is described
 * at the top of blender/rig_doctor.py. Blender is found at $BLENDER, or the newest one in the usual install folder.
 * Exit code 0: every arm passes; 3: something is left to fix (the findings say what); 1: an error.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', 'blender', 'rig_doctor.py');
const [cmd, model, ...rest] = process.argv.slice(2);
if (!['check', 'fix'].includes(cmd) || !model) {
  console.error('usage: node scripts/rig-doctor.mjs check|fix <model.blend|fbx|glb> [options]  (see blender/rig_doctor.py)');
  process.exit(1);
}

function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const roots = process.platform === 'win32'
    ? ['C:/Program Files/Blender Foundation']
    : process.platform === 'darwin' ? ['/Applications'] : ['/usr/bin', '/opt'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (process.platform === 'win32') {
      const versions = readdirSync(root).filter((d) => /^Blender/.test(d)).sort().reverse();
      for (const v of versions) {
        const exe = join(root, v, 'blender.exe');
        if (existsSync(exe)) return exe;
      }
    } else if (process.platform === 'darwin') {
      const exe = '/Applications/Blender.app/Contents/MacOS/Blender';
      if (existsSync(exe)) return exe;
    } else if (existsSync(join(root, 'blender'))) return join(root, 'blender');
  }
  return 'blender';
}

// paths are made absolute here, so the report and pictures land where they were asked for whatever folder Blender runs in
const pathOpts = new Set(['--report', '--shots', '--save', '--export', '--in']);
const args = [cmd, '--in', resolve(model)];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  args.push(a);
  if (pathOpts.has(a) && i + 1 < rest.length) args.push(resolve(rest[++i]));
  else if (a.startsWith('--') && i + 1 < rest.length && !rest[i + 1].startsWith('--') && !['--trim', '--scraps', '--cuff', '--blend', '--seams'].includes(a)) args.push(rest[++i]);
}
const quoted = args.map((a) => `"${a.replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join(' ');
const blender = findBlender();
const child = spawn(blender, ['--background', '--factory-startup', '--python', script], {
  env: { ...process.env, RIGDOCTOR_ARGS: quoted },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let tail = '';
child.stdout.on('data', (d) => {
  for (const line of d.toString().split(/\r?\n/)) {
    if (line.startsWith('[rig_doctor]')) console.log(line);
    else if (line.trim()) tail = (tail + '\n' + line).slice(-4000);
  }
});
child.stderr.on('data', (d) => (tail = (tail + '\n' + d.toString()).slice(-4000)));
child.on('close', (code) => {
  if (code === 1) console.error(tail.trim());
  process.exit(code ?? 1);
});
child.on('error', (e) => {
  console.error(`could not start Blender (${blender}): ${e.message}. Set BLENDER to its path.`);
  process.exit(1);
});
