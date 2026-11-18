import { Matrix4, Quaternion, Vector3 } from 'three';
import { reachFingertip } from './pin';
import { type HandModel, openPose, rotationAbout } from '../hand/model';
import type { GraspObject } from './object';
import { type Contact, graspQuality } from './quality';

export interface GraspSettings {
  /** Point on the object's surface the palm should hold on to. */
  gripPoint: Vector3;
  /** Outward surface normal at that point. */
  gripNormal: Vector3;
  /** Direction of gravity (unit). Default: straight down the -Y axis. */
  gravity?: Vector3;
  /** Skin-to-object friction coefficient. Default 0.6. */
  friction?: number;
  /** 'fixed': the object stays this way up. 'any': it gets swung around like a tool or weapon. */
  mode?: 'fixed' | 'any';
  /** How many alternative grips to return. Default 5. */
  maxResults?: number;
  /**
   * Hold it this way: the fingers point along `fingers` (out of the fist, wrist to fingertips) and the knuckle line runs from the
   * little finger to the index finger along `thumb` (the thumb end of a bar). Both are in the solve space. When set, the palm's
   * approach is worked out from them (gripNormal is ignored) and every candidate more than `tolerance` radians (default 30 degrees)
   * off either direction is dropped, so a pistol grip is held like a pistol grip and not from the front.
   */
  aim?: { fingers: Vector3; thumb: Vector3; tolerance?: number };
  /**
   * Where the weight this hand must carry acts. Default: the object's own centre of mass. A gun's pistol grip is not held up by that
   * hand alone (the other hand, the shoulder, a sling carry the rest): putting the weight at the grip point judges the grip by how it
   * wraps, not by whether one hand could hold a rifle out by its grip.
   */
  com?: Vector3;
  /**
   * The hand is already placed: this is the wrist transform (hand model space to solve space), as a game or another tool puts the hand.
   * No placement is searched; the fingers and thumb are closed onto the object from there and the grip is judged as it stands. Used to
   * give an engine's own hand placement real finger wraps on the real mesh.
   */
  wrist?: Matrix4;
  /** Fingers (by name: thumb, index, middle, ring, pinky) left straight, only bent as far as they must to clear the object: a trigger finger laid along the frame. */
  relax?: string[];
  /**
   * With `wrist`: how far the hand may be moved from there to hold better, at most `move` (solve-space units) and `turn` (radians),
   * about the palm's middle. Staying close is preferred; the palm is never moved into the object. Without it the hand stays put.
   */
  adjust?: { move: number; turn: number };
  /** With `adjust`: a fingertip (finger index) that should reach a spot (solve space), a trigger finger and its trigger; places it can reach from count for more. */
  reach?: { finger: number; point: Vector3 };
}

/** The palm's outward surface normal and the knuckle-to-thumb direction a hand needs to point its fingers and thumb as `aim` asks. */
export function aimedApproach(model: HandModel, aim: { fingers: Vector3; thumb: Vector3 }): { normal: Vector3; fingers: Vector3; thumb: Vector3 } {
  const f = model.frame;
  const handX = new Vector3().crossVectors(f.up, f.normal).normalize();
  const fingers = aim.fingers.clone().normalize();
  const thumb = aim.thumb.clone().addScaledVector(fingers, -aim.thumb.dot(fingers)).normalize();
  // which way along handX the thumb side lies, read off the hand itself
  const s = thumbSide(model, handX);
  // the hand frame (handX, up, normal) is right-handed with normal = handX x up, so the palm faces (s*thumb) x fingers * s
  const x = thumb.clone().multiplyScalar(s);
  const palm = new Vector3().crossVectors(x, fingers).normalize();
  return { normal: palm.negate(), fingers, thumb };
}

function thumbSide(model: HandModel, handX: Vector3): number {
  const t = model.fingers.find((g) => g.isThumb);
  if (!t) return 1;
  const base = model.joints[t.joints[0]].position.clone().sub(model.frame.origin);
  return base.dot(handX) >= 0 ? 1 : -1;
}

/** Where and how the hand is placed before the fingers close. */
export interface CandidateParams {
  /** Rotation of the hand about the surface normal, radians. */
  theta: number;
  /** Tilt of the palm towards the fingers / towards the thumb side, radians. */
  pitch: number;
  roll: number;
  /** Which point of the palm lands on the grip point, as fractions of palm length / width. */
  anchorU: number;
  anchorS: number;
  /** How far the palm stays off the surface, as a fraction of the hand size (0 = palm touching). */
  standoff: number;
}

export interface Grasp {
  /** Maps the hand's rest space into the object's space. */
  wrist: Matrix4;
  /** Joint angles relative to the rest pose, one per degree of freedom. */
  angles: Float32Array;
  contacts: Contact[];
  /** True if these contacts can physically hold the object's weight. */
  stable: boolean;
  /** Grip force needed to hold the weight, in multiples of the weight. */
  effort: number;
  /** 0..1: resistance to bumps and twists while holding. */
  robustness: number;
  fingersTouching: number;
  thumbTouching: boolean;
  palmTouching: boolean;
  /** How many finger segments rest on the object, out of how many the hand has. */
  segmentsTouching: number;
  segmentsTotal: number;
  /** Overall ranking value, higher is better. */
  score: number;
  params: CandidateParams;
}

const _v = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();

/**
 * Finds grips of one hand on one object around a chosen grip point.
 *
 * For each candidate placement the open hand is moved up to the object until
 * it touches, each finger then curls until its segments meet the surface
 * (inner segments stop first, outer ones keep wrapping), and the resulting
 * contacts are checked physically: can they hold the weight, and how hard
 * does the hand have to squeeze to do it?
 */
export class GraspSolver {
  readonly tol: number;
  private readonly open: Float32Array;
  private readonly restCenters: Float64Array;
  private readonly radii: Float64Array;
  private readonly worldCenters: Float64Array;
  private readonly fingerSpheres: number[][] = [];
  private readonly palmSpheres: number[] = [];
  /** How deep the palm sat in the object at the last fixed-wrist evaluation (0 when clear). */
  palmDepth = 0;
  private readonly jointMats: Matrix4[];
  private readonly wristMat = new Matrix4();
  private readonly handX = new Vector3();
  private readonly fingerLength: number;
  private readonly gravity: Vector3;
  private readonly friction: number;
  private readonly mode: 'fixed' | 'any';
  private readonly t1 = new Vector3();
  private readonly t2 = new Vector3();
  private readonly n = new Vector3();
  evaluations = 0;

  constructor(
    readonly model: HandModel,
    readonly object: GraspObject,
    readonly settings: GraspSettings,
  ) {
    this.tol = 0.004 * model.size;
    this.open = openPose(model);
    const ns = model.spheres.length;
    this.restCenters = new Float64Array(ns * 3);
    this.worldCenters = new Float64Array(ns * 3);
    this.radii = new Float64Array(ns);
    model.fingers.forEach(() => this.fingerSpheres.push([]));
    model.spheres.forEach((s, i) => {
      this.restCenters[i * 3] = s.center.x;
      this.restCenters[i * 3 + 1] = s.center.y;
      this.restCenters[i * 3 + 2] = s.center.z;
      this.radii[i] = s.radius;
      if (s.finger >= 0) this.fingerSpheres[s.finger].push(i);
      else this.palmSpheres.push(i);
    });
    this.jointMats = model.joints.map(() => new Matrix4());
    this.handX.crossVectors(model.frame.up, model.frame.normal).normalize();
    let fl = 0;
    for (const f of model.fingers) if (!f.isThumb) fl = Math.max(fl, f.tip.distanceTo(model.joints[f.joints[0]].position));
    this.fingerLength = fl || model.size * 0.5;
    this.gravity = (settings.gravity ?? new Vector3(0, -1, 0)).clone().normalize();
    this.friction = settings.friction ?? 0.6;
    this.mode = settings.mode ?? 'fixed';
    if (settings.aim) {
      const a = aimedApproach(model, settings.aim);
      this.aim = { fingers: a.fingers, thumb: a.thumb, cos: Math.cos(settings.aim.tolerance ?? 30 * DEG) };
      this.thumbX = this.handX.clone().multiplyScalar(thumbSide(model, this.handX));
      this.n.copy(a.normal);
    } else this.n.copy(settings.gripNormal).normalize();
    // tangent basis at the grip point; t1 leans towards "up" so results read naturally
    this.t1.set(0, 1, 0);
    if (Math.abs(this.n.y) > 0.9) this.t1.set(1, 0, 0);
    this.t1.addScaledVector(this.n, -this.t1.dot(this.n)).normalize();
    this.t2.crossVectors(this.n, this.t1);
  }

  private aim: { fingers: Vector3; thumb: Vector3; cos: number } | null = null;
  private thumbX = new Vector3();

  /**
   * Held a given way, the fist closes round the given point: 0 when the fingers' contacts centre on it, 1 when they centre half a
   * palm or more away (the hand closed on something beside the grip, such as a receiver above a pistol grip).
   */
  private offCentre(contacts: Contact[], thumb: number): number {
    const c = new Vector3();
    let n = 0;
    for (const k of contacts)
      if (k.finger >= 0 && k.finger !== thumb) {
        c.add(k.point);
        n++;
      }
    if (!n) return 1;
    c.divideScalar(n);
    return Math.min(1, c.distanceTo(this.settings.gripPoint) / (0.5 * this.model.frame.palmLength));
  }

  /**
   * A finger whose open pose runs into the object is curled, a tenth of the way to a fist at a time, until it is clear, so it can
   * then wrap from outside the surface. Stays open when no curl clears it.
   */
  private curlClear(fi: number, angles: Float32Array) {
    const js = this.model.fingers[fi].joints;
    const spheres = this.fingerSpheres[fi];
    const clear = () => {
      this.poseFinger(fi, angles);
      for (const s of spheres) {
        this.placeSphere(s);
        if (this.clearance(s) < -this.tol) return false;
      }
      return true;
    };
    if (clear()) return;
    const start = js.map((j) => {
      const joint = this.model.joints[j];
      return angles.slice(joint.dofStart, joint.dofStart + joint.dofs.length);
    });
    for (let step = 1; step <= 10; step++) {
      const c = step / 10;
      js.forEach((j) => {
        const joint = this.model.joints[j];
        const d = joint.dofs.length - 1;
        angles[joint.dofStart + d] = joint.dofs[d].open + c * (joint.dofs[d].closed - joint.dofs[d].open);
      });
      if (clear()) return;
    }
    js.forEach((j, k) => angles.set(start[k], this.model.joints[j].dofStart));
    this.poseFinger(fi, angles);
  }

  /**
   * Wraps a finger of a hand that cannot move (the wrist is fixed): the finger is started curled by different amounts, the knuckle and
   * the joints beyond it separately, each start kept only if the finger is clear of the object there, and closed from it; the start
   * that ends with the most of the finger touching wins (the least curled on a tie). Closing from straight alone stops as soon as the
   * straight finger's tip meets something, which on a hand placed by someone else it often does long before the finger has wrapped
   * (a pistol grip's fingers bend mostly at the middle joints, round the front of the grip).
   */
  private wrapFinger(fi: number, angles: Float32Array, obstacles: number[]): boolean {
    const js = this.model.fingers[fi].joints;
    const spheres = this.fingerSpheres[fi];
    const start = angles.slice();
    let best: Float32Array | null = null;
    let bestScore = -1;
    let bestTouched = false;
    const starts: [number, number][] = [];
    for (const knuckle of [0, 0.2, 0.4, 0.6]) for (const rest of [0, 0.2, 0.4, 0.6, 0.8]) starts.push([knuckle, rest]);
    starts.sort((a, b) => a[0] + a[1] - b[0] - b[1]);
    for (const [knuckle, rest] of starts) {
      const trial = start.slice();
      js.forEach((j, k) => {
        const joint = this.model.joints[j];
        const d = joint.dofs.length - 1;
        const c = k === 0 ? knuckle : rest;
        trial[joint.dofStart + d] = Math.max(start[joint.dofStart + d], joint.dofs[d].open + c * (joint.dofs[d].closed - joint.dofs[d].open));
      });
      this.poseFinger(fi, trial);
      let clear = true;
      for (const s of spheres) {
        this.placeSphere(s);
        if (this.clearance(s) < -this.tol) { clear = false; break; }
      }
      if (!clear) continue;
      const touched = this.closeFinger(fi, trial, obstacles);
      let score = 0;
      for (const s of spheres) if (this.model.spheres[s].link >= 1 && this.clearance(s) < this.tol) score++;
      if (score > bestScore) {
        bestScore = score;
        best = trial;
        bestTouched = touched;
      }
    }
    if (!best) return this.closeFinger(fi, angles, obstacles);
    angles.set(best);
    this.poseFinger(fi, angles);
    for (const s of spheres) this.placeSphere(s);
    return bestTouched;
  }

  /** The candidate turn that points the fingers straight along the aim, if there is one. */
  aimTheta(): number | null {
    if (!this.aim) return null;
    return Math.atan2(this.aim.fingers.dot(this.t2), this.aim.fingers.dot(this.t1));
  }

  /** Recomputes the pose matrices of one finger's joints from the angle array. */
  private poseFinger(fi: number, angles: Float32Array) {
    const js = this.model.fingers[fi].joints;
    for (let k = 0; k < js.length; k++) {
      const joint = this.model.joints[js[k]];
      const m = this.jointMats[js[k]];
      if (k === 0) m.identity();
      else m.copy(this.jointMats[js[k - 1]]);
      for (let d = 0; d < joint.dofs.length; d++) {
        const a = angles[joint.dofStart + d];
        if (a === 0) continue;
        m.multiply(rotationAbout(joint.position, joint.dofs[d].axis, a, _m));
      }
    }
  }

  /** World centre of sphere i for the current wrist and joint matrices. */
  private placeSphere(i: number) {
    const s = this.model.spheres[i];
    _v.set(this.restCenters[i * 3], this.restCenters[i * 3 + 1], this.restCenters[i * 3 + 2]);
    if (s.joint > 0) _v.applyMatrix4(this.jointMats[s.joint]);
    _v.applyMatrix4(this.wristMat);
    this.worldCenters[i * 3] = _v.x;
    this.worldCenters[i * 3 + 1] = _v.y;
    this.worldCenters[i * 3 + 2] = _v.z;
  }

  private clearance(i: number): number {
    return (
      this.object.distance(this.worldCenters[i * 3], this.worldCenters[i * 3 + 1], this.worldCenters[i * 3 + 2]) -
      this.radii[i]
    );
  }

  private sphereGap(i: number, j: number): number {
    const w = this.worldCenters;
    return (
      Math.hypot(w[i * 3] - w[j * 3], w[i * 3 + 1] - w[j * 3 + 1], w[i * 3 + 2] - w[j * 3 + 2]) -
      this.radii[i] -
      this.radii[j]
    );
  }

  /**
   * Wraps one finger onto the object, from its current angles.
   *
   * The joints close one at a time, starting at the knuckle. Each one turns
   * until a segment beyond it meets the surface (or the hand itself), and then
   * the next joint out takes over. A finger closed this way lies along the
   * object with as much of its length touching as the shape allows; closing
   * every joint together instead tends to bring the fingertip down first and
   * leave the rest of the finger arched over the surface.
   * Returns whether the finger ended up touching the object.
   */
  private closeFinger(fi: number, angles: Float32Array, obstacles: number[]): boolean {
    const model = this.model;
    const finger = model.fingers[fi];
    const js = finger.joints;
    const n = js.length;
    const spheres = this.fingerSpheres[fi];
    const links = spheres.map((s) => model.spheres[s].link);

    // hand parts this finger already overlaps are not obstacles (knuckle against palm)
    this.poseFinger(fi, angles);
    for (const s of spheres) this.placeSphere(s);
    const ignore = new Set<number>();
    for (let i = 0; i < spheres.length; i++) {
      if (links[i] < 1) continue;
      for (const o of obstacles) if (this.sphereGap(spheres[i], o) < this.tol) ignore.add(spheres[i] * 4096 + o);
    }

    for (let k = 0; k < n; k++) {
      const joint = model.joints[js[k]];
      const d = joint.dofs.length - 1;
      const index = joint.dofStart + d;
      const goal = joint.dofs[d].closed;
      const sign = goal >= angles[index] ? 1 : -1;
      // nothing on the finger beyond this joint is further from it than this
      let reach = 0;
      for (let m = k; m < n; m++) {
        const from = model.joints[js[m]].position;
        const to = m + 1 < n ? model.joints[js[m + 1]].position : finger.tip;
        reach += from.distanceTo(to);
      }
      reach += finger.radii[n - 1];
      for (let iter = 0; iter < 48; iter++) {
        // room left before any segment this joint moves runs into something
        let room = Infinity;
        for (let i = 0; i < spheres.length; i++) {
          if (links[i] < k) continue;
          const s = spheres[i];
          const c = this.clearance(s);
          if (c < room) room = c;
          if (links[i] >= 1) {
            for (const o of obstacles) {
              if (ignore.has(s * 4096 + o)) continue;
              const g = this.sphereGap(s, o);
              if (g < room) room = g;
            }
          }
        }
        if (room < this.tol) break;
        const left = (goal - angles[index]) * sign;
        if (left < 1e-5) break;
        angles[index] += sign * Math.min(left, (0.9 * room) / reach);
        this.poseFinger(fi, angles);
        for (const s of spheres) this.placeSphere(s);
      }
    }
    let touched = false;
    for (const s of spheres) if (this.clearance(s) < this.tol) touched = true;
    return touched;
  }

  /** Builds the wrist transform for a candidate, with the palm anchor `back` away from the grip point. */
  private placeWrist(p: CandidateParams, back: number, rot: Quaternion, anchor: Vector3, palmDir: Vector3) {
    _v.copy(anchor).applyQuaternion(rot);
    const g = this.settings.gripPoint;
    this.wristMat.makeRotationFromQuaternion(rot);
    this.wristMat.setPosition(
      g.x - palmDir.x * back - _v.x,
      g.y - palmDir.y * back - _v.y,
      g.z - palmDir.z * back - _v.z,
    );
    void p;
  }

  /** Turns the open hand as `p` asks and brings it in until the palm (or a finger) touches. Returns how far it stopped short, or null. */
  private approach(p: CandidateParams, angles: Float32Array): number | null {
    const { model, object, tol } = this;
    const f = model.frame;
    // orientation: palm faces the surface, hand "up" points along theta in the tangent plane
    const upW = new Vector3().addScaledVector(this.t1, Math.cos(p.theta)).addScaledVector(this.t2, Math.sin(p.theta));
    const palmDir = this.n.clone().negate();
    const xW = new Vector3().crossVectors(upW, palmDir);
    if (p.pitch !== 0 || p.roll !== 0) {
      _q.setFromAxisAngle(xW, p.pitch);
      const q2 = new Quaternion().setFromAxisAngle(upW, p.roll);
      _q.multiply(q2);
      upW.applyQuaternion(_q);
      palmDir.applyQuaternion(_q);
      xW.applyQuaternion(_q);
    }
    const hand = new Matrix4().makeBasis(this.handX, f.up, f.normal);
    const world = new Matrix4().makeBasis(xW, upW, palmDir);
    const rot = new Quaternion().setFromRotationMatrix(world.multiply(hand.transpose()));
    if (this.aim) {
      _v.copy(f.up).applyQuaternion(rot);
      if (_v.dot(this.aim.fingers) < this.aim.cos) return null;
      _v.copy(this.thumbX).applyQuaternion(rot);
      if (_v.dot(this.aim.thumb) < this.aim.cos) return null;
    }
    const anchor = f.origin
      .clone()
      .addScaledVector(f.up, p.anchorU * f.palmLength)
      .addScaledVector(this.handX, p.anchorS * f.palmWidth);

    // approach with the open hand until something touches
    for (let fi = 0; fi < model.fingers.length; fi++) this.poseFinger(fi, angles);
    let back = 2 * object.radius + 1.5 * model.size;
    const limit = -0.35 * model.size;
    let contact = false;
    const all = model.spheres.length;
    for (let iter = 0; iter < 60; iter++) {
      this.placeWrist(p, back, rot, anchor, palmDir);
      let minC = Infinity;
      for (let i = 0; i < all; i++) {
        this.placeSphere(i);
        // held a given way, the palm leads: open fingers that run into a wider part beside the grip are curled clear afterwards
        if (this.aim && model.spheres[i].finger >= 0) continue;
        const c = this.clearance(i);
        if (c < minC) minC = c;
      }
      if (minC < -3 * tol && iter === 0) return null; // started inside the object
      if (minC < tol) {
        contact = true;
        break;
      }
      back -= Math.max(minC * 0.98, tol * 0.5);
      if (back < limit) break;
    }
    if (!contact) return null;
    const gap = Math.max(0, back);
    if (p.standoff > 0) {
      back += p.standoff * model.size;
      this.placeWrist(p, back, rot, anchor, palmDir);
      for (let i = 0; i < all; i++) this.placeSphere(i);
    }
    return gap;
  }

  /** Runs one candidate placement all the way to a scored grip. Null if the hand cannot get there. */
  evaluate(p: CandidateParams): Grasp | null {
    this.evaluations++;
    const { model, object, tol } = this;
    const f = model.frame;

    const fixed = this.settings.wrist;
    const angles = this.open.slice();
    let gap = 0;
    if (fixed) {
      // placed already: the open hand where it was put, fingers closed from there
      this.wristMat.copy(fixed);
      for (let fi = 0; fi < model.fingers.length; fi++) this.poseFinger(fi, angles);
      for (let i = 0; i < model.spheres.length; i++) this.placeSphere(i);
      this.palmDepth = 0;
      for (const s of this.palmSpheres) this.palmDepth = Math.max(this.palmDepth, -this.clearance(s));
    } else {
      const g = this.approach(p, angles);
      if (g === null) return null;
      gap = g;
    }
    const lead = !!this.aim || !!fixed;
    const relaxed = new Set((this.settings.relax ?? []).map((n) => n.toLowerCase()));

    // fingers first, each wrapping until it meets the surface
    const touched = new Array<boolean>(model.fingers.length).fill(false);
    let thumb = -1;
    for (let fi = 0; fi < model.fingers.length; fi++) {
      if (model.fingers[fi].isThumb) {
        thumb = fi;
        continue;
      }
      if (lead) this.curlClear(fi, angles);
      if (relaxed.has(model.fingers[fi].name.toLowerCase())) continue;
      touched[fi] = fixed ? this.wrapFinger(fi, angles, this.palmSpheres) : this.closeFinger(fi, angles, this.palmSpheres);
    }
    if (lead && thumb >= 0) this.curlClear(thumb, angles);

    // fingers that met nothing relax to match the ones that did, instead of making a fist
    const closure = (fi: number): number => {
      let s = 0, cnt = 0;
      for (const j of model.fingers[fi].joints) {
        const joint = model.joints[j];
        const d = joint.dofs.length - 1;
        const span = joint.dofs[d].closed - joint.dofs[d].open;
        if (Math.abs(span) < 1e-6) continue;
        s += (angles[joint.dofStart + d] - joint.dofs[d].open) / span;
        cnt++;
      }
      return cnt ? s / cnt : 0;
    };
    let meanClosure = 0, nTouch = 0;
    for (let fi = 0; fi < model.fingers.length; fi++)
      if (fi !== thumb && touched[fi]) {
        meanClosure += closure(fi);
        nTouch++;
      }
    const closures: number[] = [];
    for (let fi = 0; fi < model.fingers.length; fi++) {
      if (fi === thumb) continue;
      if (!touched[fi] && !relaxed.has(model.fingers[fi].name.toLowerCase())) {
        const target = nTouch ? Math.min(1, meanClosure / nTouch + 0.08) : 0.55;
        const now = closure(fi);
        if (now > target) {
          const before: number[] = [];
          for (const j of model.fingers[fi].joints) {
            const joint = model.joints[j];
            const d = joint.dofs.length - 1;
            const i = joint.dofStart + d;
            before.push(angles[i]);
            angles[i] = joint.dofs[d].open + (angles[i] - joint.dofs[d].open) * (target / now);
          }
          this.poseFinger(fi, angles);
          let ok = true;
          for (const s of this.fingerSpheres[fi]) {
            this.placeSphere(s);
            if (this.clearance(s) < -tol) ok = false;
          }
          if (!ok) {
            // the relaxed pose would cut into the object: keep the closed one
            model.fingers[fi].joints.forEach((j, k) => {
              const joint = model.joints[j];
              angles[joint.dofStart + joint.dofs.length - 1] = before[k];
            });
            this.poseFinger(fi, angles);
            for (const s of this.fingerSpheres[fi]) this.placeSphere(s);
          }
        }
      }
      closures.push(closure(fi));
    }

    // thumb last, trying a few amounts of swing out in front of the palm
    let best: Grasp | null = null;
    const finish = (thumbTouched: boolean): Grasp => {
      if (thumb >= 0) touched[thumb] = thumbTouched;
      const contacts = this.collectContacts();
      const q = graspQuality(contacts, {
        friction: this.friction,
        gravity: this.gravity,
        com: this.settings.com ?? object.com,
        lever: Math.min(Math.max(object.radius, 0.1 * model.size), 0.6 * model.size),
        mode: this.mode,
      });
      const fingersTouching = new Set(contacts.filter((c) => c.finger >= 0).map((c) => c.finger)).size;
      const palmTouching = contacts.some((c) => c.finger < 0);
      const thumbTouching = thumb >= 0 && contacts.some((c) => c.finger === thumb);
      const segmentsTouching = new Set(contacts.filter((c) => c.finger >= 0).map((c) => c.finger * 8 + c.link)).size;
      let segmentsTotal = 0;
      for (const fg of model.fingers) segmentsTotal += fg.joints.length;
      // how much of the hand is actually on the object: every finger segment counts, and the palm counts double
      const coverage = (segmentsTouching + (palmTouching ? 2 : 0)) / (segmentsTotal + 2);
      let mean = 0;
      for (const c of closures) mean += c;
      mean /= Math.max(1, closures.length);
      let varc = 0;
      for (const c of closures) varc += (c - mean) * (c - mean);
      const even = 1 - Math.min(1, Math.sqrt(varc / Math.max(1, closures.length)) / 0.35);
      // A hand can squeeze far harder than most things weigh, so needing some
      // squeeze costs little; what matters more is that the grip keeps holding
      // when the object is bumped, tilted or twisted.
      // needing more than a dozen times the weight in grip force is not a hold anyone could keep
      if (q.stable && q.effort > 12) q.stable = false;
      const hold = q.stable ? Math.min(1, Math.max(0.05, 1 - (q.effort - 1) / 6)) : 0;
      const score =
        0.3 * hold +
        0.32 * q.robustness +
        0.28 * coverage +
        0.05 * (thumbTouching ? 1 : 0) +
        0.05 * even -
        0.12 * Math.min(1, gap / (0.5 * model.size)) -
        (this.aim ? 0.35 * this.offCentre(contacts, thumb) : 0);
      return {
        wrist: this.wristMat.clone(),
        angles: angles.slice(),
        contacts,
        stable: q.stable,
        effort: q.effort,
        robustness: q.robustness,
        fingersTouching,
        thumbTouching,
        palmTouching,
        segmentsTouching,
        segmentsTotal,
        score,
        params: { ...p },
      };
    };

    if (thumb < 0 || relaxed.has(model.fingers[thumb].name.toLowerCase())) return finish(false);
    // The thumb is tried swung out in front of the palm and opened away from
    // the fingers by different amounts, then curled until it touches. The
    // position kept is the one where it presses most nearly opposite to the
    // fingers: that is what makes a grip close around something.
    const tj = model.joints[model.fingers[thumb].joints[0]];
    const levels = (kind: string) => {
      const k = tj.dofs.findIndex((d) => d.kind === kind);
      return k < 0 ? { index: -1, values: [0] } : { index: tj.dofStart + k, values: [0, 0.5 * tj.dofs[k].max, tj.dofs[k].max] };
    };
    const abduct = levels('abduct'), spread = levels('spread');
    const obstacles = [...this.palmSpheres];
    for (let fi = 0; fi < model.fingers.length; fi++) if (fi !== thumb) obstacles.push(...this.fingerSpheres[fi]);
    const thumbDofs: number[] = [];
    for (const j of model.fingers[thumb].joints) {
      const joint = model.joints[j];
      for (let d = 0; d < joint.dofs.length; d++) thumbDofs.push(joint.dofStart + d);
    }
    const saved = thumbDofs.map((i) => angles[i]);
    const reachTol = 2.5 * tol;
    const meanPush = (spheres: number[]): Vector3 | null => {
      const sum = new Vector3();
      let count = 0;
      for (const s of spheres) {
        if (this.clearance(s) >= reachTol) continue;
        sum.add(object.lastNormal);
        count++;
      }
      return count ? sum.normalize() : null;
    };
    // which way the object pushes back on the fingers (or on the palm if no finger touches)
    const others: number[] = [];
    for (let fi = 0; fi < model.fingers.length; fi++) if (fi !== thumb) others.push(...this.fingerSpheres[fi]);
    const against = meanPush(others) ?? meanPush(this.palmSpheres);

    let bestAngles: number[] | null = null;
    let bestScore = -Infinity;
    let bestTouched = false;
    const abdMax = Math.max(1e-6, abduct.values[abduct.values.length - 1]);
    const sprMax = Math.max(1e-6, spread.values[spread.values.length - 1]);
    for (const abd of abduct.values)
      for (const spr of spread.values) {
        // not both at their limits at once: no thumb goes that far, and the skin at its base would tear
        if (abd / abdMax + spr / sprMax > 1.25) continue;
        thumbDofs.forEach((i, k) => (angles[i] = saved[k]));
        if (abduct.index >= 0) angles[abduct.index] = abd;
        if (spread.index >= 0) angles[spread.index] = spr;
        this.poseFinger(thumb, angles);
        let clear = true;
        for (const s of this.fingerSpheres[thumb]) {
          this.placeSphere(s);
          if (this.clearance(s) < -tol) clear = false;
        }
        if (!clear) continue;
        const t = this.closeFinger(thumb, angles, obstacles);
        const push = t ? meanPush(this.fingerSpheres[thumb]) : null;
        const lying = new Set<number>();
        if (t) for (const sp of this.fingerSpheres[thumb]) if (this.clearance(sp) < reachTol) lying.add(model.spheres[sp].link);
        // touching beats not touching; the more opposed to the fingers, the better,
        // and the more of the thumb that lies on the object, the better;
        // when nothing is touched, the least contorted thumb wins
        const score = push
          ? 2 + (against ? -push.dot(against) : 0) + (0.3 * lying.size) / model.fingers[thumb].joints.length
          : -(abd + spr);
        if (score > bestScore) {
          bestScore = score;
          bestTouched = t;
          bestAngles = thumbDofs.map((i) => angles[i]);
        }
      }
    const use = bestAngles ?? saved;
    thumbDofs.forEach((i, k) => (angles[i] = use[k]));
    this.poseFinger(thumb, angles);
    for (const s of this.fingerSpheres[thumb]) this.placeSphere(s);
    return finish(bestAngles ? bestTouched : false);
  }

  /** Contacts for the current sphere positions: at most two per finger segment and six on the palm. */
  private collectContacts(): Contact[] {
    const { model, object } = this;
    const reachTol = 2.5 * this.tol;
    const byLink = new Map<number, { c: number; point: Vector3; normal: Vector3 }[]>();
    for (let i = 0; i < model.spheres.length; i++) {
      const c = this.clearance(i);
      if (c >= reachTol) continue;
      const s = model.spheres[i];
      const key = s.finger < 0 ? -1 : s.finger * 8 + s.link;
      let list = byLink.get(key);
      if (!list) byLink.set(key, (list = []));
      list.push({ c, point: object.lastPoint.clone(), normal: object.lastNormal.clone() });
    }
    const out: Contact[] = [];
    for (const [key, list] of byLink) {
      list.sort((a, b) => a.c - b.c);
      const keep = key < 0 ? 6 : 2;
      const chosen = [list[0]];
      while (chosen.length < keep) {
        // furthest remaining contact from those already chosen
        let bi = -1, bd = 0;
        for (let i = 0; i < list.length; i++) {
          let d = Infinity;
          for (const ch of chosen) d = Math.min(d, ch.point.distanceTo(list[i].point));
          if (d > bd) {
            bd = d;
            bi = i;
          }
        }
        if (bi < 0 || bd < 0.02 * model.size) break;
        chosen.push(list[bi]);
      }
      for (const ch of chosen)
        out.push({ point: ch.point, normal: ch.normal, finger: key < 0 ? -1 : key >> 3, link: key < 0 ? -1 : key & 7 });
    }
    return out;
  }
}

const DEG = Math.PI / 180;

function distinct(a: Grasp, b: Grasp, model: HandModel): boolean {
  const pa = model.frame.origin.clone().applyMatrix4(a.wrist);
  const pb = model.frame.origin.clone().applyMatrix4(b.wrist);
  if (pa.distanceTo(pb) > 0.22 * model.size) return true;
  const qa = new Quaternion().setFromRotationMatrix(a.wrist);
  const qb = new Quaternion().setFromRotationMatrix(b.wrist);
  return qa.angleTo(qb) > 40 * DEG;
}

function pickDistinct(list: Grasp[], count: number, model: HandModel): Grasp[] {
  const sorted = [...list].sort((a, b) => Number(b.stable) - Number(a.stable) || b.score - a.score);
  const out: Grasp[] = [];
  for (const g of sorted) {
    if (out.every((o) => distinct(o, g, model))) out.push(g);
    if (out.length >= count) break;
  }
  return out;
}

const PLACED: CandidateParams = { theta: 0, pitch: 0, roll: 0, anchorU: 0, anchorS: 0, standoff: 0 };

/**
 * The best grip near a hand that was already placed: the hand is shifted along and turned about its own axes, through the palm's
 * middle, a step at a time (each of the six tried both ways, kept when better, then the steps halved). A grip is judged by the
 * solver's own score, with holding at all and the palm on the object counting extra; every bit of the allowed move or turn used
 * costs, so the hand only moves for a clearly better grip, and a palm moved into the object rules a place out.
 */
async function adjustPlacement(
  solver: GraspSolver,
  model: HandModel,
  base: Matrix4,
  adjust: { move: number; turn: number },
  callbacks: SolveCallbacks,
): Promise<Grasp | null> {
  const f = model.frame;
  const pivot = f.origin.clone().applyMatrix4(base);
  const side = new Vector3().crossVectors(f.up, f.normal).normalize();
  const axes = [f.normal, f.up, side].map((a) => a.clone().transformDirection(base));
  const startDepth = (() => {
    solver.settings.wrist = base;
    solver.evaluate(PLACED);
    return solver.palmDepth;
  })();
  const at = (x: number[]) => {
    const q = new Quaternion();
    for (let k = 0; k < 3; k++) q.premultiply(new Quaternion().setFromAxisAngle(axes[k], x[3 + k]));
    const shift = new Vector3();
    for (let k = 0; k < 3; k++) shift.addScaledVector(axes[k], x[k]);
    return new Matrix4()
      .makeTranslation(pivot.x + shift.x, pivot.y + shift.y, pivot.z + shift.z)
      .multiply(new Matrix4().makeRotationFromQuaternion(q))
      .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
      .multiply(base);
  };
  const judge = (x: number[]): { g: Grasp | null; value: number } => {
    solver.settings.wrist = at(x);
    const g = solver.evaluate(PLACED);
    // never deeper into the object than where it was put
    if (!g || solver.palmDepth > Math.max(startDepth, 0) + 0.25 * solver.tol) return { g: null, value: -Infinity };
    const moved = Math.hypot(x[0], x[1], x[2]) / adjust.move;
    const turned = Math.hypot(x[3], x[4], x[5]) / adjust.turn;
    // a finger wrapped round the object touches along two segments or more; one only touching at its end is just resting there
    let wrapped = 0;
    const relaxed = new Set((solver.settings.relax ?? []).map((n) => n.toLowerCase()));
    const reach = solver.settings.reach;
    model.fingers.forEach((fg, fi) => {
      if (fg.name === 'thumb' || relaxed.has(fg.name.toLowerCase()) || fi === reach?.finger) return;
      if (new Set(g.contacts.filter((c) => c.finger === fi).map((c) => c.link)).size >= 2) wrapped++;
    });
    // how far the fingertip that has a spot to reach stops short of it, as a share of a third of the hand
    const short = reach ? Math.min(1, reachFingertip(model, g.angles, reach.finger, reach.point.clone().applyMatrix4(g.wrist.clone().invert())).miss / (0.3 * model.size)) : 0;
    const value =
      g.score + (g.stable ? 0.25 : 0) + (g.palmTouching ? 0.1 : 0) + 0.12 * wrapped - 0.6 * short - 0.15 * (moved * moved + turned * turned);
    return { g, value };
  };
  // started from where the hand was put and from a few places along the knuckles' line (a finger level with a trigger guard's bar
  // only wraps the grip once the hand is past the bar, which no small step finds on its own)
  let best: { g: Grasp | null; value: number } = { g: null, value: -Infinity };
  const starts = [0, -0.25, 0.25, -0.5, 0.5];
  let last = Date.now();
  for (let si = 0; si < starts.length; si++) {
    let x = [0, 0, starts[si] * adjust.move, 0, 0, 0];
    let here = judge(x);
    const step = [0.5 * adjust.move, 0.5 * adjust.move, 0.5 * adjust.move, 0.5 * adjust.turn, 0.5 * adjust.turn, 0.5 * adjust.turn];
    for (let round = 0; round < 4; round++) {
      let improved = true;
      for (let pass = 0; pass < 3 && improved; pass++) {
        improved = false;
        for (let k = 0; k < 6; k++)
          for (const dir of [1, -1]) {
            const y = x.slice();
            y[k] += dir * step[k];
            const limit = k < 3 ? adjust.move : adjust.turn;
            if (Math.abs(y[k]) > limit + 1e-9) continue;
            const r = judge(y);
            if (r.value > here.value + 1e-4) {
              here = r;
              x = y;
              improved = true;
            }
            if (Date.now() - last > 30) {
              await new Promise<void>((res) => setTimeout(res, 0));
              last = Date.now();
            }
            if (callbacks.cancelled?.()) return null;
          }
      }
      for (let k = 0; k < 6; k++) step[k] *= 0.5;
    }
    if (here.value > best.value) best = here;
    callbacks.onProgress?.((si + 1) / starts.length);
  }
  solver.settings.wrist = base;
  return best.g ?? solver.evaluate(PLACED);
}

export interface SolveCallbacks {
  /** Called with 0..1 as the search progresses. */
  onProgress?: (fraction: number) => void;
  /** Return true to stop early. */
  cancelled?: () => boolean;
}

/**
 * Searches hand placements around the grip point and returns the best
 * distinct grips, most stable first. Yields to the event loop regularly so a
 * page stays responsive.
 */
export async function solveGrasp(
  model: HandModel,
  object: GraspObject,
  settings: GraspSettings,
  callbacks: SolveCallbacks = {},
): Promise<Grasp[]> {
  const solver = new GraspSolver(model, object, settings);
  const results: Grasp[] = [];
  let last = Date.now();
  const pause = async () => {
    if (Date.now() - last < 30) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    last = Date.now();
  };
  const maxResults = settings.maxResults ?? 5;

  // placed already (an engine's own hand placement): one grip, the fingers closed from where the hand is
  if (settings.wrist) {
    const g = settings.adjust ? await adjustPlacement(solver, model, settings.wrist, settings.adjust, callbacks) : solver.evaluate(PLACED);
    callbacks.onProgress?.(1);
    return g ? [g] : [];
  }

  // stage 1: turn the hand all the way round the grip point
  const base: CandidateParams[] = [];
  const aimed = solver.aimTheta();
  if (aimed !== null) {
    // held a given way: only small turns and tilts round that way, and the palm slid along the bar
    for (const dt of [0, -12, 12, -24, 24])
      for (const pitch of [0, -15, 15])
        // a bar is held across the base of the fingers (the palm's crease), not in the middle of the palm
        for (const anchorU of [0.25, 0.45, 0.65])
          for (const anchorS of [0, -0.25, 0.25, 0.5])
            base.push({ theta: aimed + dt * DEG, pitch: pitch * DEG, roll: 0, anchorU, anchorS, standoff: 0 });
  } else
    for (let k = 0; k < 12; k++)
      for (const anchorU of [0, 0.3])
        for (const standoff of [0, 0.22])
          base.push({ theta: (k / 12) * Math.PI * 2, pitch: 0, roll: 0, anchorU, anchorS: 0, standoff });
  const total = base.length + 8 * 6 + 5 * 24;
  let done = 0;
  const run = async (p: CandidateParams): Promise<Grasp | null> => {
    const g = solver.evaluate(p);
    done++;
    callbacks.onProgress?.(Math.min(1, done / total));
    await pause();
    return g;
  };
  for (const p of base) {
    if (callbacks.cancelled?.()) return [];
    const g = await run(p);
    if (g) results.push(g);
  }

  // stage 2: tilt and half-steps around the most promising ones
  const promising = pickDistinct(results, 8, model);
  for (const g of promising) {
    const p = g.params;
    const variants: CandidateParams[] = [
      { ...p, pitch: 20 * DEG },
      { ...p, pitch: -20 * DEG },
      { ...p, roll: 20 * DEG },
      { ...p, roll: -20 * DEG },
      { ...p, theta: p.theta + 15 * DEG },
      { ...p, theta: p.theta - 15 * DEG },
    ];
    for (const v of variants) {
      if (callbacks.cancelled?.()) return [];
      const r = await run(v);
      if (r) results.push(r);
    }
  }

  // stage 3: polish the best few with small random nudges
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const finalists = pickDistinct(results, Math.max(5, maxResults), model);
  const polished: Grasp[] = [];
  for (const start of finalists) {
    let cur = start;
    for (let round = 0; round < 2; round++) {
      const s = round === 0 ? 1 : 0.5;
      for (let i = 0; i < 12; i++) {
        if (callbacks.cancelled?.()) return [];
        const p = cur.params;
        const r = await run({
          theta: p.theta + rand() * 24 * DEG * s,
          pitch: p.pitch + rand() * 20 * DEG * s,
          roll: p.roll + rand() * 20 * DEG * s,
          anchorU: p.anchorU + rand() * 0.25 * s,
          anchorS: p.anchorS + rand() * 0.25 * s,
          standoff: Math.max(0, p.standoff + rand() * 0.12 * s * (p.standoff > 0 ? 1 : 0)),
        });
        if (r && (Number(r.stable) > Number(cur.stable) || (r.stable === cur.stable && r.score > cur.score))) cur = r;
      }
    }
    polished.push(cur);
  }
  callbacks.onProgress?.(1);
  return pickDistinct(polished, maxResults, model);
}
