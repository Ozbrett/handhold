import type { Grasp } from '../core/grasp/solver';
import type { HandModel } from '../core/hand/model';
import type { BodyLimits } from './armIk';
import type { ArmMode } from './exporter';
import { type Engine, NEXT_STEPS, SAVED_STEP } from './packages';
import { ACCEPT } from './loaders';
import { SAMPLE_OBJECTS } from './samples';
import { ITEM_STYLES, type ItemStyle, KIND_WORDS, MOTIONS, type MotionKind, type SavedKind, motionLabel } from './animations';

export type StepId = 1 | 2 | 3 | 4 | 5 | 6;
export type TabId = 'grip' | 'character' | 'animations';

export interface PanelState {
  /** Which page the panel shows: the grip steps, the whole character (its hands and how far its joints turn), or what is saved to animate it. */
  tab: TabId;
  open: StepId;
  hand: { name: string; model: HandModel; warnings: string[] } | null;
  handBusy: boolean;
  handError: string | null;
  /** Set when the file is a whole character and the user has to say which hand to use. */
  handChoice: { key: string; label: string }[] | null;
  /** Extra line shown with the choice, e.g. when both hands turn out to be right hands. */
  handChoiceNote: string | null;
  object: { name: string; ratio: number; scaleLog: number; rescaled: boolean; watertight: boolean } | null;
  objectError: string | null;
  grip: boolean;
  mode: 'fixed' | 'any';
  friction: number;
  solving: boolean;
  grasps: Grasp[] | null;
  selected: number;
  exportObject: boolean;
  exportAnimation: boolean;
  exporting: boolean;
  /** Which program a package is being prepared for right now, and which one was last downloaded. */
  exportingFor: Engine | null;
  exported: Engine | null;
  /** How the arm is meant to move in the game. */
  armMode: ArmMode;
  /** True when the loaded model has its own skeleton that the grip can be applied to. */
  characterAvailable: boolean;
  exportCharacter: boolean;
  /** Bone editing: on or off, the curl-test amount (0..1), the thumb's manual turn in degrees, and whether anything was changed. */
  editing: boolean;
  curl: number;
  thumbTurn: number;
  edited: boolean;
  /** True when the model has arm bones above the hand, so the hand can be placed in space. */
  armAvailable: boolean;
  /** The held object's turn in degrees (tilt, turn, roll); the wrist is solved to match. */
  turn: [number, number, number];
  /** What the solver did with the wrist and elbow. */
  wristText: string;
  /** Degrees the object is short of the turn asked for. */
  wristMiss: number;
  reachText: string;
  sweepFrom: boolean;
  sweepTo: boolean;
  sweepT: number;
  /** Fingertip-on-a-spot: which finger, whether a spot is being picked or is set, and how far short it falls (in hand lengths). */
  pinFinger: number;
  pinPicking: boolean;
  pinSet: boolean;
  pinMiss: number;
  /** The model has a second usable hand with an arm, so two-handed grips can be found. */
  twoHandsAvailable: boolean;
  twoHands: boolean;
  /** The second hand's grip point is marked. */
  grip2: boolean;
  /** Whether the second hand reaches its grip, for the selected two-handed grip. */
  supportText: string;
  supportShort: boolean;
  /** A whole character's hands (null for a bare hand) and which one is the first hand. */
  characterHands: { label: string }[] | null;
  characterPicked: number;
  /** How far the arm and wrist may turn, and how soft the ends of those ranges are. */
  bodyLimits: BodyLimits;
  /** The finger whose joint limits are shown, and whether finger limits changed since the grips were found. */
  limitFinger: number;
  limitsChanged: boolean;
  /** The object's turn in degrees about X, Y and Z. */
  objectAngles: [number, number, number];
  /** The item moved in the hand from the grip found: slide x, y, z (% of the hand's length) and turn x, y, z (degrees). */
  nudge: number[];
  nudging: boolean;
  /** What kind of item is held, which decides what the ready-made animations do. */
  itemStyle: ItemStyle;
  /** Everything saved on the Animations tab; all of it is exported. */
  saved: { kind: SavedKind; name: string; seconds: number; loops: boolean; ranges: LookRanges | null }[];
  /** The saved item shown on the character, or -1. */
  shown: number;
  clipPlaying: boolean;
  clipTime: number;
  /** Where the player is looking while a look is shown: degrees right and up. */
  lookAim: [number, number];
  /** What the drag handle moves: the hand (the item follows) or the item (the hand follows). */
  gizmoOn: 'hand' | 'item';
  /** The shown item's position can be dragged and turned (a pose, or a look seen straight ahead). */
  canEditShown: boolean;
}

export interface LookRanges {
  up: number;
  down: number;
  left: number;
  right: number;
}

export interface PanelActions {
  setTab(tab: TabId): void;
  openStep(step: StepId): void;
  /** `done` is false while a slider is being dragged (the view follows) and true when it is let go. */
  setBodyLimit(key: keyof BodyLimits, value: number, done: boolean): void;
  resetBodyLimits(): void;
  setLimitFinger(finger: number): void;
  /** A finger joint's range for one of its turns, degrees from rest (min is negative: bent back). */
  setFingerLimit(joint: number, dof: number, min: number, max: number): void;
  resetFingerLimits(): void;
  setObjectAngle(axis: 0 | 1 | 2, degrees: number): void;
  nudgeItem(index: number, value: number, done: boolean): void;
  resetNudge(): void;
  setItemStyle(style: ItemStyle): void;
  /** Save the Arm step's position as a still pose. */
  savePose(): void;
  /** Save a ready-made animation for the item type. */
  addMotion(kind: MotionKind): void;
  /** Save a look: the arm follows where the player looks. */
  addLook(): void;
  /** Show a saved item on the character (an animation that is already shown plays or pauses). */
  showSaved(index: number): void;
  clipPlay(on: boolean): void;
  clipSeek(time: number): void;
  renameSaved(index: number, name: string): void;
  deleteSaved(index: number): void;
  /** Replace a saved pose (or a look's centre) with the Arm step's position. */
  useArmPosition(index: number): void;
  /** How far the shown look turns one way, in degrees. */
  setLookRange(key: keyof LookRanges, degrees: number, done: boolean): void;
  /** Look this way (degrees right and up) while a look is shown. */
  lookAim(yaw: number, pitch: number, done: boolean): void;
  setGizmo(on: 'hand' | 'item'): void;
  handFile(file: File): void;
  handSample(): void;
  characterSample(): void;
  pickHand(index: number): void;
  flipPalm(): void;
  objectFile(file: File): void;
  objectSample(id: string): void;
  objectScale(scaleLog: number): void;
  objectTurn(axis: 'x' | 'z'): void;
  setMode(mode: 'fixed' | 'any'): void;
  setFriction(mu: number): void;
  findGrips(): void;
  cancelSolve(): void;
  selectGrasp(index: number): void;
  setExport(patch: { exportObject?: boolean; exportAnimation?: boolean; exportCharacter?: boolean }): void;
  downloadGlb(): void;
  downloadPose(): void;
  exportFor(engine: Engine): void;
  setArmMode(mode: ArmMode): void;
  editBones(on: boolean): void;
  setCurl(amount: number): void;
  setThumbTurn(degrees: number): void;
  resetBones(): void;
  setTurn(axis: number, degrees: number): void;
  resetHold(): void;
  sweepMark(which: 'from' | 'to'): void;
  sweepClear(): void;
  sweepScrub(t: number): void;
  setPinFinger(finger: number): void;
  pinPick(): void;
  pinClear(): void;
  /** Pins fingertip `finger` (0 thumb, 1 index...) to a spot in the object file's own axes; an error, or null. */
  pinAt(finger: number, at: number[]): string | null;
  setTwoHands(on: boolean): void;
  /** Something else carries the weight: judge each hand with the weight at its own spot. */
  setCarried(on: boolean): void;
  /** Put the first hand where its named bones are (object file axes) and solve only the fingers; `relax` fingers stay straight. An error message, or null. */
  /** Bend the character's fingers only about an engine's hinges: "bone:ax,ay,az,maxDegrees,px,py,pz;...", the axis and the bone's rest position in the engine's space. */
  setHinges(text: string): { joints: number; apart: Record<string, number>; rms: number; scale: number } | null;
  placeHand(
    points: { name: string; at: number[] }[],
    relax: string[],
    adjust?: { move: number; turn: number },
    reach?: { finger: number; at: number[] },
  ): string | null;
  /** Mark hand `which`'s spot (and, with both directions, the way its fingers and thumb point) in the object file's own axes. */
  holdThisWay(which: 1 | 2, at: number[], fingers: number[] | null, thumb: number[] | null): boolean;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'key') el.dataset.key = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const FINGER_VAR: Record<string, string> = {
  thumb: '--thumb',
  index: '--index',
  middle: '--middle',
  ring: '--ring',
  pinky: '--pinky',
};
const FALLBACK = ['--index', '--middle', '--ring', '--pinky', '--thumb'];

function filePicker(label: string, key: string, onFile: (f: File) => void, cls = 'btn'): HTMLElement {
  const input = h('input', { type: 'file', accept: ACCEPT, hidden: true });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    input.value = '';
  });
  return h('span', {}, input, h('button', { class: cls, type: 'button', key, onclick: () => input.click() }, label));
}

/** A labelled range slider: `live` runs while it is dragged, `done` when it is let go. */
function slider(
  label: string,
  key: string,
  min: number,
  max: number,
  step: number,
  value: number,
  text: (v: number) => string,
  live: ((v: number) => void) | null,
  done: ((v: number) => void) | null,
): HTMLElement {
  const output = h('output', {}, text(value));
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), key, 'aria-label': label });
  range.addEventListener('input', () => {
    output.textContent = text(Number(range.value));
    live?.(Number(range.value));
  });
  if (done) range.addEventListener('change', () => done(Number(range.value)));
  return h('div', { class: 'slider' }, h('span', { class: 'field-label' }, label), output, range);
}

const deg = (v: number) => `${Math.round(v)}°`;

const TABS: { id: TabId; label: string }[] = [
  { id: 'grip', label: 'Grip' },
  { id: 'character', label: 'Character' },
  { id: 'animations', label: 'Animations' },
];

/** The arm's limits as the Character tab shows them. */
const BODY_SLIDERS: { key: keyof BodyLimits; label: string; min: number; max: number }[] = [
  { key: 'flex', label: 'Wrist bends towards the palm', min: 0, max: 120 },
  { key: 'extend', label: 'Wrist bends back', min: 0, max: 120 },
  { key: 'radial', label: 'Wrist tilts towards the thumb', min: 0, max: 60 },
  { key: 'ulnar', label: 'Wrist tilts towards the little finger', min: 0, max: 70 },
  { key: 'pronate', label: 'Forearm turns palm down', min: 0, max: 180 },
  { key: 'supinate', label: 'Forearm turns palm up', min: 0, max: 180 },
  { key: 'swivel', label: 'Elbow may swing out to help the wrist', min: 0, max: 150 },
  { key: 'elbowOut', label: 'Elbow hangs out from the body', min: -30, max: 80 },
];

const DOF_WORDS: Record<string, { max: string; min: string }> = {
  flex: { max: 'Bends in up to', min: 'Bends back up to' },
  abduct: { max: 'Swings out in front of the palm up to', min: 'Swings back up to' },
  spread: { max: 'Opens away from the fingers up to', min: 'Closes in up to' },
};

const JOINT_WORDS = ['Base joint', 'Middle joint', 'End joint'];

const FRICTION = [
  { label: 'Slippery', mu: 0.35 },
  { label: 'Normal', mu: 0.6 },
  { label: 'Grippy', mu: 0.9 },
];

const ENGINES: { id: Engine; label: string }[] = [
  { id: 'unity', label: 'Unity' },
  { id: 'godot', label: 'Godot' },
  { id: 'blender', label: 'Blender' },
];

const ARM_MODES: { id: ArmMode; label: string; note: string }[] = [
  {
    id: 'animation',
    label: 'Follows my animation',
    note: 'Your walk, run or idle moves the arm. Only the fingers and the object are added on top, so the grip stays put through any animation.',
  },
  {
    id: 'hold',
    label: 'Stays where I put it',
    note: 'The arm keeps the position from the Arm step while the rest of the body animates.',
  },
  {
    id: 'camera',
    label: 'Follows the camera',
    note: 'The arm follows where the camera looks: up, down, left and right, using the look saved on the Animations tab (or the sweep from the Arm step).',
  },
];

/** One line describing a grip in plain words. */
export function describeGrasp(g: Grasp, twoHands = false): string {
  const parts: string[] = [];
  const others = g.fingersTouching - (g.thumbTouching ? 1 : 0);
  if (others > 0) parts.push(`${others} finger${others === 1 ? '' : 's'}`);
  if (g.thumbTouching) parts.push('thumb');
  if (g.palmTouching) parts.push('palm');
  const along = g.segmentsTotal ? `, along ${g.segmentsTouching} of ${g.segmentsTotal} finger segments` : '';
  const touch = parts.length ? `${twoHands ? 'The first hand touches' : 'Touches'} with ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}${along}.` : 'Nothing is touching.';
  if (!g.stable) {
    return Number.isFinite(g.effort)
      ? `${touch} Holding it this way would take an impossibly hard squeeze.`
      : `${touch} These contacts cannot carry the weight.`;
  }
  const effort =
    g.effort < 1.25
      ? `The ${twoHands ? 'hands carry' : 'hand carries'} the weight with almost no squeezing.`
      : g.effort < 2.4
        ? `${twoHands ? 'Both hands together need' : 'Needs'} a squeeze of about ${g.effort.toFixed(1)}× the object's weight.`
        : `${twoHands ? 'Both hands together need' : 'Needs'} a hard squeeze, about ${g.effort.toFixed(1)}× the object's weight.`;
  return `${touch} ${effort}`;
}

function sizeWords(ratio: number): string {
  if (ratio < 0.12) return 'tiny next to the hand';
  if (ratio < 0.6) return 'smaller than the hand';
  if (ratio < 1.7) return 'about hand-sized';
  if (ratio < 4) return 'bigger than the hand';
  return 'much bigger than the hand';
}

const LOGO =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect width="24" height="24" rx="6" fill="currentColor"/><path d="M7 16.5V10a1.5 1.5 0 0 1 3 0v3.5M10 12V7.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V13m0-2a1.5 1.5 0 0 1 3 0v3c0 3-2 5-5 5h-1c-2.2 0-3.6-1-4.6-2.6" fill="none" stroke="var(--on-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class Panel {
  private progressBar: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: PanelActions,
    private readonly header: HTMLElement | null = null,
  ) {}

  /** The bar across the top: name, sections, what is loaded, and the way to the export. */
  private renderHeader(s: PanelState, chosen: boolean) {
    if (!this.header) return;
    const a = this.actions;
    const logo = h('span', { class: 'logo-mark' });
    logo.innerHTML = LOGO;
    const status = [
      s.hand ? s.hand.name : '',
      s.object?.name ?? '',
      chosen ? `Grip ${s.selected + 1}` : '',
      s.saved.length ? `${s.saved.length} saved` : '',
    ].filter(Boolean);
    this.header.replaceChildren(
      h('div', { class: 'logo' }, logo, h('span', { class: 'logo-name' }, 'Handhold')),
      h(
        'nav',
        { class: 'tabs', role: 'tablist', 'aria-label': 'Sections' },
        ...TABS.map((t) =>
          h('button', { class: 'tab', type: 'button', role: 'tab', key: `tab-${t.id}`, 'aria-selected': String(s.tab === t.id), onclick: () => a.setTab(t.id) }, t.label),
        ),
      ),
      h('div', { class: 'top-status', title: status.join(' / ') }, ...status.flatMap((t, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '/') : null, h('span', {}, t)])),
      h(
        'button',
        {
          class: 'btn primary top-export',
          type: 'button',
          key: 'top-export',
          disabled: !chosen,
          title: chosen ? 'Go to the export step' : 'Find a grip first',
          onclick: () => {
            a.setTab('grip');
            a.openStep(6);
          },
        },
        'Export',
      ),
    );
  }

  setProgress(fraction: number) {
    if (this.progressBar) this.progressBar.style.width = `${Math.round(fraction * 100)}%`;
  }

  /** The playing animation's time, updated in place so the panel is not redrawn every frame. */
  private clipLine: { range: HTMLInputElement; out: HTMLElement } | null = null;

  setClipTime(time: number, duration: number) {
    const c = this.clipLine;
    if (!c) return;
    if (!c.range.matches(':active')) c.range.value = String(time);
    c.out.textContent = `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
  }

  render(s: PanelState) {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const a = this.actions;
    const ready = !!s.hand && !!s.object && s.grip && (!s.twoHands || s.grip2);
    const chosen = s.grasps && s.grasps.length ? s.grasps[s.selected] : null;

    const step = (
      id: StepId,
      title: string,
      summary: string,
      done: boolean,
      locked: boolean,
      body: () => Child[],
    ): HTMLElement => {
      const open = s.open === id;
      return h(
        'li',
        { class: `step${open ? ' is-open' : ''}${done ? ' is-done' : ''}${locked ? ' is-locked' : ''}` },
        h(
          'button',
          {
            class: 'step-head',
            type: 'button',
            key: `step-${id}`,
            'aria-expanded': String(open),
            disabled: locked,
            onclick: () => a.openStep(id),
          },
          h('span', { class: 'step-title' }, title),
          !open && summary ? h('span', { class: 'step-summary' }, summary) : null,
        ),
        open ? h('div', { class: 'step-body' }, ...body()) : h('div', { class: 'step-body' }),
      );
    };

    // 1 — hand
    const handBody = (): Child[] => {
      if (s.handBusy) return [h('p', {}, 'Finding the fingers and placing bones…')];
      const out: Child[] = [];
      if (s.handError) out.push(h('p', { class: 'error', role: 'alert' }, s.handError));
      if (s.handChoice) {
        out.push(
          h('p', {}, 'This file is a whole character. Which hand should be used? It is cut off at the forearm and rigged on its own.'),
          s.handChoiceNote ? h('p', { class: 'note' }, s.handChoiceNote) : null,
          h(
            'div',
            { class: 'row' },
            ...s.handChoice.map((c, i) => h('button', { class: 'btn', type: 'button', key: c.key, onclick: () => a.pickHand(i) }, c.label)),
          ),
          h('div', { class: 'row' }, filePicker('Use another file', 'hand-file', a.handFile, 'btn quiet')),
        );
        return out;
      }
      if (!s.hand) {
        out.push(
          h(
            'div',
            { class: 'drop' },
            h('strong', {}, 'Drop a hand model here'),
            h('span', {}, 'GLB, FBX, OBJ, STL or PLY. One hand, fingers apart, no bones needed.'),
            h(
              'div',
              { class: 'row', style: 'margin:0' },
              filePicker('Choose a file', 'hand-file', a.handFile),
              h('button', { class: 'btn', type: 'button', key: 'hand-sample', onclick: a.handSample }, 'Use the sample hand'),
              h('button', { class: 'btn', type: 'button', key: 'character-sample', onclick: a.characterSample }, 'Use the sample player'),
            ),
          ),
        );
        return out;
      }
      const m = s.hand.model;
      if (s.editing) {
        out.push(
          h('p', {}, 'Click a joint dot in the view, then drag the arrows to move it. The skin is fitted again when you let go.'),
          slider('Curl test', 'curl', 0, 1, 0.01, s.curl, (v) => `${Math.round(v * 100)}%`, (v) => a.setCurl(v), null),
          h('p', { class: 'note' }, 'Curl the fingers to see how the skin bends. Joints can be moved while this is at 0%. Turn on Weights above the view to see which bone each part of the skin follows.'),
          m.fingers.some((f) => f.isThumb)
            ? slider('Thumb bend direction', 'thumb-turn', -180, 180, 5, s.thumbTurn, (v) => `${Math.round(v)}°`, null, (v) => a.setThumbTurn(v))
            : null,
          m.fingers.some((f) => f.isThumb) ? h('p', { class: 'note' }, 'If the thumb curls the wrong way, turn this, then check with the curl test.') : null,
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn', type: 'button', key: 'bones-reset', disabled: !s.edited, onclick: a.resetBones }, 'Back to automatic'),
            h('button', { class: 'btn primary', type: 'button', key: 'bones-done', style: 'width:auto;flex:1', onclick: () => a.editBones(false) }, 'Done'),
          ),
        );
        return out;
      }
      out.push(
        h(
          'p',
          {},
          `${m.handedness === 'left' ? 'Left' : 'Right'} hand with ${m.fingers.length} fingers. Bones were placed and fitted to the skin automatically.`,
        ),
        h(
          'ul',
          { class: 'fingers', 'aria-label': 'Fingers found' },
          ...m.fingers.map((f, i) =>
            h(
              'li',
              {},
              h('i', { style: `background:var(${FINGER_VAR[f.name] ?? FALLBACK[i % FALLBACK.length]})` }),
              f.name.charAt(0).toUpperCase() + f.name.slice(1),
            ),
          ),
        ),
        ...s.hand.warnings.map((w) => h('p', { class: 'warning' }, w)),
        h('p', { class: 'note' }, 'Turn on Bones or Fit above the view to check the result. If the fingers bend backwards, flip the palm.'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', key: 'edit-bones', onclick: () => a.editBones(true) }, s.edited ? 'Edit bones (changed)' : 'Edit bones'),
          h('button', { class: 'btn', type: 'button', key: 'flip', onclick: a.flipPalm }, 'Flip palm side'),
          filePicker('Use another hand', 'hand-file', a.handFile),
        ),
      );
      return out;
    };

    // 2 — object
    const objectBody = (): Child[] => {
      const out: Child[] = [];
      if (s.objectError) out.push(h('p', { class: 'error', role: 'alert' }, s.objectError));
      const samples = h(
        'div',
        { class: 'row' },
        h('span', { class: 'field-label' }, 'Samples'),
        ...SAMPLE_OBJECTS.map((o) =>
          h('button', { class: 'chip', type: 'button', key: `sample-${o.id}`, onclick: () => a.objectSample(o.id) }, o.label),
        ),
      );
      if (!s.object) {
        out.push(
          h(
            'div',
            { class: 'drop' },
            h('strong', {}, 'Drop the object to hold'),
            h('span', {}, 'Any mesh: a prop, a tool, a weapon, a cup.'),
            filePicker('Choose a file', 'object-file', a.objectFile),
          ),
          samples,
        );
        return out;
      }
      const o = s.object;
      const output = h('output', {}, `${o.ratio.toFixed(2)}× hand length`);
      const range = h('input', {
        type: 'range',
        min: '-1',
        max: '1',
        step: '0.01',
        value: String(o.scaleLog),
        key: 'scale',
        'aria-label': 'Object size',
      });
      range.addEventListener('change', () => a.objectScale(Number(range.value)));
      range.addEventListener('input', () => {
        const preview = o.ratio * Math.pow(10, Number(range.value) - o.scaleLog);
        output.textContent = `${preview.toFixed(2)}× hand length`;
      });
      out.push(
        h('p', {}, `${o.name} is ${sizeWords(o.ratio)}.`),
        o.rescaled
          ? h('p', { class: 'warning' }, 'Its units did not match the hand, so it was resized to fit. Adjust the size if that is wrong.')
          : null,
        h('div', { class: 'slider' }, h('span', { class: 'field-label' }, 'Size'), output, range),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'field-label' }, 'Which way is up?'),
          h('button', { class: 'btn', type: 'button', key: 'turn-x', onclick: () => a.objectTurn('x') }, 'Tip over'),
          h('button', { class: 'btn', type: 'button', key: 'turn-z', onclick: () => a.objectTurn('z') }, 'Roll'),
        ),
        h('p', { class: 'note' }, 'Gravity pulls towards the bottom of the view.'),
        h('span', { class: 'field-label' }, 'Turn it exactly'),
        slider('Tip forward or back', 'obj-x', -180, 180, 1, s.objectAngles[0], deg, null, (v) => a.setObjectAngle(0, v)),
        slider('Spin', 'obj-y', -180, 180, 1, s.objectAngles[1], deg, null, (v) => a.setObjectAngle(1, v)),
        slider('Roll', 'obj-z', -180, 180, 1, s.objectAngles[2], deg, null, (v) => a.setObjectAngle(2, v)),
        s.grip ? h('p', { class: 'note' }, 'Turning the object clears the grip mark, so mark it again afterwards.') : null,
        !o.watertight
          ? h('p', { class: 'note' }, 'This mesh is not a closed solid, so its balance point is estimated from its surface.')
          : null,
        samples,
        h('div', { class: 'row' }, filePicker('Use another object', 'object-file', a.objectFile)),
      );
      return out;
    };

    // 3 — grip point
    const gripBody = (): Child[] => [
      h('span', { class: 'field-label' }, 'Hold it with'),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': 'How many hands' },
        h('button', { class: 'btn', type: 'button', key: 'hands-1', 'aria-pressed': String(!s.twoHands), onclick: () => a.setTwoHands(false) }, 'One hand'),
        h(
          'button',
          { class: 'btn', type: 'button', key: 'hands-2', 'aria-pressed': String(s.twoHands), disabled: !s.twoHandsAvailable, onclick: () => a.setTwoHands(true) },
          'Both hands',
        ),
      ),
      h(
        'p',
        { class: 'note' },
        !s.twoHandsAvailable
          ? 'Both hands needs a whole character with two arms: load one in the Hand step (or use the sample player).'
          : s.twoHands
            ? `First hand (carries the weight): ${s.grip ? 'marked' : 'not marked yet'}. Second hand (orange): ${s.grip2 ? 'marked' : 'not marked yet'}.`
            : 'For rifles, poles and heavy things, choose both hands: you mark a spot for each, and the second arm reaches to its spot.',
      ),
      h(
        'p',
        {},
        s.twoHands
          ? !s.grip
            ? 'Click the object where the first hand should hold it. This hand carries the object.'
            : !s.grip2
              ? 'Now click where the second hand should hold it (the orange mark).'
              : 'Both spots are marked. Click again to move whichever mark is nearer.'
          : s.grip
            ? 'Marked. Click the object again to move the mark.'
            : 'Click the object where the palm should sit. The hand will grip around that spot.',
      ),
      h(
        'label',
        { class: 'check' },
        (() => {
          const box = h('input', { type: 'checkbox', key: 'mode' });
          box.checked = s.mode === 'any';
          box.addEventListener('change', () => a.setMode(box.checked ? 'any' : 'fixed'));
          return box;
        })(),
        h('span', {}, 'It will be swung around', h('small', {}, 'For tools and weapons: the grip has to hold whichever way it is turned.')),
      ),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'field-label' }, 'Surface'),
        ...FRICTION.map((f) =>
          h(
            'button',
            {
              class: 'chip',
              type: 'button',
              key: `mu-${f.mu}`,
              'aria-pressed': String(Math.abs(s.friction - f.mu) < 1e-6),
              onclick: () => a.setFriction(f.mu),
            },
            f.label,
          ),
        ),
      ),
      s.grip && (!s.twoHands || s.grip2) ? h('button', { class: 'btn primary', type: 'button', key: 'to-find', onclick: () => a.openStep(4) }, 'Continue') : null,
    ];

    // 4 — find grips
    const findBody = (): Child[] => {
      if (s.solving) {
        this.progressBar = h('i');
        return [
          h('p', {}, 'Trying hand positions around the grip point and closing the fingers on each…'),
          h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Search progress' }, this.progressBar),
          h('button', { class: 'btn', type: 'button', key: 'cancel', onclick: a.cancelSolve }, 'Stop'),
        ];
      }
      const out: Child[] = [];
      if (!s.grasps) {
        out.push(
          h('p', {}, 'Each candidate grip is checked physically: can those contacts carry the weight, and how hard must the hand squeeze?'),
          h('button', { class: 'btn primary', type: 'button', key: 'find', disabled: !ready, onclick: a.findGrips }, 'Find grips'),
        );
        return out;
      }
      if (!s.grasps.length) {
        out.push(
          h('p', { class: 'error' }, 'The hand could not reach that spot. Mark a grip point somewhere less enclosed and try again.'),
          h('button', { class: 'btn primary', type: 'button', key: 'find', onclick: a.findGrips }, 'Find grips again'),
        );
        return out;
      }
      if (!s.grasps.some((g) => g.stable)) {
        out.push(
          h(
            'p',
            { class: 'warning' },
            'No one-handed grip at this spot can carry the weight. Mark a point underneath the object, or on a narrower part the fingers can close around.',
          ),
        );
      }
      out.push(
        h(
          'ul',
          { class: 'grips' },
          ...s.grasps.map((g, i) =>
            h(
              'li',
              {},
              h(
                'button',
                {
                  class: 'grip',
                  type: 'button',
                  key: `grip-${i}`,
                  'aria-pressed': String(i === s.selected),
                  onclick: () => a.selectGrasp(i),
                },
                h('b', {}, `Grip ${i + 1}`),
                h('span', { class: `badge ${g.stable ? 'ok' : 'bad'}` }, g.stable ? 'Holds' : 'Slips'),
                h('small', {}, describeGrasp(g, s.twoHands)),
              ),
            ),
          ),
        ),
        // the item moved and turned in the hand; the fingers close again where it is let go
        h('span', { class: 'field-label' }, s.nudging ? 'Closing the fingers again…' : 'Move the item in the hand'),
        ...['Slide along X', 'Slide along Y', 'Slide along Z'].map((label, i) =>
          slider(label, `nudge-${i}`, -40, 40, 1, s.nudge[i], (v) => `${Math.round(v)}% of the hand`, (v) => a.nudgeItem(i, v, false), (v) => a.nudgeItem(i, v, true)),
        ),
        ...['Turn about X', 'Turn about Y', 'Turn about Z'].map((label, i) =>
          slider(label, `nudge-${i + 3}`, -45, 45, 1, s.nudge[i + 3], deg, (v) => a.nudgeItem(i + 3, v, false), (v) => a.nudgeItem(i + 3, v, true)),
        ),
        s.nudge.some((v) => v !== 0)
          ? h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'button', key: 'nudge-reset', onclick: a.resetNudge }, 'Back to the grip found'))
          : h('p', { class: 'note' }, 'Slides and turns the item about the grip point, along the scene axes. The fingers close on it again where you let go.'),
        // a fingertip on a chosen spot: a trigger, a button, a switch
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'field-label' }, 'Fingertip on a spot'),
          ...(s.hand?.model.fingers ?? []).map((f, i) =>
            h(
              'button',
              { class: 'chip', type: 'button', key: `pin-f${i}`, 'aria-pressed': String(i === s.pinFinger), onclick: () => a.setPinFinger(i) },
              f.name.charAt(0).toUpperCase() + f.name.slice(1),
            ),
          ),
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', key: 'pin-pick', 'aria-pressed': String(s.pinPicking), onclick: a.pinPick }, s.pinPicking ? 'Now click the spot' : s.pinSet ? 'Move the spot' : 'Pick the spot'),
          s.pinSet ? h('button', { class: 'btn quiet', type: 'button', key: 'pin-clear', onclick: a.pinClear }, 'Clear') : null,
        ),
        h(
          'p',
          { class: s.pinSet && s.pinMiss > 0.06 ? 'warning' : 'note' },
          !s.pinSet
            ? 'For a trigger or a button: choose a finger, then click where its tip should rest. The other fingers keep the grip.'
            : s.pinMiss > 0.06
              ? `That finger cannot reach the spot from this grip: it stops ${Math.round(s.pinMiss * 100)}% of a hand length short. Try another grip, or mark the grip point nearer the spot.`
              : 'The fingertip is on the spot.',
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', key: 'find', onclick: a.findGrips }, 'Find grips again'),
          s.armAvailable ? h('button', { class: 'btn', type: 'button', key: 'to-arm', onclick: () => a.openStep(5) }, 'Pose the arm') : null,
          h('button', { class: 'btn primary', type: 'button', key: 'to-export', style: 'width:auto;flex:1', onclick: () => a.openStep(6) }, 'Export this grip'),
        ),
      );
      return out;
    };

    /** Moving and turning a position: the Arm step's, or a saved pose on the Animations tab. */
    const holdEditor = (prefix: string): Child[] => [
      h('span', { class: 'field-label' }, 'The arrows move'),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': 'What the arrows move' },
        h('button', { class: 'btn', type: 'button', key: `${prefix}gizmo-hand`, 'aria-pressed': String(s.gizmoOn === 'hand'), onclick: () => a.setGizmo('hand') }, 'The hand'),
        h('button', { class: 'btn', type: 'button', key: `${prefix}gizmo-item`, 'aria-pressed': String(s.gizmoOn === 'item'), onclick: () => a.setGizmo('item') }, 'The item'),
      ),
      h(
        'p',
        { class: 'note' },
        s.gizmoOn === 'item'
          ? 'Drag the item to where you want it. The hand, wrist and elbow go with it, and the sliders turn it on the spot.'
          : 'Drag the hand to where it should be. The elbow follows, and the sliders swing the item about the wrist.',
      ),
      slider('Tilt forward or back', `${prefix}turn-0`, -90, 90, 1, s.turn[0], deg, (v) => a.setTurn(0, v), null),
      slider('Turn left or right', `${prefix}turn-1`, -180, 180, 1, s.turn[1], deg, (v) => a.setTurn(1, v), null),
      slider('Roll', `${prefix}turn-2`, -180, 180, 1, s.turn[2], deg, (v) => a.setTurn(2, v), null),
      h('p', { class: s.wristMiss > 3 ? 'warning' : 'note', id: 'wrist-readout' }, s.wristText),
    ];

    // 5 — arm
    const armBody = (): Child[] => {
      if (!s.armAvailable) return [h('p', {}, 'This step needs a model with its own arm bones, such as a rigged character.')];
      return [
        h('p', {}, 'Put the arm where it should hold the item. Drag the arrows in the view.'),
        ...holdEditor(''),
        h('p', { class: 'note' }, s.reachText),
        s.twoHands ? h('p', { class: s.supportShort ? 'warning' : 'note', id: 'support-readout' }, s.supportText) : null,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', key: 'hold-save', title: 'Keeps this position as a pose on the Animations tab', onclick: a.savePose }, 'Save as a pose'),
          h('button', { class: 'btn quiet', type: 'button', key: 'hold-reset', onclick: a.resetHold }, 'Back to the starting position'),
        ),
        h('p', {}, 'Sweep: two positions the arm swings between, such as aiming low and aiming high. The wrist travels on an arc around the shoulder.'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', key: 'sweep-from', 'aria-pressed': String(s.sweepFrom), onclick: () => a.sweepMark('from') }, s.sweepFrom ? 'Start is set' : 'Use this as the start'),
          h('button', { class: 'btn', type: 'button', key: 'sweep-to', 'aria-pressed': String(s.sweepTo), onclick: () => a.sweepMark('to') }, s.sweepTo ? 'End is set' : 'Use this as the end'),
          s.sweepFrom || s.sweepTo ? h('button', { class: 'btn quiet', type: 'button', key: 'sweep-clear', onclick: a.sweepClear }, 'Clear') : null,
        ),
        s.sweepFrom && s.sweepTo
          ? slider('Along the sweep', 'sweep-t', 0, 1, 0.01, s.sweepT, (v) => `${Math.round(v * 100)}%`, (v) => a.sweepScrub(v), null)
          : null,
        h('button', { class: 'btn primary', type: 'button', key: 'arm-export', onclick: () => a.openStep(6) }, 'Export'),
      ];
    };

    // 5 — export
    const check = (label: string, note: string, key: string, value: boolean, set: (v: boolean) => void) => {
      const box = h('input', { type: 'checkbox', key });
      box.checked = value;
      box.addEventListener('change', () => set(box.checked));
      return h('label', { class: 'check' }, box, h('span', {}, label, h('small', {}, note)));
    };
    const onOwnSkeleton = s.characterAvailable && s.exportCharacter;
    /** Exactly what the export will hold, so nothing is a surprise. */
    const manifest = (): HTMLElement => {
      const item = (on: boolean, label: string, detail: string) =>
        h('li', { class: on ? 'on' : 'off' }, h('span', { class: 'mark', 'aria-label': on ? 'Included' : 'Not included' }), h('div', {}, h('b', {}, label), h('small', {}, detail)));
      const withArm = onOwnSkeleton && s.armAvailable;
      const armPlaced = withArm && (s.armMode !== 'animation' || s.twoHands || s.saved.length > 0);
      const names = (kind: SavedKind) => s.saved.filter((x) => x.kind === kind).map((x) => `"${x.name}"`).join(', ');
      const savedDetail = [
        names('pose') ? `Poses: ${names('pose')}.` : '',
        names('clip') ? `Animations: ${names('clip')}.` : '',
        names('look') ? `Looks: ${names('look')} (each as a Down-Up and a Left-Right animation).` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return h(
        'ul',
        { class: 'manifest', 'aria-label': 'What the export contains' },
        item(true, chosen ? `Grip ${s.selected + 1}` : 'The grip', onOwnSkeleton ? 'Your model, whole, with its own finger bones posed' : 'The hand, with its new bones and skin weights, posed'),
        item(s.exportObject && !!s.object, 'Object in the hand', s.exportObject ? 'Attached to the hand bone, where the grip holds it' : 'Left out'),
        item(s.exportAnimation, 'Animation "Grip"', s.exportAnimation ? 'Open hand closing into the grip, 1 second' : 'Left out'),
        withArm
          ? item(armPlaced, 'Arm position', armPlaced ? 'Where the Arm step holds it' : 'Not placed: your own walk or idle animation will move the arm')
          : null,
        withArm && s.sweepFrom && s.sweepTo ? item(s.exportAnimation, 'Animation "Sweep"', s.exportAnimation ? 'The arm moving between the two sweep positions' : 'Left out with the Grip animation') : null,
        withArm
          ? item(
              s.saved.length > 0,
              s.saved.length ? `Saved animations (${s.saved.length})` : 'Saved animations',
              s.saved.length ? savedDetail : 'None. Save a pose, an animation or a look on the Animations tab.',
            )
          : null,
      );
    };
    const exportBody = (): Child[] => [
      h('span', { class: 'field-label' }, 'In the export'),
      manifest(),
      s.characterAvailable
        ? check(
            'Use the skeleton my model already has',
            'Poses its own finger bones by name and attaches the object to its hand bone. Turn off to get the separate, freshly rigged hand.',
            'exp-char',
            s.exportCharacter,
            (v) => a.setExport({ exportCharacter: v }),
          )
        : null,
      check('Include the object', 'Placed exactly where the hand holds it.', 'exp-object', s.exportObject, (v) => a.setExport({ exportObject: v })),
      check('Include a closing animation', 'One second, from the open hand to the grip.', 'exp-anim', s.exportAnimation, (v) =>
        a.setExport({ exportAnimation: v }),
      ),
      onOwnSkeleton && s.armAvailable
        ? h(
            'div',
            { class: 'choice' },
            h('span', { class: 'field-label' }, 'In your game, the arm'),
            h(
              'div',
              { class: 'row', style: 'margin:0' },
              ...ARM_MODES.map((m) =>
                h(
                  'button',
                  { class: 'btn', type: 'button', key: `arm-${m.id}`, 'aria-pressed': String(s.armMode === m.id), onclick: () => a.setArmMode(m.id) },
                  m.label,
                ),
              ),
            ),
            h(
              'p',
              { class: 'note' },
              ARM_MODES.find((m) => m.id === s.armMode)!.note +
                (s.armMode === 'camera' && !(s.sweepFrom && s.sweepTo) && !s.saved.some((x) => x.kind === 'look')
                  ? ' Nothing is saved for it to follow yet, so the arm will swing at the shoulder. Add a look on the Animations tab.'
                  : ''),
            ),
          )
        : null,
      h('span', { class: 'field-label' }, 'Export for'),
      h(
        'div',
        { class: 'row engines' },
        ...ENGINES.map((e) =>
          h(
            'button',
            { class: 'btn primary', type: 'button', key: `export-${e.id}`, disabled: !chosen || s.exporting, onclick: () => a.exportFor(e.id) },
            s.exportingFor === e.id ? 'Preparing…' : e.label,
          ),
        ),
      ),
      s.exported
        ? h(
            'div',
            { class: 'howto' },
            h('h3', {}, NEXT_STEPS[s.exported].title),
            h(
              'ol',
              {},
              ...NEXT_STEPS[s.exported].steps.map((t) => h('li', {}, t)),
              s.saved.length && onOwnSkeleton ? h('li', {}, SAVED_STEP[s.exported](s.saved[0].name)) : null,
            ),
          )
        : h(
            'p',
            { class: 'note' },
            'Each download holds everything that program needs: the pose file, a script that applies it to your character, and the model with its animations where it helps.' +
              (s.saved.length && onOwnSkeleton ? ' Everything saved on the Animations tab is in each download, and plays by name.' : ''),
          ),
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h('span', { class: 'field-label' }, 'Or just the files'),
        h('button', { class: 'btn quiet', type: 'button', key: 'dl-glb', disabled: !chosen || s.exporting, onclick: a.downloadGlb }, 'GLB'),
        h('button', { class: 'btn quiet', type: 'button', key: 'dl-json', disabled: !chosen, onclick: a.downloadPose }, 'Pose JSON'),
      ),
    ];

    // ---------- Character tab ----------
    const characterPage = (): Child[] => {
      const load = h(
        'div',
        { class: 'row' },
        filePicker(s.characterAvailable ? 'Use another character' : 'Choose a character', 'char-file', a.handFile),
        h('button', { class: 'btn', type: 'button', key: 'char-sample', onclick: a.characterSample }, 'Use the sample player'),
      );
      if (s.handBusy) return [h('p', {}, 'Finding the hands and placing bones…')];
      if (!s.hand || !s.characterAvailable) {
        return [
          h('h2', {}, 'Character'),
          ...(s.handChoice
            ? [
                h('p', {}, 'This is a whole character. Which hand should hold things? You can also click its pin in the view.'),
                s.handChoiceNote ? h('p', { class: 'note' }, s.handChoiceNote) : null,
                h(
                  'div',
                  { class: 'seg', role: 'group', 'aria-label': 'Which hand' },
                  ...s.handChoice.map((c, i) => h('button', { class: 'btn', type: 'button', key: `char-pick-${c.key}`, 'aria-pressed': 'false', onclick: () => a.pickHand(i) }, c.label)),
                ),
              ]
            : [h('p', {}, 'Load a whole character (a model with its own skeleton) to see all of it here, choose its hand and set how far its joints turn.')]),
          load,
        ];
      }
      const m = s.hand.model;
      const out: Child[] = [
        h('h2', {}, 'Character'),
        h('p', {}, `${s.hand.name}. ${s.armAvailable ? 'Its arm is posed with the grip.' : 'It has no arm bones above the hand, so only the fingers are posed.'}`),
      ];
      if (s.characterHands && s.characterHands.length > 1) {
        out.push(
          h('span', { class: 'field-label' }, 'First hand (the one that carries the object)'),
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Which hand' },
            ...s.characterHands.map((c, i) =>
              h('button', { class: 'btn', type: 'button', key: `char-hand-${i}`, 'aria-pressed': String(i === s.characterPicked), onclick: () => a.pickHand(i) }, c.label),
            ),
          ),
          h('p', { class: 'note' }, 'Changing hands rigs it again and clears the grips.'),
        );
      }
      out.push(load, h('h2', {}, 'Arm and wrist'));
      if (s.armAvailable) {
        const L = s.bodyLimits;
        out.push(
          h('p', { class: 'note' }, 'How far each joint may turn. The arm in the view follows as you drag.'),
          ...BODY_SLIDERS.map((b) => slider(b.label, `limit-${b.key}`, b.min, b.max, 1, L[b.key], deg, (v) => a.setBodyLimit(b.key, v, false), (v) => a.setBodyLimit(b.key, v, true))),
          slider('Soft ends', 'limit-soft', 0, 1, 0.01, L.soft, (v) => (v < 0.01 ? 'hard stop' : `${Math.round(v * 100)}%`), (v) => a.setBodyLimit('soft', v, false), (v) => a.setBodyLimit('soft', v, true)),
          h('p', { class: 'note' }, 'A real joint stiffens towards the end of its range: with soft ends the wrist and elbow slow down as they get near a limit instead of stopping dead. 0% is a hard stop.'),
          h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'button', key: 'limits-reset', onclick: a.resetBodyLimits }, 'Back to human ranges')),
        );
      } else out.push(h('p', { class: 'note' }, 'Needs a model with arm bones (upper arm, forearm, hand).'));

      out.push(
        h('h2', {}, 'Fingers'),
        h(
          'div',
          { class: 'row' },
          ...m.fingers.map((f, i) =>
            h(
              'button',
              { class: 'chip', type: 'button', key: `limit-f${i}`, 'aria-pressed': String(i === s.limitFinger), onclick: () => a.setLimitFinger(i) },
              f.name.charAt(0).toUpperCase() + f.name.slice(1),
            ),
          ),
        ),
      );
      const f = m.fingers[Math.min(s.limitFinger, m.fingers.length - 1)];
      if (f) {
        f.joints.forEach((ji, k) => {
          const joint = m.joints[ji];
          const rows: Child[] = [h('b', {}, JOINT_WORDS[Math.min(k + (3 - f.joints.length), 2)] ?? `Joint ${k + 1}`)];
          joint.dofs.forEach((d, di) => {
            const w = DOF_WORDS[d.kind] ?? DOF_WORDS.flex;
            const max = (d.max * 180) / Math.PI, min = (d.min * 180) / Math.PI;
            rows.push(
              slider(w.max, `fl-${ji}-${di}-max`, 0, 150, 1, max, deg, null, (v) => a.setFingerLimit(ji, di, min, v)),
              slider(w.min, `fl-${ji}-${di}-min`, 0, 60, 1, -min, deg, null, (v) => a.setFingerLimit(ji, di, -v, max)),
            );
          });
          out.push(h('div', { class: 'joint-limits' }, ...rows));
        });
      }
      out.push(
        s.limitsChanged
          ? h('p', { class: 'warning' }, 'Find grips again (Grip tab, step 4) to use the new finger limits.')
          : h('p', { class: 'note' }, 'The grip search never bends a finger past these.'),
        h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'button', key: 'finger-limits-reset', onclick: a.resetFingerLimits }, 'Back to automatic')),
      );
      return out;
    };

    // ---------- Animations tab ----------
    const animationsPage = (): Child[] => {
      const missing = !s.characterAvailable
        ? 'Animations need a whole character. Load one in the Hand step, or use the sample player.'
        : !s.armAvailable
          ? 'Animations need a character with arm bones above the hand.'
          : !chosen
            ? 'Find a grip first (Grip tab, steps 2 to 4), then come back here.'
            : '';
      if (missing) {
        return [
          h('h2', {}, 'Animations'),
          h('p', {}, missing),
          h('button', { class: 'btn primary', type: 'button', key: 'anim-to-grip', onclick: () => a.setTab('grip') }, 'Go to the grip steps'),
        ];
      }
      const shown = s.saved[s.shown] ?? null;
      const list = s.saved.length
        ? h(
            'ul',
            { class: 'saved', 'aria-label': 'Saved' },
            ...s.saved.map((c, i) => {
              const on = i === s.shown;
              const name = h('input', { type: 'text', value: c.name, key: `saved-name-${i}`, 'aria-label': 'Name', spellcheck: 'false' });
              name.addEventListener('change', () => a.renameSaved(i, name.value));
              const playing = on && c.kind === 'clip' && s.clipPlaying;
              const detail = c.kind === 'clip' ? `${c.seconds.toFixed(1)} s${c.loops ? ', loops' : ''}` : '';
              return h(
                'li',
                { class: on ? 'is-shown' : '' },
                h(
                  'button',
                  { class: `kind kind-${c.kind}`, type: 'button', key: `saved-show-${i}`, 'aria-pressed': String(on), title: 'Show on the character', onclick: () => (on && c.kind !== 'clip' ? undefined : a.showSaved(i)) },
                  c.kind === 'clip' ? (playing ? '❚❚' : '▶') : '',
                  KIND_WORDS[c.kind],
                ),
                name,
                h('span', { class: 'clip-len' }, detail),
                h('button', { class: 'icon-btn', type: 'button', key: `saved-del-${i}`, 'aria-label': `Delete ${c.name}`, title: 'Delete', onclick: () => a.deleteSaved(i) }, '✕'),
              );
            }),
          )
        : h('p', { class: 'empty' }, 'Nothing saved yet. Add a pose, an animation or a look below.');

      // what is shown, and its own controls
      const detail: Child[] = [];
      if (shown?.kind === 'pose') {
        detail.push(
          h('h3', {}, `${shown.name}: a still pose`),
          h('p', { class: 'note' }, 'The arm stays here. Change it with the arrows in the view, or the sliders.'),
          ...(s.canEditShown ? holdEditor('saved-') : []),
          h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'button', key: 'saved-from-arm', onclick: () => a.useArmPosition(s.shown) }, 'Replace with the Arm step’s position')),
        );
      } else if (shown?.kind === 'clip') {
        const out = h('output', {}, `${s.clipTime.toFixed(1)} / ${shown.seconds.toFixed(1)} s`);
        const range = h('input', { type: 'range', min: '0', max: String(shown.seconds), step: '0.01', value: String(s.clipTime), key: 'clip-time', 'aria-label': 'Time' });
        range.addEventListener('input', () => {
          out.textContent = `${Number(range.value).toFixed(1)} / ${shown.seconds.toFixed(1)} s`;
          a.clipSeek(Number(range.value));
        });
        this.clipLine = { range, out };
        detail.push(
          h('h3', {}, `${shown.name}: an animation`),
          h(
            'div',
            { class: 'transport' },
            h('button', { class: 'btn primary', type: 'button', key: 'clip-play', onclick: () => a.clipPlay(!s.clipPlaying) }, s.clipPlaying ? 'Pause' : 'Play'),
            h('div', { class: 'slider' }, h('span', { class: 'field-label' }, 'Time'), out, range),
          ),
          h(
            'p',
            { class: 'note' },
            `${shown.loops ? 'Repeats' : 'Plays once'}. It starts from where the arm was in the Arm step when you added it. The character stays on the spot, so the animation moves the arm and hand and your own walk moves the body.`,
          ),
        );
      } else if (shown?.kind === 'look' && shown.ranges) {
        const r = shown.ranges;
        const dot = h('span', { class: 'look-dot' });
        const readout = h('output', {}, '');
        const place = (yaw: number, pitch: number) => {
          dot.style.left = `${((yaw + r.left) / Math.max(1, r.left + r.right)) * 100}%`;
          dot.style.top = `${((r.up - pitch) / Math.max(1, r.up + r.down)) * 100}%`;
          const words = [
            Math.abs(pitch) < 0.5 ? '' : `${Math.round(Math.abs(pitch))}° ${pitch > 0 ? 'up' : 'down'}`,
            Math.abs(yaw) < 0.5 ? '' : `${Math.round(Math.abs(yaw))}° ${yaw > 0 ? 'right' : 'left'}`,
          ].filter(Boolean);
          readout.textContent = words.length ? `Looking ${words.join(', ')}` : 'Looking straight ahead';
        };
        place(s.lookAim[0], s.lookAim[1]);
        const pad = h(
          'div',
          { class: 'look-pad', key: 'look-pad', tabindex: '0', role: 'application', 'aria-label': 'Where the player looks. Drag, or use the arrow keys.' },
          h('span', { class: 'look-axis look-axis-x' }),
          h('span', { class: 'look-axis look-axis-y' }),
          dot,
        );
        const aimAt = (yaw: number, pitch: number, done: boolean) => {
          // near the middle counts as straight ahead
          if (Math.abs(yaw) < 0.06 * (r.left + r.right) && Math.abs(pitch) < 0.06 * (r.up + r.down)) yaw = pitch = 0;
          yaw = Math.min(r.right, Math.max(-r.left, yaw));
          pitch = Math.min(r.up, Math.max(-r.down, pitch));
          place(yaw, pitch);
          a.lookAim(yaw, pitch, done);
        };
        const fromPointer = (e: PointerEvent, done: boolean) => {
          const b = pad.getBoundingClientRect();
          const x = Math.min(1, Math.max(0, (e.clientX - b.left) / Math.max(1, b.width)));
          const y = Math.min(1, Math.max(0, (e.clientY - b.top) / Math.max(1, b.height)));
          aimAt(-r.left + x * (r.left + r.right), r.up - y * (r.up + r.down), done);
        };
        pad.addEventListener('pointerdown', (e) => {
          pad.setPointerCapture(e.pointerId);
          fromPointer(e, false);
        });
        pad.addEventListener('pointermove', (e) => {
          if (pad.hasPointerCapture(e.pointerId)) fromPointer(e, false);
        });
        pad.addEventListener('pointerup', (e) => {
          if (!pad.hasPointerCapture(e.pointerId)) return;
          pad.releasePointerCapture(e.pointerId);
          fromPointer(e, true);
        });
        pad.addEventListener('keydown', (e) => {
          const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[e.key];
          if (!step) return;
          e.preventDefault();
          a.lookAim(s.lookAim[0] + step[0], s.lookAim[1] + step[1], true);
        });
        const range = (label: string, key: keyof LookRanges, max: number) =>
          slider(label, `look-${key}`, 0, max, 1, r[key], deg, (v) => a.setLookRange(key, v, false), (v) => a.setLookRange(key, v, true));
        detail.push(
          h('h3', {}, `${shown.name}: follows the player’s view`),
          h('p', { class: 'note' }, 'Drag in the square to look around, as the player would with the mouse or stick. Looking up lifts the item, looking down lowers it, and left and right swing it round with the view.'),
          h(
            'div',
            { class: 'look' },
            h('span', { class: 'look-label look-up' }, 'Up'),
            h('span', { class: 'look-label look-left' }, 'Left'),
            pad,
            h('span', { class: 'look-label look-right' }, 'Right'),
            h('span', { class: 'look-label look-down' }, 'Down'),
          ),
          h('div', { class: 'row look-read' }, readout, h('button', { class: 'btn quiet', type: 'button', key: 'look-centre', onclick: () => a.lookAim(0, 0, true) }, 'Straight ahead')),
          h('span', { class: 'field-label' }, 'How far the view turns'),
          range('Up', 'up', 85),
          range('Down', 'down', 85),
          range('Left', 'left', 90),
          range('Right', 'right', 90),
          h('p', { class: 'note' }, 'Left and right are the player’s own. In your game, give the script the camera and it reads these angles from it.'),
          ...(s.canEditShown
            ? [h('span', { class: 'field-label' }, 'Position while looking straight ahead'), ...holdEditor('saved-')]
            : [h('p', { class: 'note' }, 'Choose “Straight ahead” to move or turn the position it is centred on.')]),
          h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'button', key: 'saved-from-arm', onclick: () => a.useArmPosition(s.shown) }, 'Centre it on the Arm step’s position')),
        );
      }

      const style = ITEM_STYLES.find((p) => p.id === s.itemStyle)!;
      const card = (title: string, text: string, ...body: Child[]) => h('div', { class: 'add-card' }, h('b', {}, title), h('p', {}, text), ...body);
      return [
        h('h2', {}, 'Animations'),
        h('p', {}, 'Everything in this list is saved with the export. Pick one to see it on the character.'),
        list,
        ...detail,
        h('h2', {}, 'Add'),
        card(
          'Pose',
          'A still position. The arm stays where you put it.',
          h('button', { class: 'btn', type: 'button', key: 'add-pose', onclick: a.savePose }, 'Add a pose'),
        ),
        card(
          'Animation',
          'A movement that plays. Choose what kind of item this is, then add the movements you need.',
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Item type' },
            ...ITEM_STYLES.map((p) =>
              h('button', { class: 'btn', type: 'button', key: `item-style-${p.id}`, 'aria-pressed': String(p.id === s.itemStyle), onclick: () => a.setItemStyle(p.id) }, p.label),
            ),
          ),
          h('p', { class: 'note' }, style.note),
          h(
            'div',
            { class: 'row' },
            ...MOTIONS.map((k) => h('button', { class: 'chip', type: 'button', key: `motion-${k}`, onclick: () => a.addMotion(k) }, `+ ${motionLabel(k, s.itemStyle)}`)),
          ),
        ),
        card(
          'Look',
          'For a player. The arm follows the view: look up and the item goes up, look down and it goes down, and the same to the left and right.',
          h('button', { class: 'btn', type: 'button', key: 'add-look', onclick: a.addLook }, 'Add a look'),
        ),
        h('p', { class: 'note' }, `New items start from the arm’s position in the Arm step (Grip tab, step 5). The arm keeps to the limits on the Character tab${s.bodyLimits.soft > 0.01 ? ', slowing down near their ends' : ''}.`),
      ];
    };

    const handSummary = s.hand ? `${s.hand.model.handedness === 'left' ? 'Left' : 'Right'}, ${s.hand.model.fingers.length} fingers` : '';
    const gripsSummary = s.grasps?.length ? `${s.grasps.filter((g) => g.stable).length} of ${s.grasps.length} hold` : '';

    this.progressBar = null;
    this.clipLine = null;
    this.renderHeader(s, !!chosen);
    const tree = [
      s.tab === 'character'
        ? h('div', { class: 'tab-page', role: 'tabpanel' }, ...characterPage())
        : s.tab === 'animations'
          ? h('div', { class: 'tab-page', role: 'tabpanel' }, ...animationsPage())
          : null,
      s.tab !== 'grip' ? null : h(
        'ol',
        { class: 'steps' },
        step(1, 'Hand', handSummary, !!s.hand, false, handBody),
        step(2, 'Object', s.object?.name ?? '', !!s.object, false, objectBody),
        step(3, 'Grip point', s.grip ? 'Marked' : '', s.grip, !s.object, gripBody),
        step(4, 'Find grips', gripsSummary, !!s.grasps?.length, !ready, findBody),
        step(5, 'Arm', s.armAvailable ? (s.sweepFrom && s.sweepTo ? 'Sweep set' : '') : 'Needs a character', false, !chosen || !s.armAvailable, armBody),
        step(6, 'Export', '', false, !chosen, exportBody),
      ),
      h('p', { class: 'panel-foot' }, 'Runs entirely in your browser. Models are never uploaded.'),
    ];
    this.root.replaceChildren(...tree.filter((n) => n !== null));
    if (focusKey) (this.root.querySelector(`[data-key="${focusKey}"]`) as HTMLElement | null)?.focus();
  }
}
