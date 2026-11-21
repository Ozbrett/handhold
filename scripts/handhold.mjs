/**
 * Handhold from the command line: make a hand or a character hold a prop and
 * write the grip and every export into one folder, with no window opened.
 * Built so Claude (or any script) can drive Handhold without clicking.
 *
 *   node scripts/handhold.mjs --hand <file> --object <file> [options]
 *
 * Options
 *   --grip fx,fy,fz      where the palm goes, as fractions of the object's
 *                        bounding box (0..1 on each axis). Default 0.5,0.5,0.5
 *   --size n             object size in hand lengths. Default: as the file is
 *   --pick 0|1|left|right  which hand of a whole character. Default right
 *   --second fx,fy,fz    hold it with both hands; the second hand's spot
 *   --arm none|hold|sweep  place the arm (characters only). Default hold
 *   --hold f,u,o         wrist position as fractions of the arm's reach:
 *                        forward, up, outward from the shoulder
 *   --sweep-to f,u,o     with --arm sweep: where the sweep ends
 *   --turn t,y,r         turn the held object: tilt, turn, roll in degrees
 *   --mode animation|hold|camera  how the arm moves in the game
 *   --at x,y,z           hold here instead (object file units and axes), not a box fraction
 *   --fingers x,y,z      with --at: the way the fingers point out of the fist (object axes)
 *   --thumb x,y,z        with --at: the way the knuckle line runs from little finger to index (object axes)
 *   --at2 / --fingers2 / --thumb2  the same for the second hand (two-handed)
 *   --carried            something else carries the weight (other hand, shoulder): judge each hand with the weight at its spot
 *
 * Saved poses, animations and looks (characters only; all are written into every export)
 *   --style everyday|tool|weapon  the item type the animations are made for. Default everyday
 *   --clips a,b,...      ready-made animations: idle, walk, run,
 *                        use (swing / fire / use), raise (ready / aim / show),
 *                        second (turn over / reload). Rename one with kind:Name
 *   --poses A/B/...      still poses, by name. "Held" saves the hold position;
 *                        "Raised:0.4,0.3,0.1" saves one at those fractions of the arm's
 *                        reach (forward, up, outward); add "@tilt,turn,roll" to turn the wrist
 *   --look [Name]        the arm follows where the player looks. Default name Look
 *   --look-range u,d,l,r how far it follows up, down, left and right, in degrees.
 *                        Default 50,40,45,45
 *
 *   --out <folder>       where to write everything. Default handhold-out/<hand>-<object>
 *   --name <name>        file name prefix. Default grip
 *
 * Review
 *   --review <folder>    the review.json folder (scripts/hold-check.mjs, scripts/motion-check.mjs) that covers these
 *                        holds. The exports are written either way, but they are not final until every item there is
 *                        approved: the exit code is 3 while anything there is pending, rejected or failing, or when no
 *                        review is given
 *   --unreviewed         take the exports without a review: only a grip that does not hold fails the run
 *
 * --hand sample uses the built-in player (a rigged mannequin); --object sample:hammer
 * (or stick, box, ball, mug) uses a built-in prop.
 *
 * Writes the posed .glb, the .pose.json, the Unity / Godot / Blender
 * packages, screenshots, and summary.json (what was found, whether each grip
 * holds, what the wrist and the second hand did). Exits 1 if no grip holds, 3 if the holds are not yet reviewed (see Review).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[key] = true;
  else {
    args[key] = next;
    i++;
  }
}
if (!args.hand || !args.object || args.help) {
  console.log(readUsage());
  process.exit(args.help ? 0 : 2);
}

const triple = (name) => {
  const v = args[name];
  if (v === undefined) return undefined;
  const parts = String(v).split(',').map(Number);
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) {
    console.error(`--${name} needs three numbers separated by commas, like 0.5,0.5,0.5`);
    process.exit(2);
  }
  return parts.join(',');
};

const builtIn = (v) => v === 'sample' || v === 'sample-hand' || String(v).startsWith('sample:');
const hand = builtIn(args.hand) ? String(args.hand) : resolve(args.hand);
const object = builtIn(args.object) ? String(args.object) : resolve(args.object);
for (const f of [hand, object]) {
  if (!builtIn(f) && !existsSync(f)) {
    console.error('No such file:', f);
    process.exit(2);
  }
}
const stem = (f) => (builtIn(f) ? f.replace(/^sample:?/, 'sample-') : basename(f, extname(f))).replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '').toLowerCase();
const name = String(args.name ?? 'grip');
const out = resolve(String(args.out ?? join('handhold-out', `${stem(hand)}-${stem(object)}`)));
mkdirSync(out, { recursive: true });

const grip = triple('grip') ?? '0.5,0.5,0.5';
const objectArg = [object, grip, args.size ? String(Number(args.size)) : ''].filter((x, i) => i < 2 || x).join('@');

const env = { ...process.env, EXPORT: '1', OUT_DIR: out };
if (args.pick !== undefined) env.HAND_PICK = String(args.pick);
// hold it this way: a point in the object file's own axes, and the way the fingers and the thumb point (both or neither)
const aimSpec = (at, f, t) => [triple(at), args[f] ? triple(f) : null, args[t] ? triple(t) : null].filter(Boolean).join(';');
if (args.carried) env.CARRIED = '1';
if (args.at) env.AIM = aimSpec('at', 'fingers', 'thumb');
if (args.at2) env.AIM2 = aimSpec('at2', 'fingers2', 'thumb2');
if (args.second) env.TWO = triple('second');
const arm = String(args.arm ?? 'hold');
if (arm === 'hold') env.ARM = 'hold';
else if (arm === 'sweep') env.ARM = '1';
else if (arm !== 'none') {
  console.error('--arm is none, hold or sweep');
  process.exit(2);
}
if (args.hold) env.HOLD = triple('hold');
if (args['sweep-to']) env.SWEEP_TO = triple('sweep-to');
if (args.turn) env.TURN = triple('turn');
if (args.mode) env.ARMMODE = String(args.mode);
if (args.style) {
  if (!['everyday', 'tool', 'weapon'].includes(String(args.style))) {
    console.error('--style is everyday, tool or weapon');
    process.exit(2);
  }
  env.STYLE = String(args.style);
}
if (args.clips) {
  const kinds = ['idle', 'walk', 'run', 'use', 'raise', 'second'];
  const asked = String(args.clips).split(',').map((c) => c.trim()).filter(Boolean);
  // "look" used to be an animation; it is a look now
  const look = asked.find((c) => c.split(':')[0] === 'look');
  if (look && !args.look) args.look = look.split(':')[1] ?? true;
  const clips = asked.filter((c) => c.split(':')[0] !== 'look');
  const bad = clips.map((c) => c.split(':')[0]).filter((k) => !kinds.includes(k));
  if (bad.length) {
    console.error(`--clips takes ${kinds.join(', ')} (optionally kind:Name); not ${bad.join(', ')}`);
    process.exit(2);
  }
  if (clips.length) env.CLIPS = clips.join(',');
}
if (args.poses) {
  const poses = String(args.poses).split('/').map((p) => p.trim()).filter(Boolean);
  const three = (text) => text.split(',').length === 3 && text.split(',').every((x) => x.trim() !== '' && Number.isFinite(Number(x)));
  for (const p of poses) {
    const [poseName, where] = p.split(':');
    const [at, turn] = (where ?? '').split('@');
    if (!poseName || (where !== undefined && !three(at)) || (turn !== undefined && !three(turn))) {
      console.error(`--poses: "${p}" should be Name, Name:forward,up,out or Name:forward,up,out@tilt,turn,roll`);
      process.exit(2);
    }
  }
  env.POSES = poses.join('/');
}
if (args.look) {
  env.LOOK = args.look === true ? 'Look' : String(args.look);
  if (args['look-range']) {
    const r = String(args['look-range']).split(',').map(Number);
    if (r.length !== 4 || r.some((x) => !Number.isFinite(x) || x < 0)) {
      console.error('--look-range needs four angles in degrees: up,down,left,right, like 50,40,45,45');
      process.exit(2);
    }
    env.LOOK_RANGE = r.join(',');
  }
}
if ((env.CLIPS || env.POSES || env.LOOK) && arm === 'none')
  console.error('Note: saved poses, animations and looks move the arm, so they need a character with arm bones; --arm none is ignored for them.');

// the headless run uses the built site
if (!existsSync(join(root, 'dist', 'index.html')) || args.build) {
  console.log('Building the site first...');
  const b = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const started = Date.now();
const lines = [];
const child = spawn(process.execPath, [join(root, 'scripts', 'try-models.mjs'), name, hand, objectArg], { cwd: root, env });
const take = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  lines.push(...text.split(/\r?\n/).filter(Boolean));
};
child.stdout.on('data', take);
child.stderr.on('data', take);
const code = await new Promise((r) => child.on('close', r));

// ---- summary
const find = (prefix) => lines.find((l) => l.trim().startsWith(prefix))?.trim().slice(prefix.length).trim() ?? null;
const json = (text) => {
  if (!text) return null;
  const at = text.indexOf(':', text.indexOf(')') >= 0 ? text.indexOf(')') : 0);
  try {
    return JSON.parse(text.slice(at + 1).trim());
  } catch {
    return null;
  }
};
const grips = json(find('GRIPS')) ?? [];
const files = readdirSync(out)
  .filter((f) => f.startsWith(name + '-') && statSync(join(out, f)).mtimeMs >= started - 1000)
  .sort();
const pick = (re) => files.filter((f) => re.test(f)).map((f) => join(out, f));
/** The animations inside a .glb, by name and length in seconds. */
const animationsIn = (path) => {
  try {
    const glb = readFileSync(path);
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    return (gltf.animations ?? []).map((a) => {
      const input = gltf.accessors[a.samplers[0]?.input];
      return { name: a.name, seconds: input?.max?.[0] ?? null, channels: a.channels.length };
    });
  } catch {
    return [];
  }
};
const summary = {
  hand,
  object,
  grip,
  size: args.size ? Number(args.size) : null,
  twoHands: !!args.second,
  handFound: json(find('HAND')),
  grips,
  holds: grips.some((g) => g.holds),
  secondHand: find('SECOND HAND at the hold:') ?? find('SECOND HAND:'),
  wrist: find('WRIST at the hold:') ?? lines.filter((l) => l.includes('WRIST at')).map((l) => l.trim()),
  exports: {
    glb: pick(/\.glb$/)[0] ?? null,
    pose: pick(/\.pose\.json$/)[0] ?? null,
    unity: pick(/\.unitypackage$/)[0] ?? null,
    godot: pick(/-godot\.zip$/)[0] ?? null,
    blender: pick(/-blender\.zip$/)[0] ?? null,
  },
  // the views worth looking at first: the chosen grip, and the arm from in front
  views: [...pick(/-1-grip\.png$/), ...pick(/-two-1\.png$/), ...pick(/-front\.png$/)],
  // what was saved into the exports: poses, animations and looks, by name
  saved: (() => {
    try {
      return JSON.parse(find('SAVED:') ?? '[]');
    } catch {
      return [];
    }
  })(),
  // every animation in the posed model: Grip, Sweep, and one or two for each saved item
  animations: pick(/\.glb$/)[0] ? animationsIn(pick(/\.glb$/)[0]) : [],
  problems: lines.filter((l) => l.startsWith('PROBLEMS:') || l.startsWith('STOPPED:')),
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nSUMMARY ${join(out, 'summary.json')}: ${grips.length} grips, ${summary.holds ? 'holds' : 'DOES NOT HOLD'}` +
  (summary.secondHand ? `; second hand: ${summary.secondHand}` : '') +
  `; exports: ${Object.values(summary.exports).filter(Boolean).length} of 5` +
  (summary.animations.length ? `; animations: ${summary.animations.map((a) => a.name).join(', ')}` : ''));
if (!(code === 0 && summary.holds && summary.problems.length === 0)) process.exit(1);
if (!args.unreviewed) {
  const left = await reviewLeft(args.review);
  if (left.length) {
    console.log(`not final (review, or pass --unreviewed):
  ${left.join('\n  ')}`);
    process.exit(3);
  }
}
process.exit(0);

/** What the review still holds up; a missing review holds up everything. */
async function reviewLeft(dir) {
  if (!dir || dir === true) return ['no --review folder given: check the holds with scripts/hold-check.mjs and review them with scripts/review.mjs'];
  const path = resolve(dir, 'review.json');
  if (!existsSync(path)) return [`no ${path}`];
  const { importTs } = await import('./lib/ts.mjs');
  const R = await importTs('src/check/review.ts');
  const r = R.readReview(path);
  return r.items.length ? R.blocking(r) : [`${path} has nothing in it`];
}

function readUsage() {
  return `usage: node scripts/handhold.mjs --hand <file> --object <file> [--grip fx,fy,fz] [--size n] [--pick 0|1|left|right]
       [--second fx,fy,fz] [--arm none|hold|sweep] [--hold f,u,o] [--sweep-to f,u,o] [--turn t,y,r]
       [--mode animation|hold|camera] [--style everyday|tool|weapon] [--clips idle,walk,use,...]
       [--poses Held/Raised:0.4,0.3,0.1] [--look [Name]] [--look-range up,down,left,right]
       [--out folder] [--name name] [--build] [--review folder | --unreviewed]
--hand sample uses the built-in rigged player; --object sample:hammer (stick, box, ball, mug) a built-in prop.
See the comment at the top of scripts/handhold.mjs for what each option does.`;
}
