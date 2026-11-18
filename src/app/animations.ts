import { Vector3 } from 'three';
import type { ArmRig, HoldPose } from './armIk';

/**
 * What can be saved for a character holding an item. Three kinds:
 *
 *  - a pose: one still position of the arm;
 *  - a clip: a movement that plays (idle, walk, run and the item's own actions);
 *  - a look: the arm follows where the player looks. Looking up lifts the item, looking
 *    down lowers it, and looking left or right swings it round with the view.
 *
 * Everything saved goes into the export. Nothing else does.
 *
 * What a clip's actions are depends on the item type, so it works for any item:
 *  - everyday: use (push it forward, like pressing or handing it over), show (bring it up
 *    to look at), turn over (roll it in the hand to inspect it);
 *  - tool: swing (wind up, strike down, recover), ready (raised over the shoulder), turn over;
 *  - weapon: fire (a kick back and up), aim (raised to the eye line), reload (the second
 *    hand lets go while the item drops and rolls in).
 */

export type ItemStyle = 'everyday' | 'tool' | 'weapon';
export type MotionKind = 'idle' | 'walk' | 'run' | 'use' | 'raise' | 'second';

export const ITEM_STYLES: { id: ItemStyle; label: string; note: string }[] = [
  { id: 'everyday', label: 'Everyday', note: 'Cups, phones, torches, keys, books: anything carried and used.' },
  { id: 'tool', label: 'Tool', note: 'Hammers, axes, swords, bats, rackets: anything swung.' },
  { id: 'weapon', label: 'Weapon', note: 'Guns, bows and launchers: aimed, fired and reloaded.' },
];

/** What each action is called, by item type: [main action, raised hold, second action]. */
export const ACTION_WORDS: Record<ItemStyle, { use: string; raise: string; second: string }> = {
  everyday: { use: 'Use', raise: 'Show', second: 'Turn over' },
  tool: { use: 'Swing', raise: 'Ready', second: 'Turn over' },
  weapon: { use: 'Fire', raise: 'Aim', second: 'Reload' },
};

export function motionLabel(kind: MotionKind, style: ItemStyle): string {
  const w = ACTION_WORDS[style];
  return { idle: 'Idle', walk: 'Walk', run: 'Run', use: w.use, raise: w.raise, second: w.second }[kind];
}
/** The ready-made motions, in the order the panel lists them. */
export const MOTIONS: MotionKind[] = ['idle', 'walk', 'run', 'use', 'raise', 'second'];

export interface ClipFrame {
  /** Seconds from the start of the clip. */
  t: number;
  hold: HoldPose;
  /** How far (0..1) the second hand has let go of the item. */
  away: number;
}

export interface SavedPose {
  kind: 'pose';
  name: string;
  hold: HoldPose;
}

export interface SavedClip {
  kind: 'clip';
  name: string;
  frames: ClipFrame[];
  /** Walk, run and idle repeat; an action plays once. */
  loops: boolean;
}

export interface SavedLook {
  kind: 'look';
  name: string;
  /** Where the hand is while the player looks straight ahead. */
  centre: HoldPose;
  /** How far the view turns each way, in degrees. */
  up: number;
  down: number;
  left: number;
  right: number;
}

export type Saved = SavedPose | SavedClip | SavedLook;
export type SavedKind = Saved['kind'];

export const KIND_WORDS: Record<SavedKind, string> = { pose: 'Pose', clip: 'Animation', look: 'Look' };

export const LOOK_DEFAULTS = { up: 50, down: 40, left: 45, right: 45 };

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const copyHold = (h: HoldPose): HoldPose => ({ position: h.position.clone(), turn: [h.turn[0], h.turn[1], h.turn[2]] });

/**
 * Where a look holds the item for a view direction: `yaw` degrees to the right and `pitch`
 * degrees up (negative for left and down), kept inside the look's ranges. The hand swings
 * round the shoulder with the view and the item turns with it, so it keeps pointing where
 * the player looks.
 */
export function lookHold(arm: ArmRig, look: Pick<SavedLook, 'centre' | 'up' | 'down' | 'left' | 'right'>, yaw: number, pitch: number): HoldPose {
  const y = clamp(yaw, -look.left, look.right);
  const p = clamp(pitch, -look.down, look.up);
  const side = new Vector3().crossVectors(UP, arm.forward).normalize();
  const rel = look.centre.position.clone().sub(arm.shoulder);
  rel.applyAxisAngle(side, -p * DEG).applyAxisAngle(UP, -y * DEG);
  return {
    position: arm.shoulder.clone().add(rel),
    turn: [look.centre.turn[0] - p, look.centre.turn[1] - y, look.centre.turn[2]],
  };
}

const SECOND_SECONDS = 1.6;
const USE_SECONDS: Record<ItemStyle, number> = { everyday: 0.8, tool: 0.75, weapon: 0.35 };
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** Eases `from` towards `to` at `rate` per second; independent of the frame rate. */
const ease = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

/** An offset from the base hold: forward, up, outward (fractions of the arm's reach) and tilt, turn, roll (degrees). */
type Offset = [number, number, number, number, number, number];
const ZERO: Offset = [0, 0, 0, 0, 0, 0];
const mix = (a: Offset, b: Offset, t: number): Offset => a.map((v, i) => v + (b[i] - v) * t) as Offset;
const add = (a: Offset, b: Offset, k = 1): Offset => a.map((v, i) => v + b[i] * k) as Offset;

/** What drives one step of a motion. */
interface Drive {
  walking: boolean;
  run: boolean;
  raise: boolean;
}

/** Whole strides (two steps) a second when walking: about 1.9 steps a second. Running is faster. */
const STRIDE_HZ = 0.95;
const RUN_RATE = 1.5;

/** A motion stepped forward in time. Every value is eased towards where it is going. */
class Motion {
  time = 0;
  raise = 0;
  walk = 0;
  phase = 0;
  useT = -1;
  secondT = -1;

  constructor(public style: ItemStyle) {}

  step(dt: number, drive: Drive, arm: ArmRig, base: HoldPose): { hold: HoldPose; away: number } {
    this.time += dt;
    const reach = arm.upperLength + arm.foreLength;
    const side = new Vector3().crossVectors(UP, arm.forward).normalize();

    // walking: how fast, and the step cycle
    const going = drive.walking ? (drive.run ? 1.8 : 1) : 0;
    this.walk = ease(this.walk, going, 6, dt);
    this.phase += dt * 2 * Math.PI * STRIDE_HZ * (drive.run && going ? RUN_RATE : 1) * Math.min(1, this.walk * 2);
    this.raise = ease(this.raise, drive.raise ? 1 : 0, 8, dt);

    // the main action, as an offset from the hold
    let use: Offset = ZERO;
    if (this.useT >= 0) {
      this.useT += dt;
      const t = this.useT;
      if (this.style === 'weapon') {
        // a kick that dies away
        const k = t < 0.04 ? t / 0.04 : Math.exp(-9 * (t - 0.04));
        use = [-0.06 * k, 0.01 * k, 0, -10 * k, 0, 0];
      } else if (this.style === 'tool') {
        // wind up, strike, recover
        const up: Offset = [-0.1, 0.2, 0.02, -55, 0, 6];
        const hit: Offset = [0.14, -0.14, -0.02, 45, 0, -4];
        use = t < 0.24 ? mix(ZERO, up, smooth(t / 0.24)) : t < 0.37 ? mix(up, hit, smooth((t - 0.24) / 0.13)) : mix(hit, ZERO, smooth((t - 0.37) / 0.38));
      } else {
        // push it forward and tip it a little, then back
        const h = Math.sin(Math.PI * Math.min(1, t / USE_SECONDS.everyday)) ** 2;
        use = [0.12 * h, 0.04 * h, -0.03 * h, 18 * h, 0, 0];
      }
      if (t >= USE_SECONDS[this.style]) this.useT = -1;
    }

    // the second action: reload, or turn the item over to look at it
    let second: Offset = ZERO;
    let away = 0;
    if (this.secondT >= 0) {
      this.secondT += dt;
      const t = this.secondT;
      const c = t < 0.35 ? smooth(t / 0.35) : t < 1.2 ? 1 : smooth(1 - (t - 1.2) / 0.4);
      if (this.style === 'weapon') {
        second = [-0.05 * c, -0.12 * c, -0.12 * c, 15 * c, 0, 40 * c];
      } else {
        // bring it in and roll it right over, as if checking the other side
        const roll = t < 0.35 ? 0 : t < 1.2 ? Math.sin(Math.PI * ((t - 0.35) / 0.85)) : 0;
        second = [-0.08 * c, 0.06 * c, -0.14 * c, -20 * c, 0, 150 * roll];
      }
      away = c;
      if (t >= SECOND_SECONDS) this.secondT = -1;
    }

    // raised: aim at the eye line, ready over the shoulder, or brought up to look at
    const raisedAt =
      this.style === 'weapon'
        ? { f: 0.74, u: -0.1, o: -0.28, tilt: 0 }
        : this.style === 'tool'
          ? { f: 0.42, u: 0.12, o: 0.04, tilt: -35 }
          : { f: 0.58, u: -0.02, o: -0.2, tilt: -25 };
    const raised = arm.shoulder
      .clone()
      .addScaledVector(arm.forward, raisedAt.f * reach)
      .addScaledVector(UP, raisedAt.u * reach)
      .addScaledVector(arm.outward, raisedAt.o * reach);
    const w = this.walk;
    const breath = Math.sin(this.time * 2 * Math.PI * 0.25);
    const off = add(use, second);
    const p = base.position
      .clone()
      .lerp(raised, this.raise)
      .addScaledVector(UP, 0.02 * reach * w * Math.sin(2 * this.phase) + 0.006 * reach * breath * (1 - Math.min(1, w)))
      .addScaledVector(side, 0.015 * reach * w * Math.sin(this.phase))
      .addScaledVector(arm.forward, off[0] * reach)
      .addScaledVector(UP, off[1] * reach)
      .addScaledVector(arm.outward, off[2] * reach);
    const hold: HoldPose = {
      position: p,
      turn: [
        base.turn[0] + raisedAt.tilt * this.raise + off[3] + 1.2 * breath * (1 - Math.min(1, w)),
        base.turn[1] + off[4],
        base.turn[2] + 4 * w * Math.sin(this.phase) + off[5],
      ],
    };
    return { hold, away };
  }
}

const STILL: Drive = { walking: false, run: false, raise: false };
const FPS = 30;

/** Idle, walk and run repeat; the item's actions play once. */
export const motionLoops = (kind: MotionKind) => kind === 'idle' || kind === 'walk' || kind === 'run';

/**
 * Makes a ready-made clip from the hold it starts at. Walk and run start already at speed
 * and last two whole steps, so they loop; idle is one slow breath and loops too.
 */
export function generateMotion(kind: MotionKind, style: ItemStyle, arm: ArmRig, base: HoldPose): ClipFrame[] {
  const m = new Motion(style);
  const frames: ClipFrame[] = [];
  const dt = 1 / FPS;
  let seconds = 4;
  let drive: (t: number) => Drive = () => STILL;
  if (kind === 'walk' || kind === 'run') {
    const run = kind === 'run';
    m.walk = run ? 1.8 : 1;
    // two steps: the arm's bob runs at twice the step rate, so this loops cleanly
    seconds = 1 / (STRIDE_HZ * (run ? RUN_RATE : 1));
    drive = () => ({ walking: true, run, raise: false });
  } else if (kind === 'use') {
    seconds = USE_SECONDS[style] + 0.25;
  } else if (kind === 'raise') {
    seconds = 2.2;
    drive = (t) => ({ ...STILL, raise: t < 1.5 });
  } else if (kind === 'second') {
    seconds = SECOND_SECONDS + 0.2;
  }
  // let the eased values settle at the clip's starting point first
  if (kind !== 'walk' && kind !== 'run') for (let k = 0; k < 30; k++) m.step(dt, drive(0), arm, base);
  m.time = 0;
  if (kind === 'use') m.useT = 0;
  if (kind === 'second') m.secondT = 0;
  const n = Math.round(seconds * FPS);
  for (let k = 0; k <= n; k++) {
    const t = k * dt;
    const r = m.step(k === 0 ? 0 : dt, drive(t), arm, base);
    frames.push({ t, hold: r.hold, away: r.away });
  }
  return frames;
}

/** A clip's frame at time `t`, blended between the two frames either side. */
export function frameAt(frames: ClipFrame[], t: number): ClipFrame {
  if (t <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = frames[lo], b = frames[hi];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return {
    t,
    hold: {
      position: a.hold.position.clone().lerp(b.hold.position, k),
      turn: [0, 1, 2].map((i) => a.hold.turn[i] + (b.hold.turn[i] - a.hold.turn[i]) * k) as [number, number, number],
    },
    away: a.away + (b.away - a.away) * k,
  };
}

/** Plays a saved clip on the character: play, pause and scrub. Looping clips repeat. */
export class ClipPlayer {
  playing = false;
  time = 0;
  private frames: ClipFrame[] | null = null;
  private loops = true;
  private raf = 0;
  private last = 0;

  constructor(
    /** Poses the character for a frame. */
    private readonly show: (frame: ClipFrame) => void,
    /** Playing started or stopped (the panel redraws). */
    private readonly changed: () => void,
    /** The time moved on while playing (only the scrub bar needs moving). */
    private readonly ticked?: (time: number, duration: number) => void,
  ) {}

  get duration(): number {
    return this.frames ? this.frames[this.frames.length - 1].t : 0;
  }

  /** Puts a clip on the player, at its first frame. */
  load(frames: ClipFrame[], loops: boolean) {
    this.halt();
    this.frames = frames.length > 1 ? frames : null;
    this.loops = loops;
    this.time = 0;
    if (this.frames) this.show(this.frames[0]);
  }

  clear() {
    this.halt();
    this.frames = null;
    this.time = 0;
  }

  play() {
    if (!this.frames || this.playing) return;
    if (this.time >= this.duration) this.time = 0;
    this.playing = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing || !this.frames) return;
      this.raf = requestAnimationFrame(tick);
      this.time += Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      const d = this.duration;
      if (this.time >= d) {
        if (this.loops) this.time %= d;
        else {
          this.time = d;
          this.show(frameAt(this.frames, d));
          this.ticked?.(d, d);
          this.pause();
          return;
        }
      }
      this.show(frameAt(this.frames, this.time));
      this.ticked?.(this.time, d);
    };
    this.raf = requestAnimationFrame(tick);
    this.changed();
  }

  pause() {
    if (!this.playing) return;
    this.halt();
    this.changed();
  }

  /** Jumps to a time in the clip; a playing clip carries on from there. */
  seek(time: number) {
    if (!this.frames) return;
    this.time = clamp(time, 0, this.duration);
    this.last = performance.now();
    this.show(frameAt(this.frames, this.time));
  }

  private halt() {
    cancelAnimationFrame(this.raf);
    this.playing = false;
  }
}
