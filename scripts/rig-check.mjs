#!/usr/bin/env node
/**
 * Rig Check from the command line: is a skinned character or creature fit to animate? It is compared with a default rig
 * (a humanoid's bones, lengths, mirror; every bone's aim; every joint inside the skin), every weight is checked (unweighted,
 * sums, more than 4 bones, weights on far bones, spikes, left against right) and every joint is turned to see the skin hold
 * (thickness kept, edges torn, skin dragged, skin left behind) by as much as animation turns it. Headless in Blender, for any skeleton. Built so Claude can take a model from
 * anywhere, prove it will animate, and fix its weights without a window.
 *
 *   node scripts/rig-check.mjs check <model> [--report <file.json>] [--kind auto|humanoid|creature] [--quick] [--ranges <file.json>]
 *   node scripts/rig-check.mjs fix   <model> [--unweighted] [--far] [--spikes] [--orphans] [--leaks] [--limbs] [--smooth] [--mirror] [--save <out.blend>] [--export <out.fbx|.glb>]
 *
 *   node scripts/rig-check.mjs selftest      (Rig Check's own test: a built body and each fault put into it; npm run test:blender)
 *
 * <model> is a .fbx, .glb, .gltf or .blend. Every check and option is described at the top of blender/rig_check.py.
 * Exit code 0: nothing fails; 3: something fails (the report says what and how to fix it); 1: an error.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, model, ...rest] = process.argv.slice(2);
const selftest = cmd === 'selftest';
const script = resolve(here, '..', 'blender', selftest ? 'test_rig_check.py' : 'rig_check.py');
if (!selftest && (!['check', 'fix'].includes(cmd) || !model)) {
  console.error('usage: node scripts/rig-check.mjs check|fix <model.blend|fbx|glb> [options]  (see blender/rig_check.py)');
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
const pathOpts = new Set(['--report', '--shots', '--save', '--export', '--in', '--ranges']);
const args = selftest ? [] : [cmd, '--in', resolve(model)];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  args.push(a);
  if (pathOpts.has(a) && i + 1 < rest.length) args.push(resolve(rest[++i]));
  else if (a.startsWith('--') && i + 1 < rest.length && !rest[i + 1].startsWith('--') && !['--unweighted', '--far', '--spikes', '--orphans', '--leaks', '--limbs', '--smooth', '--mirror', '--quick'].includes(a)) args.push(rest[++i]);
}
const quoted = args.map((a) => `"${a.replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join(' ');
const blender = findBlender();
const child = spawn(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script], {
  env: { ...process.env, RIGCHECK_ARGS: quoted },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let tail = '';
child.stdout.on('data', (d) => {
  for (const line of d.toString().split(/\r?\n/)) {
    if (line.startsWith('[rig_check]') || line.startsWith('[test_rig_check]')) console.log(line);
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
