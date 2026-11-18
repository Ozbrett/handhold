import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  ShadowMaterial,
  SkeletonHelper,
  type SkinnedMesh,
  SphereGeometry,
  Sphere,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Contact } from '../core/grasp/quality';
import { type HandPose, type RiggedHand, mixPose, setHandPose } from './handRig';
import { type ArmBones, followColours } from './skinCheck';

export interface ViewOptions {
  bones: boolean;
  fit: boolean;
  contacts: boolean;
  /** Paint the hand by which bone each part of the skin follows. */
  weights: boolean;
}

const FINGER_VARS: Record<string, string> = {
  thumb: '--thumb',
  index: '--index',
  middle: '--middle',
  ring: '--ring',
  pinky: '--pinky',
};
const FALLBACK_VARS = ['--index', '--middle', '--ring', '--pinky', '--thumb'];

/** The 3D view: shows the hand, the object, and what the solver knows about them. */
export class Viewer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(32, 1, 0.01, 100);
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  /** Called when the object is clicked while `picking` is on. */
  onPick?: (point: Vector3, normal: Vector3) => void;
  picking = false;
  view: ViewOptions = { bones: false, fit: false, contacts: true, weights: false };
  /** Joint positions that can be clicked (bone editing), and what to do when one is. */
  private jointPoints: Vector3[] | null = null;
  private onJointPick?: (index: number) => void;
  private onHoldDrop?: (position: Vector3) => void;
  private weightMaterial: MeshStandardMaterial | null = null;

  private hand: RiggedHand | null = null;
  private object: Object3D | null = null;
  private readonly overlay = new Group();
  /** Holds the object, grip mark and contact dots; moved as one into a character's hand. */
  private readonly stage = new Group();
  private character: Object3D | null = null;
  /** The character's own skeleton, drawn through its skin in character view when Bones is on. */
  private characterBones: SkeletonHelper | null = null;
  /** The character's arms, for the whole-body weights view (red follows a hand, blue stays with the forearm). */
  private characterArms: ArmBones[] = [];
  characterView = false;
  private readonly gizmo: TransformControls;
  private readonly gizmoProxy = new Object3D();
  private onHoldMove?: (position: Vector3) => void;
  private dragging = false;
  private reachGuide: Mesh | null = null;
  private arcGuide: Line | null = null;
  private fit: InstancedMesh | null = null;
  private boneLines: LineSegments | null = null;
  private jointDots: InstancedMesh | null = null;
  private contactDots: InstancedMesh | null = null;
  private contacts: Contact[] = [];
  private readonly marker = new Group();
  private readonly marker2 = new Group();
  private readonly floor: Mesh;
  private readonly key: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private dirty = true;
  private readonly pose: HandPose = { wrist: new Matrix4(), angles: new Float32Array(0) };
  private from: HandPose | null = null;
  private to: HandPose | null = null;
  private tweenStart = 0;
  private tweenMs = 0;
  private readonly css: CSSStyleDeclaration;
  private preview: Object3D | null = null;
  private pins: { el: HTMLElement; position: Vector3 }[] = [];
  private camTween: { fromPos: Vector3; toPos: Vector3; fromTarget: Vector3; toTarget: Vector3; start: number; ms: number } | null = null;

  constructor(private readonly host: HTMLElement) {
    this.css = getComputedStyle(document.documentElement);
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.hemi = new HemisphereLight(0xffffff, 0x8c95a3, 0.7);
    this.key = new DirectionalLight(0xffffff, 1.7);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.hemi, this.key, this.key.target);

    this.floor = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.16 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.overlay.renderOrder = 10;
    this.scene.add(this.overlay);
    this.stage.matrixAutoUpdate = false;
    this.scene.add(this.stage);
    this.buildMarker();
    this.buildMarker(this.marker2, 0xff9a3c);

    this.camera.position.set(0.35, 0.22, 0.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());

    // a drag handle for placing the hand when posing a character's arm
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.7);
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = !!(e as unknown as { value: boolean }).value;
      this.controls.enabled = !this.dragging;
      if (!this.dragging) this.onHoldDrop?.(this.gizmoProxy.position.clone());
    });
    this.gizmo.addEventListener('objectChange', () => this.onHoldMove?.(this.gizmoProxy.position.clone()));
    this.gizmo.enabled = false;
    this.scene.add(this.gizmoProxy);
    const helper = this.gizmo.getHelper();
    helper.visible = false;
    this.scene.add(helper);

    this.bindPicking();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.rebuildOverlays();
      this.invalidate();
    });
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      this.tick(now);
    };
    requestAnimationFrame(loop);
  }

  private color(name: string): Color {
    return new Color(this.css.getPropertyValue(name).trim() || '#888888');
  }

  private fingerColor(index: number): Color {
    const f = this.hand?.model.fingers[index];
    if (!f) return this.color('--palm');
    return this.color(FINGER_VARS[f.name] ?? FALLBACK_VARS[index % FALLBACK_VARS.length]);
  }

  invalidate() {
    this.dirty = true;
  }

  /** Turns dragging the view round on or off (off while test mode uses the mouse to aim). */
  setOrbit(on: boolean) {
    this.controls.enabled = on && !this.dragging;
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private tick(now: number) {
    if (this.to && this.from && this.hand) {
      const t = this.tweenMs > 0 ? Math.min(1, (now - this.tweenStart) / this.tweenMs) : 1;
      const e = t * t * (3 - 2 * t);
      mixPose(this.from, this.to, e, this.pose);
      setHandPose(this.hand, this.pose);
      this.updateOverlays();
      if (t >= 1) this.from = this.to = null;
      this.dirty = true;
    }
    if (this.camTween) {
      const c = this.camTween;
      const t = Math.min(1, (now - c.start) / c.ms);
      const e = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(c.fromPos, c.toPos, e);
      this.controls.target.lerpVectors(c.fromTarget, c.toTarget, e);
      if (t >= 1) this.camTween = null;
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.placePins();
  }

  /**
   * Shows a model on its own with labelled pins on it (used to ask which hand
   * of a character to take). Pass null to clear.
   */
  setPreview(object: Object3D | null, pins: { position: Vector3; label: string; onPick: () => void }[] = []) {
    if (this.preview) this.scene.remove(this.preview);
    for (const p of this.pins) p.el.remove();
    this.pins = [];
    this.preview = object;
    if (object) {
      this.scene.add(object);
      for (const p of pins) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'pin';
        el.textContent = p.label;
        el.addEventListener('click', p.onPick);
        this.host.parentElement?.appendChild(el);
        this.pins.push({ el, position: p.position.clone() });
      }
      this.frameBox(new Box3().setFromObject(object));
    }
    this.invalidate();
  }

  private placePins() {
    if (!this.pins.length) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new Vector3();
    for (const p of this.pins) {
      v.copy(p.position).project(this.camera);
      p.el.style.left = `${((v.x + 1) / 2) * w}px`;
      p.el.style.top = `${((1 - v.y) / 2) * h}px`;
      p.el.hidden = v.z > 1;
    }
  }

  // ----- content -----

  setHand(hand: RiggedHand | null) {
    if (this.hand) this.scene.remove(this.hand.root);
    this.hand = hand;
    this.from = this.to = null;
    if (hand) {
      this.scene.add(hand.root);
      this.pose.angles = new Float32Array(hand.model.dofCount);
      this.pose.wrist.identity();
      setHandPose(hand, this.pose);
    }
    this.rebuildOverlays();
    this.applyWeightsView();
    this.invalidate();
  }

  setObject(object: Object3D | null) {
    if (this.object) this.stage.remove(this.object);
    this.object = object;
    if (object) {
      object.traverse((o) => {
        if ((o as Mesh).isMesh) o.castShadow = true;
      });
      this.stage.add(object);
    }
    this.invalidate();
  }

  /** The original model with its own skeleton, shown instead of the cut-off hand in character view. */
  setCharacter(root: Object3D | null) {
    if (this.character) this.scene.remove(this.character);
    if (this.characterBones) {
      this.scene.remove(this.characterBones);
      this.characterBones.dispose();
      this.characterBones = null;
    }
    this.character = root;
    this.characterArms = [];
    if (root) {
      root.visible = false;
      this.scene.add(root);
      // Every bone the skin is bound to, so a twisted wrist shows whether the bone or the weighting is at fault.
      let skinned = false;
      root.traverse((o) => { if ((o as { isBone?: boolean }).isBone) skinned = true; });
      if (skinned) {
        const helper = new SkeletonHelper(root);
        const mat = helper.material as LineBasicMaterial;
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.transparent = true;
        helper.renderOrder = 14;
        helper.frustumCulled = false;
        helper.visible = false;
        this.characterBones = helper;
        this.scene.add(helper);
      }
    }
    this.setCharacterView(false);
  }

  /**
   * Character view: hide the separate hand, show the whole character, and move
   * the object (with its marks) by `stageMatrix` so it sits in the character's hand.
   */
  setCharacterView(on: boolean, stageMatrix?: Matrix4) {
    this.characterView = on && !!this.character;
    if (this.characterView && stageMatrix) this.stage.matrix.copy(stageMatrix);
    else this.stage.matrix.identity();
    this.stage.updateMatrixWorld(true);
    this.applyCharacterWeights();
    this.applyVisibility();
    this.invalidate();
  }

  /** Moves the hand to a pose, gliding there unless `ms` is 0. */
  setPose(pose: HandPose, ms = 420) {
    if (!this.hand) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ms <= 0 || reduce) {
      this.pose.wrist.copy(pose.wrist);
      this.pose.angles.set(pose.angles);
      setHandPose(this.hand, this.pose);
      this.from = this.to = null;
      this.updateOverlays();
      this.invalidate();
      return;
    }
    this.from = { wrist: this.pose.wrist.clone(), angles: this.pose.angles.slice() };
    this.to = { wrist: pose.wrist.clone(), angles: pose.angles.slice() };
    this.tweenStart = performance.now();
    this.tweenMs = ms;
  }

  currentPose(): HandPose {
    return { wrist: this.pose.wrist.clone(), angles: this.pose.angles.slice() };
  }

  setContacts(contacts: Contact[]) {
    this.contacts = contacts;
    this.rebuildContacts();
    this.invalidate();
  }

  /** Makes joints clickable for bone editing (null to stop). The click lands on whichever joint is nearest on screen. */
  setJointHandles(points: Vector3[] | null, onPick?: (index: number) => void) {
    this.jointPoints = points;
    this.onJointPick = onPick;
  }

  setObjectVisible(visible: boolean) {
    this.stage.visible = visible;
    this.invalidate();
  }

  /** The arms the whole-body weights view colours (see skinCheck.followColours). */
  setCharacterArms(arms: ArmBones[]) {
    this.characterArms = arms;
    this.applyWeightsView();
    this.invalidate();
  }

  /**
   * In character view, Weights colours every mesh of the character by how much it follows a hand: red the hand, blue the forearm.
   * A red cuff turns with the wrist; that is what Rig Doctor's --cuff step takes away.
   */
  private applyCharacterWeights() {
    const root = this.character;
    if (!root) return;
    const on = this.view.weights && this.characterView && this.characterArms.length > 0;
    if (on && !this.weightMaterial) this.weightMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    root.traverse((o) => {
      const mesh = o as SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const g = mesh.geometry;
      if (on) {
        if (mesh.userData.plainMaterial === undefined) {
          mesh.userData.plainMaterial = mesh.material;
          mesh.userData.plainColor = g.getAttribute('color') ?? null;
        }
        g.setAttribute('color', new BufferAttribute(followColours(mesh, this.characterArms), 3));
        mesh.material = this.weightMaterial!;
      } else if (mesh.userData.plainMaterial !== undefined) {
        mesh.material = mesh.userData.plainMaterial;
        if (mesh.userData.plainColor) g.setAttribute('color', mesh.userData.plainColor);
        else g.deleteAttribute('color');
        delete mesh.userData.plainMaterial;
        delete mesh.userData.plainColor;
      }
    });
  }

  /** Swaps the hand's materials for one that shows, in colour, which bone each vertex follows. */
  private applyWeightsView() {
    this.applyCharacterWeights();
    const hand = this.hand;
    if (!hand) return;
    const on = this.view.weights;
    if (on && !this.weightMaterial) this.weightMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    // one colour per bone: the finger's colour, lighter towards the tip
    const model = hand.model;
    const boneColor = model.joints.map(() => this.color('--palm'));
    const white = new Color(0xffffff);
    model.fingers.forEach((f, fi) => f.joints.forEach((j, k) => (boneColor[j] = this.fingerColor(fi).lerp(white, k * 0.3))));
    for (const mesh of hand.meshes) {
      const g = mesh.geometry;
      if (on) {
        if (mesh.userData.plainMaterial === undefined) {
          mesh.userData.plainMaterial = mesh.material;
          mesh.userData.plainColor = g.getAttribute('color') ?? null;
        }
        const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
        const colors = new Float32Array(si.count * 3);
        for (let i = 0; i < si.count; i++) {
          let r = 0, gg = 0, b = 0;
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k);
            if (w <= 0) continue;
            const c = boneColor[si.getComponent(i, k)];
            r += c.r * w;
            gg += c.g * w;
            b += c.b * w;
          }
          colors[i * 3] = r;
          colors[i * 3 + 1] = gg;
          colors[i * 3 + 2] = b;
        }
        g.setAttribute('color', new BufferAttribute(colors, 3));
        mesh.material = this.weightMaterial!;
      } else if (mesh.userData.plainMaterial !== undefined) {
        mesh.material = mesh.userData.plainMaterial;
        if (mesh.userData.plainColor) g.setAttribute('color', mesh.userData.plainColor);
        else g.deleteAttribute('color');
        delete mesh.userData.plainMaterial;
        delete mesh.userData.plainColor;
      }
    }
  }

  setView(view: Partial<ViewOptions>) {
    Object.assign(this.view, view);
    this.applyWeightsView();
    this.applyVisibility();
    this.updateOverlays();
    this.invalidate();
  }

  /** Shows (or hides, with null) the drag handle for the hand, and reports where it is dragged to. */
  setHoldGizmo(position: Vector3 | null, onMove?: (position: Vector3) => void, onDrop?: (position: Vector3) => void) {
    this.onHoldMove = onMove;
    this.onHoldDrop = onDrop;
    const helper = this.gizmo.getHelper();
    if (!position) {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      helper.visible = false;
    } else {
      if (!this.dragging) this.gizmoProxy.position.copy(position);
      this.gizmo.attach(this.gizmoProxy);
      this.gizmo.enabled = true;
      helper.visible = true;
    }
    this.invalidate();
  }

  /** A pale sphere showing how far an arm can reach from its shoulder. */
  setReachGuide(center: Vector3 | null, radius = 0) {
    if (!center) {
      if (this.reachGuide) this.reachGuide.visible = false;
    } else {
      if (!this.reachGuide) {
        this.reachGuide = new Mesh(
          new SphereGeometry(1, 28, 18),
          new MeshBasicMaterial({ color: this.color('--ink'), wireframe: true, transparent: true, opacity: 0.09, depthWrite: false }),
        );
        this.scene.add(this.reachGuide);
      }
      this.reachGuide.visible = true;
      this.reachGuide.position.copy(center);
      this.reachGuide.scale.setScalar(radius);
    }
    this.invalidate();
  }

  /** A line showing the path the wrist follows along a sweep. */
  setArcGuide(points: Vector3[] | null) {
    if (this.arcGuide) {
      this.scene.remove(this.arcGuide);
      this.arcGuide.geometry.dispose();
      this.arcGuide = null;
    }
    if (points && points.length > 1) {
      this.arcGuide = new Line(
        new BufferGeometry().setFromPoints(points),
        new LineBasicMaterial({ color: this.color('--thumb'), depthTest: false, transparent: true }),
      );
      this.arcGuide.renderOrder = 30;
      this.arcGuide.frustumCulled = false;
      this.scene.add(this.arcGuide);
    }
    this.invalidate();
  }

  /** The transform currently applied to the object and its marks (identity unless a character holds it). */
  stageMatrix(): Matrix4 {
    return this.stage.matrix.clone();
  }

  setMarker(point: Vector3 | null, normal?: Vector3) {
    this.placeMarker(this.marker, point, normal);
  }

  /** The second hand's grip point (two-handed grips). */
  setMarker2(point: Vector3 | null, normal?: Vector3) {
    this.placeMarker(this.marker2, point, normal);
  }

  private placeMarker(marker: Group, point: Vector3 | null, normal?: Vector3) {
    marker.visible = !!point;
    if (point && normal) {
      const size = (this.hand?.model.size ?? 0.19) * 0.085;
      marker.position.copy(point);
      marker.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal.clone().normalize());
      marker.scale.setScalar(size);
    }
    this.invalidate();
  }

  private buildMarker(marker = this.marker, color = 0xffffff) {
    const ring = new Mesh(
      new TorusGeometry(1, 0.16, 12, 40),
      new MeshBasicMaterial({ color, depthTest: false, transparent: true }),
    );
    const edge = new Mesh(
      new TorusGeometry(1, 0.3, 12, 40),
      new MeshBasicMaterial({ color: 0x152030, depthTest: false, transparent: true, opacity: 0.85 }),
    );
    const dot = new Mesh(new SphereGeometry(0.32, 16, 12), new MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    edge.renderOrder = 20;
    ring.renderOrder = 21;
    dot.renderOrder = 21;
    marker.add(edge, ring, dot);
    marker.visible = false;
    this.stage.add(marker);
  }

  // ----- overlays -----

  private rebuildOverlays() {
    for (const o of [this.fit, this.boneLines, this.jointDots]) {
      if (!o) continue;
      this.overlay.remove(o);
      o.geometry.dispose();
    }
    this.fit = this.boneLines = this.jointDots = null;
    const hand = this.hand;
    if (hand) {
      const model = hand.model;
      // the spheres the bones were inflated to: what the solver thinks the hand's volume is
      const fit = new InstancedMesh(
        new SphereGeometry(1, 20, 14),
        new MeshStandardMaterial({ roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false }),
        model.spheres.length,
      );
      fit.instanceMatrix.setUsage(DynamicDrawUsage);
      model.spheres.forEach((s, i) => fit.setColorAt(i, s.finger < 0 ? this.color('--palm') : this.fingerColor(s.finger)));
      fit.frustumCulled = false;
      this.fit = fit;

      const segs = model.joints.length - 1 + model.fingers.length;
      const lineGeo = new BufferGeometry();
      lineGeo.setAttribute('position', new BufferAttribute(new Float32Array(segs * 6), 3).setUsage(DynamicDrawUsage));
      lineGeo.setAttribute('color', new BufferAttribute(new Float32Array(segs * 6), 3));
      this.boneLines = new LineSegments(
        lineGeo,
        new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
      );
      this.boneLines.frustumCulled = false;
      this.boneLines.renderOrder = 12;

      const dots = new InstancedMesh(
        new SphereGeometry(1, 14, 10),
        new MeshBasicMaterial({ depthTest: false, transparent: true }),
        model.joints.length + model.fingers.length,
      );
      dots.instanceMatrix.setUsage(DynamicDrawUsage);
      dots.frustumCulled = false;
      dots.renderOrder = 13;
      this.jointDots = dots;
      this.overlay.add(fit, this.boneLines, dots);
    }
    this.applyVisibility();
    this.updateOverlays();
    this.rebuildContacts();
  }

  private rebuildContacts() {
    if (this.contactDots) {
      this.stage.remove(this.contactDots);
      this.contactDots.geometry.dispose();
      this.contactDots = null;
    }
    if (!this.contacts.length) return;
    const size = (this.hand?.model.size ?? 0.19) * 0.022;
    const dots = new InstancedMesh(
      new SphereGeometry(1, 14, 10),
      new MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 }),
      this.contacts.length,
    );
    const m = new Matrix4();
    this.contacts.forEach((c, i) => {
      m.makeScale(size, size, size).setPosition(c.point);
      dots.setMatrixAt(i, m);
      dots.setColorAt(i, c.finger < 0 ? this.color('--palm') : this.fingerColor(c.finger));
    });
    dots.renderOrder = 15;
    dots.frustumCulled = false;
    dots.visible = this.view.contacts;
    this.contactDots = dots;
    this.stage.add(dots);
  }

  private applyVisibility() {
    const cv = this.characterView;
    if (this.hand) this.hand.root.visible = !cv;
    if (this.character) this.character.visible = cv;
    if (this.fit) this.fit.visible = this.view.fit && !cv;
    if (this.boneLines) this.boneLines.visible = this.view.bones && !cv;
    if (this.jointDots) this.jointDots.visible = this.view.bones && !cv;
    if (this.characterBones) this.characterBones.visible = this.view.bones && cv;
    // the whole character goes see-through with its bones on, so they read inside the arm
    if (this.character) {
      const ghost = this.view.bones && cv;
      this.character.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (mat.userData.baseOpacity === undefined) {
            mat.userData.baseOpacity = mat.opacity;
            mat.userData.baseTransparent = mat.transparent;
            mat.userData.baseDepthWrite = mat.depthWrite;
          }
          mat.transparent = ghost ? true : mat.userData.baseTransparent;
          mat.opacity = ghost ? Math.min(mat.userData.baseOpacity, 0.45) : mat.userData.baseOpacity;
          mat.depthWrite = ghost ? false : mat.userData.baseDepthWrite;
          mat.needsUpdate = true;
        }
      });
    }
    if (this.contactDots) this.contactDots.visible = this.view.contacts;
    // let the fit and bones show through the skin
    if (this.hand) {
      const ghost = this.view.fit || this.view.bones;
      for (const mesh of this.hand.meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (mat.userData.baseOpacity === undefined) {
            mat.userData.baseOpacity = mat.opacity;
            mat.userData.baseTransparent = mat.transparent;
            mat.userData.baseDepthWrite = mat.depthWrite;
          }
          mat.transparent = ghost ? true : mat.userData.baseTransparent;
          mat.opacity = ghost ? Math.min(mat.userData.baseOpacity, this.view.fit ? 0.28 : 0.55) : mat.userData.baseOpacity;
          mat.depthWrite = ghost ? false : mat.userData.baseDepthWrite;
          mat.needsUpdate = true;
        }
      }
    }
  }

  private updateOverlays() {
    const hand = this.hand;
    if (!hand) return;
    const model = hand.model;
    const m = new Matrix4(), skin = new Matrix4(), v = new Vector3();
    const skinOf = (j: number) => skin.multiplyMatrices(hand.bones[j].matrixWorld, hand.skeleton.boneInverses[j]);
    if (this.fit && this.view.fit) {
      model.spheres.forEach((s, i) => {
        m.makeScale(s.radius, s.radius, s.radius).setPosition(s.center);
        m.premultiply(skinOf(s.joint));
        this.fit!.setMatrixAt(i, m);
      });
      this.fit.instanceMatrix.needsUpdate = true;
    }
    if (this.boneLines && this.jointDots && this.view.bones) {
      const pos = this.boneLines.geometry.getAttribute('position') as BufferAttribute;
      const col = this.boneLines.geometry.getAttribute('color') as BufferAttribute;
      const dot = model.size * 0.014;
      let seg = 0, d = 0;
      const put = (a: Vector3, b: Vector3, c: Color) => {
        pos.setXYZ(seg * 2, a.x, a.y, a.z);
        pos.setXYZ(seg * 2 + 1, b.x, b.y, b.z);
        col.setXYZ(seg * 2, c.r, c.g, c.b);
        col.setXYZ(seg * 2 + 1, c.r, c.g, c.b);
        seg++;
      };
      const world = model.joints.map((j, i) => j.position.clone().applyMatrix4(skinOf(i)));
      const dotAt = (p: Vector3, c: Color) => {
        m.makeScale(dot, dot, dot).setPosition(p);
        this.jointDots!.setMatrixAt(d, m);
        this.jointDots!.setColorAt(d, c);
        d++;
      };
      dotAt(world[0], this.color('--ink'));
      model.fingers.forEach((f, fi) => {
        const c = this.fingerColor(fi);
        f.joints.forEach((j, k) => {
          put(world[k === 0 ? 0 : f.joints[k - 1]], world[j], c);
          dotAt(world[j], c);
        });
        const last = f.joints[f.joints.length - 1];
        v.copy(f.tip).applyMatrix4(skinOf(last));
        put(world[last], v, c);
        dotAt(v.clone(), c);
      });
      pos.needsUpdate = true;
      col.needsUpdate = true;
      this.jointDots.instanceMatrix.needsUpdate = true;
      if (this.jointDots.instanceColor) this.jointDots.instanceColor.needsUpdate = true;
    }
  }

  // ----- camera -----

  /** Bounding box of everything shown. */
  contentBox(): Box3 {
    const box = new Box3();
    if (this.hand && !this.characterView) for (const mesh of this.hand.meshes) {
      mesh.computeBoundingBox();
      box.union(mesh.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
    }
    if (this.character && this.characterView) box.union(new Box3().setFromObject(this.character));
    if (this.object) box.union(new Box3().setFromObject(this.object));
    if (this.preview) box.union(new Box3().setFromObject(this.preview));
    return box;
  }

  /** Frames everything, keeping the current viewing direction. */
  frame(ms = 0) {
    this.frameBox(this.contentBox(), ms);
  }

  /** Frames a box, gliding there over `ms` milliseconds. */
  frameBox(box: Box3, ms = 0) {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 1e-6);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = Math.min(1, this.camera.aspect);
    const dist = (r / Math.sin(fov / 2) / fit) * 1.05;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(0.5, 0.35, 1);
    dir.normalize();
    const target = sphere.center.clone();
    const position = sphere.center.clone().addScaledVector(dir, dist);
    this.camera.near = dist / 200;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = r * 0.15;
    this.controls.maxDistance = dist * 6;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ms > 0 && !reduce) {
      this.camTween = {
        fromPos: this.camera.position.clone(),
        toPos: position,
        fromTarget: this.controls.target.clone(),
        toTarget: target,
        start: performance.now(),
        ms,
      };
    } else {
      this.camTween = null;
      this.controls.target.copy(target);
      this.camera.position.copy(position);
    }

    // light and soft ground shadow sized to the content
    this.key.position.copy(sphere.center).add(new Vector3(0.6, 1.4, 0.9).multiplyScalar(r * 2));
    this.key.target.position.copy(sphere.center);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -r * 2.2;
    cam.right = cam.top = r * 2.2;
    cam.near = r * 0.1;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    this.floor.position.set(sphere.center.x, box.min.y - r * 0.25, sphere.center.z);
    this.floor.scale.setScalar(r * 14);
    this.invalidate();
  }

  // ----- picking -----

  private bindPicking() {
    const el = this.renderer.domElement;
    const down = new Vector2();
    const ray = new Raycaster();
    el.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      if (this.jointPoints && !this.dragging) {
        // bone editing: take the joint nearest to the click, if it is close enough
        let best = -1, bd = 22;
        this.jointPoints.forEach((p, i) => {
          const s = this.toScreen(p);
          const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        if (best >= 0) this.onJointPick?.(best);
        return;
      }
      if (!this.picking || !this.object) return;
      const rect = el.getBoundingClientRect();
      const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.object, true)[0];
      if (!hit || !hit.face) return;
      const n = hit.face.normal.clone().applyNormalMatrix(new Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      // always take the side facing the camera
      if (n.dot(ray.ray.direction) > 0) n.negate();
      this.onPick?.(hit.point.clone(), n);
    });
  }

  /** Projects a world point to CSS pixels inside the view (for tests and tooltips). */
  toScreen(p: Vector3): { x: number; y: number } {
    const v = p.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }
}

export { Quaternion };
