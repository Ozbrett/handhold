"""Rig Doctor: checks and fixes how a character's skin follows its arms, headless.

    blender --background [model.blend] --python blender/rig_doctor.py -- <check|fix> [options]

The options can also come in the RIGDOCTOR_ARGS environment variable (one string, split like a shell would), for
launchers that cannot pass a bare "--" (PowerShell eats it).

What a character's wrist goes wrong with, and what is measured for each arm (bones found by name: hand_r, mixamorig:RightHand,
RightHand, Hand.R, ...; the forearm is the hand's parent, the upper arm the forearm's):

  over_hand   geometry of a mesh that is not the hand (a sleeve, a coat) reaching past the wrist over the hand: it covers the
              grip and is dragged about by whatever the hand does
  cuff        sleeve vertices that are weighted to the hand or the fingers: the cuff twists and folds with every wrist turn
  scraps      small loose pieces of the body mesh near the arm (what is left of a scanned hand, a strap end): they float
  wrist       the wrist under a turn: the hand rolled 90 degrees about the forearm, bent 60 towards the palm and back, and 35 to
              each side. The thickness kept at the wrist (1.0 = none lost; under 0.75 it pinches like a sweet wrapper) and the
              worst stretch of an edge near the wrist
  seams       vertices that sit on top of each other but follow different bones: the skin opens there when the arm moves

Options (both commands)
  --in <file>            .fbx / .glb / .gltf / .blend to read (not needed when Blender opened a .blend)
  --report <file.json>   where to write the numbers (default: rig_doctor.json beside --in, or the .blend)
  --shots <prefix>       render a contact sheet to <prefix>_sheet.png (wrist close-ups from above and the side, at rest and
                         turned, coloured by mesh and by how much each point follows the hand)
  --side l|r|both        which arms (default both)
  --hand-meshes a,b      the meshes that are the hands (default: any mesh whose skin is mostly on hand and finger bones)

fix only (each one is a step; with none named, all of them run)
  --trim                 cut sleeve geometry that reaches past the wrist (--trim-past metres past the wrist line it may keep, 0.005)
  --scraps               delete loose scraps near the arm (--scrap-max share of the mesh one may be, 0.03)
  --cuff                 sleeve: weights off the fingers; near the wrist the hand's share fades from --cuff-follow (0.2) at the rim
                         to nothing --cuff-band metres up the forearm (0.08)
  --blend                hand mesh: the part inside the sleeve blends from forearm to hand over --blend-len metres (0.06), so
                         a turn is spread along the wrist instead of folding at one ring
  --seams                points that sit together (UV splits, the sleeve's rim on the glove) get one shared set of weights
  --twist                (only when named) a twist bone halfway down each forearm, a leaf under it, and the forearm's weights
                         handed to it more and more towards the wrist; the game turns it by --twist-share (0.5) of the hand's
                         roll, so a roll is spread along the forearm instead of wringing the wrist. The wrist roll test turns it too
  (always, last)         every vertex is kept to its 4 strongest bones, as a game skins it
  --save <file.blend>    save the fixed scene (everything in it, animations too)
  --export <file>        also export it (.fbx or .glb); FBX keeps the scene's actions, with no leaf bones

Exit code: 0 when every arm passes (over_hand 0, cuff 0, scraps 0, wrist thickness >= 0.75 everywhere), 3 when something is
left to fix, 1 on an error. The JSON has every number and a list of plain-words findings.
"""
import json
import math
import os
import re
import shlex
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.kdtree import KDTree

# ----------------------------------------------------------------------------- arguments

if '--' in sys.argv:
    ARGS = sys.argv[sys.argv.index('--') + 1:]
else:
    ARGS = shlex.split(os.environ.get('RIGDOCTOR_ARGS', ''), posix=True)
if not ARGS or ARGS[0] not in ('check', 'fix'):
    print(__doc__)
    sys.exit(1)
CMD = ARGS[0]
FLAGS = {'trim', 'scraps', 'cuff', 'blend', 'seams'}
OPT_IN = {'twist'}    # steps that change the skeleton run only when named: a game has to drive a new bone
OPT = {}
i = 1
while i < len(ARGS):
    a = ARGS[i]
    if not a.startswith('--'):
        sys.exit(f'[rig_doctor] unexpected "{a}"')
    k = a[2:]
    if k in FLAGS or k in OPT_IN:
        OPT[k] = True
        i += 1
    else:
        if i + 1 >= len(ARGS):
            sys.exit(f'[rig_doctor] {a} needs a value')
        OPT[k] = ARGS[i + 1]
        i += 2

TRIM_PAST = float(OPT.get('trim-past', 0.005))
SCRAP_MAX = float(OPT.get('scrap-max', 0.03))
CUFF_FOLLOW = float(OPT.get('cuff-follow', 0.2))
CUFF_BAND = float(OPT.get('cuff-band', 0.08))
BLEND_LEN = float(OPT.get('blend-len', 0.06))
PINCH = 0.75          # thickness kept at the wrist under a turn below which it reads as a pinch
MAX_INFLUENCES = 4    # bones a vertex may follow in a game
SEAM_GAP = 0.3       # weights of two touching points differ by more than this (summed): the seam opens
CUFF_WEIGHT = 0.05    # a sleeve vertex with more hand weight than this follows the hand
TWIST_SHARE = float(OPT.get('twist-share', 0.5))
SIDES = {'both': 'lr', 'l': 'l', 'r': 'r'}[OPT.get('side', 'both')]


def log(msg):
    print(f'[rig_doctor] {msg}', flush=True)


# ----------------------------------------------------------------------------- the scene

def load():
    src = OPT.get('in')
    if src:
        ext = os.path.splitext(src)[1].lower()
        if ext == '.blend':
            bpy.ops.wm.open_mainfile(filepath=src)
        else:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            if ext == '.fbx':
                bpy.ops.import_scene.fbx(filepath=src)
            elif ext in ('.glb', '.gltf'):
                bpy.ops.import_scene.gltf(filepath=src)
            else:
                sys.exit(f'[rig_doctor] cannot read {src}: use .fbx, .glb, .gltf or .blend')
    elif not bpy.data.filepath:
        sys.exit('[rig_doctor] no model: open a .blend or pass --in <file>')
    arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    if not arms:
        sys.exit('[rig_doctor] the model has no armature')
    # the armature that most meshes are skinned to
    def users(a):
        return sum(1 for o in bpy.context.scene.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' and m.object == a for m in o.modifiers))
    arm = max(arms, key=users)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' and m.object == arm for m in o.modifiers)]
    if not meshes:
        sys.exit('[rig_doctor] no mesh is skinned to the armature')
    return arm, meshes


def norm(name):
    return name.lower().replace('mixamorig:', '').replace('mixamorig_', '').replace(' ', '').replace('_', '').replace('.', '').replace('-', '')


def find_hand(arm, side):
    """The hand bone of one side, by the names rigs use."""
    s = side
    full = 'left' if s == 'l' else 'right'
    want = {f'hand{s}', f'{full}hand', f'hand{full}', f'{s}hand'}
    for b in arm.data.bones:
        if norm(b.name) in want:
            return b
    return None


def real_parent(b):
    """The parent, past copies that sit on the bone itself (some exporters nest one per mesh)."""
    p = b.parent
    while p is not None and (p.head_local - b.head_local).length < 1e-5:
        p = p.parent
    return p


def twist_name(fore):
    """The twist bone's name beside its forearm's: lowerarm_l -> lowerarm_twist_01_l, mixamorig:LeftForeArm -> mixamorig:LeftForeArmTwist."""
    m = re.match(r'^(.*?)([_.](?:l|r|L|R|left|right))$', fore)
    return f'{m.group(1)}_twist_01{m.group(2)}' if m else fore + 'Twist'


def subtree(b):
    out = {b.name}
    for c in b.children_recursive:
        out.add(c.name)
    return out


def pose_rest(arm):
    if arm.animation_data:
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()


def weights_of(obj):
    """Per vertex: {group name: weight}."""
    names = {g.index: g.name for g in obj.vertex_groups}
    return [{names[g.group]: g.weight for g in v.groups if g.weight > 0 and g.group in names} for v in obj.data.vertices]


def share(w, bones):
    tot = sum(w.values())
    return sum(x for n, x in w.items() if n in bones) / tot if tot > 0 else 0.0


def world_rest(obj):
    """Vertex positions in world space with the armature at rest (the mesh data, through the object's matrix)."""
    mw = obj.matrix_world
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    m = np.array(mw)
    return co @ m[:3, :3].T + m[:3, 3]


def world_posed(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world)
    return co @ m[:3, :3].T + m[:3, 3]


# ----------------------------------------------------------------------------- one arm

class Arm:
    def __init__(self, arm, side, meshes, hand_names):
        self.side = side
        self.hand = find_hand(arm, side)
        if self.hand is None:
            raise LookupError(f'no {"left" if side == "l" else "right"} hand bone')
        self.fore = real_parent(self.hand)
        self.upper = real_parent(self.fore) if self.fore else None
        if self.fore is None or self.upper is None:
            raise LookupError(f'{self.hand.name} has no forearm and upper arm above it')
        mw = arm.matrix_world
        self.wrist = mw @ self.hand.head_local
        self.elbow = mw @ self.fore.head_local
        self.shoulder = mw @ self.upper.head_local
        self.axis = (self.wrist - self.elbow).normalized()
        self.hand_bones = subtree(self.hand)
        self.arm_bones = self.hand_bones | {self.fore.name, self.upper.name}
        # how far the hand reaches past the wrist: its fingertips, from the hand meshes' own vertices
        reach = 0.0
        for o in meshes:
            if o.name not in hand_names:
                continue
            co = world_rest(o)
            ws = weights_of(o)
            for k, w in enumerate(ws):
                if share(w, self.hand_bones) > 0.5:
                    reach = max(reach, float(np.dot(co[k] - np.array(self.wrist), np.array(self.axis))))
        if reach <= 0:
            reach = max(0.12, sum((mw @ c.tail_local - mw @ c.head_local).length for c in [self.hand]) * 2.0)
        self.reach = reach
        self.fore_len = (self.wrist - self.elbow).length
        self.twist = next((c.name for c in self.fore.children if 'twist' in norm(c.name) and c.name not in self.hand_bones), None)
        self.names = (self.hand.name, self.fore.name, self.upper.name)

    def refresh(self, arm):
        """Bone references die when the armature goes through edit mode: look them up again by name."""
        bones = arm.data.bones
        self.hand, self.fore, self.upper = (bones[n] for n in self.names)

    def frame(self, co):
        """Distance along the forearm past the wrist (t) and from the forearm's line (r), for world positions."""
        d = co - np.array(self.wrist)
        a = np.array(self.axis)
        t = d @ a
        r = np.linalg.norm(d - np.outer(t, a), axis=1)
        return t, r


# ----------------------------------------------------------------------------- checks

def find_islands(obj):
    """Loose pieces of a mesh. Points that sit on each other count as joined: a scanned mesh is often split along its texture
    seams into many pieces that still form one closed surface, and those are not scraps."""
    me = obj.data
    n = len(me.vertices)
    parent = np.arange(n)

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def join(a, b):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[ra] = rb

    ev = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get('vertices', ev)
    for a, b in ev.reshape(-1, 2):
        join(int(a), int(b))
    kd = KDTree(n)
    for v in me.vertices:
        kd.insert(v.co, v.index)
    kd.balance()
    for v in me.vertices:
        for (_, j, _) in kd.find_range(v.co, 0.0005):
            if j != v.index:
                join(v.index, j)
    groups = {}
    for k in range(n):
        groups.setdefault(root(k), []).append(k)
    return list(groups.values())


def check(arm, meshes, hand_names, arms):
    pose_rest(arm)
    out = {'armature': arm.name, 'meshes': [], 'arms': [], 'findings': []}
    data = {}
    for o in meshes:
        co = world_rest(o)
        ws = weights_of(o)
        data[o.name] = (co, ws)
        out['meshes'].append({'name': o.name, 'verts': len(co), 'hand_mesh': o.name in hand_names})
    for A in arms:
        side = 'left' if A.side == 'l' else 'right'
        rep = {'side': side, 'hand': A.hand.name, 'forearm': A.fore.name, 'upper_arm': A.upper.name,
               'hand_reach_m': round(A.reach, 4)}
        over, cuff, cuff_sum = [], 0, 0.0
        scraps = []
        for o in meshes:
            co, ws = data[o.name]
            t, r = A.frame(co)
            if o.name in hand_names:
                continue
            # past the wrist and over the hand (inside the hand's own reach, not the far side of the body)
            mask = (t > TRIM_PAST) & (t < A.reach * 1.3) & (r < A.reach * 0.9)
            if mask.any():
                over.append({'mesh': o.name, 'verts': int(mask.sum()), 'furthest_cm': round(float(t[mask].max()) * 100, 1)})
            for k, w in enumerate(ws):
                if t[k] <= -A.fore_len * 0.6 or r[k] >= A.reach * 1.5:
                    continue
                s = share(w, A.hand_bones)
                fingers = s - share(w, {A.hand.name})
                # a cuff may follow the hand a little at its rim (the fix's own fade), never a finger and never more than that
                allowed = CUFF_FOLLOW * smoothstep(-CUFF_BAND, 0.0, float(t[k])) + CUFF_WEIGHT
                if fingers > CUFF_WEIGHT or s > allowed:
                    cuff += 1
                    cuff_sum += s
            for isl in find_islands(o):
                if len(isl) >= max(8, len(co) * SCRAP_MAX) or len(isl) == len(co):
                    continue
                c = co[isl].mean(axis=0)
                tc, rc = A.frame(c[None, :])
                # near this arm: between the elbow and past the fingertips, within a forearm's thickness or two of its line
                if -A.fore_len * 1.1 < tc[0] < A.reach * 1.4 and rc[0] < 0.12:
                    scraps.append({'mesh': o.name, 'verts': len(isl), 'at_cm_past_wrist': round(float(tc[0]) * 100, 1),
                                   'off_line_cm': round(float(rc[0]) * 100, 1)})
        rep['over_hand'] = over
        rep['cuff_verts'] = cuff
        rep['cuff_weight_sum'] = round(cuff_sum, 2)
        rep['scraps'] = scraps
        rep['twist_bone'] = A.twist
        rep['wrist'] = wrist_test(arm, meshes, A, data)
        out['arms'].append(rep)
        f = out['findings']
        for x in over:
            f.append(f'{side}: {x["verts"]} vertices of {x["mesh"]} reach up to {x["furthest_cm"]} cm past the wrist, over the hand')
        if cuff:
            f.append(f'{side}: {cuff} vertices of the sleeve follow the hand more than a cuff should (a finger, or the hand well up the forearm)')
        for x in scraps:
            f.append(f'{side}: a loose scrap of {x["mesh"]} ({x["verts"]} vertices) {x["at_cm_past_wrist"]} cm from the wrist')
        for name, m in rep['wrist'].items():
            if m['thickness_kept'] < PINCH:
                f.append(f'{side}: the wrist keeps {round(m["thickness_kept"] * 100)}% of its thickness when the hand is {name}: it pinches')
    over = sum(1 for o in meshes for w in data[o.name][1] if len(w) > MAX_INFLUENCES)
    out['over_influence_limit'] = over
    if over:
        out['findings'].append(f'{over} vertices follow more than {MAX_INFLUENCES} bones: a game drops the weakest, and the skin moves '
                               'differently there than in Blender')
    out['seams'] = seams(meshes, data)
    if out['seams']['split'] > 0:
        by = ', '.join(f'{k} ({v})' for k, v in out['seams']['by_bones'].items())
        out['findings'].append(f'{out["seams"]["split"]} seam points have different weights on either side, so the skin can open there: {by}')
    out['pass'] = over == 0 and all(not a['over_hand'] and a['cuff_verts'] == 0 and not a['scraps'] and
                      all(m['thickness_kept'] >= PINCH for m in a['wrist'].values()) for a in out['arms'])
    return out


TESTS = {
    'rolled 90 degrees': ('Y', 90.0),
    'rolled -90 degrees': ('Y', -90.0),
    'bent 60 degrees to the palm': ('X', 60.0),
    'bent 60 degrees back': ('X', -60.0),
    'bent 35 degrees to the thumb': ('Z', 35.0),
    'bent 35 degrees to the little finger': ('Z', -35.0),
}


def wrist_test(arm, meshes, A, data):
    """Turns the hand bone and measures the ring of skin at the wrist: how thick it stays, and the worst edge stretch."""
    pb = arm.pose.bones[A.hand.name]
    tb = arm.pose.bones[A.twist] if A.twist else None
    rings = {}
    edges = {}
    for o in meshes:
        co, _ = data[o.name]
        t, r = A.frame(co)
        ring = np.where((np.abs(t) < 0.025) & (r < A.reach * 0.8))[0]
        if len(ring) >= 6:
            rings[o.name] = ring
            near = set(np.where((np.abs(t) < 0.06) & (r < A.reach))[0].tolist())
            e = np.array([tuple(ed.vertices) for ed in o.data.edges if ed.vertices[0] in near and ed.vertices[1] in near], int)
            if len(e):
                edges[o.name] = e
    res = {}
    for name, (axis, deg) in TESTS.items():
        v = Vector((1, 0, 0)) if axis == 'X' else Vector((0, 1, 0)) if axis == 'Y' else Vector((0, 0, 1))
        pb.rotation_quaternion = Quaternion(v, math.radians(deg))
        if tb is not None and axis == 'Y':
            # as the game drives it: the twist bone (its Y also runs down the forearm) takes its share of the hand's roll, and the
            # hand, a child of the forearm and not of the twist bone, keeps its own
            tb.rotation_quaternion = Quaternion(v, math.radians(deg * TWIST_SHARE))
        bpy.context.view_layer.update()
        kept, stretch = [], 1.0
        # the forearm does not move in this test, so its line still measures the thickness
        for o in meshes:
            if o.name not in rings:
                continue
            co0, _ = data[o.name]
            co1 = world_posed(o)
            ring = rings[o.name]
            _, r0 = A.frame(co0[ring])
            _, r1 = A.frame(co1[ring])
            if r0.mean() > 1e-4:
                kept.append(float(r1.mean() / r0.mean()))
            if o.name in edges:
                e = edges[o.name]
                l0 = np.linalg.norm(co0[e[:, 0]] - co0[e[:, 1]], axis=1)
                l1 = np.linalg.norm(co1[e[:, 0]] - co1[e[:, 1]], axis=1)
                ok = l0 > 1e-5
                if ok.any():
                    ratio = l1[ok] / l0[ok]
                    stretch = max(stretch, float(ratio.max()), float(1.0 / max(ratio.min(), 1e-3)))
        res[name] = {'thickness_kept': round(min(kept) if kept else 1.0, 3), 'worst_edge_stretch': round(stretch, 2)}
        pb.rotation_quaternion = (1, 0, 0, 0)
        if tb is not None:
            tb.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.view_layer.update()
    return res


def seams(meshes, data):
    """Points of different meshes, or split points of one mesh, that sit together but follow different main bones."""
    pts, owner, wv = [], [], []
    for o in meshes:
        co, ws = data[o.name]
        for k in range(len(co)):
            w = ws[k]
            tot = sum(w.values()) or 1.0
            main = max(w, key=w.get) if w else ''
            pts.append(co[k])
            owner.append(main)
            wv.append({n: x / tot for n, x in w.items()})
    if not pts:
        return {'split': 0}
    kd = KDTree(len(pts))
    for k, p in enumerate(pts):
        kd.insert(Vector(p), k)
    kd.balance()
    split, where = 0, {}
    for k, p in enumerate(pts):
        for (_, j, d) in kd.find_range(Vector(p), 0.0005):
            if j <= k:
                continue
            a, b = wv[k], wv[j]
            # two points that sit together open apart only when their weights really differ, not when a 0.49/0.51 split flips the main bone
            if sum(abs(a.get(n, 0.0) - b.get(n, 0.0)) for n in set(a) | set(b)) > SEAM_GAP:
                split += 1
                key = ' / '.join(sorted({owner[k], owner[j]}))
                where[key] = where.get(key, 0) + 1
    return {'split': split, 'by_bones': dict(sorted(where.items(), key=lambda x: -x[1])[:8])}


# ----------------------------------------------------------------------------- fixes

def set_weights(obj, k, w):
    """Replace vertex k's weights with w ({group: weight}, normalised), making groups as needed."""
    tot = sum(w.values())
    for g in obj.vertex_groups:
        try:
            g.remove([k])
        except RuntimeError:
            pass
    for n, x in w.items():
        if x <= 1e-4:
            continue
        g = obj.vertex_groups.get(n) or obj.vertex_groups.new(name=n)
        g.add([k], x / tot, 'REPLACE')


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def delete_verts(obj, idx):
    if not len(idx):
        return 0
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    gone = [bm.verts[k] for k in sorted(set(int(x) for x in idx))]
    bmesh.ops.delete(bm, geom=gone, context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(gone)


def fix(arm, meshes, hand_names, arms, steps):
    pose_rest(arm)
    done = []
    for o in meshes:
        if o.name in hand_names:
            continue
        if 'scraps' in steps:
            co = world_rest(o)
            gone = []
            for A in arms:
                for isl in find_islands(o):
                    if len(isl) >= max(8, len(co) * SCRAP_MAX) or len(isl) == len(co):
                        continue
                    tc, rc = A.frame(co[isl].mean(axis=0)[None, :])
                    if -A.fore_len * 1.1 < tc[0] < A.reach * 1.4 and rc[0] < 0.12:
                        gone.extend(isl)
            n = delete_verts(o, gone)
            if n:
                done.append(f'{o.name}: deleted {n} vertices of loose scraps near the arms')
        if 'trim' in steps:
            co = world_rest(o)
            gone = []
            for A in arms:
                t, r = A.frame(co)
                gone.extend(np.where((t > TRIM_PAST) & (t < A.reach * 1.3) & (r < A.reach * 0.9))[0].tolist())
            n = delete_verts(o, gone)
            if n:
                done.append(f'{o.name}: cut {n} vertices reaching past the wrist')
        if 'cuff' in steps:
            co = world_rest(o)
            ws = weights_of(o)
            changed = 0
            for A in arms:
                t, r = A.frame(co)
                for k, w in enumerate(ws):
                    if not w or r[k] > A.reach * 1.5 or t[k] < -A.fore_len * 0.6:
                        continue
                    hand_w = share(w, A.hand_bones)
                    if hand_w <= 1e-4 and t[k] < -CUFF_BAND:
                        continue
                    # the hand's share fades from CUFF_FOLLOW at the rim to nothing CUFF_BAND up the forearm; fingers never pull a sleeve
                    follow = CUFF_FOLLOW * smoothstep(-CUFF_BAND, 0.0, float(t[k]))
                    rest = {n: x for n, x in w.items() if n not in A.hand_bones}
                    tot = sum(rest.values())
                    if tot <= 1e-6:
                        rest = {A.fore.name: 1.0}
                        tot = 1.0
                    nw = {n: x / tot * (1.0 - follow) for n, x in rest.items()}
                    if follow > 1e-4:
                        nw[A.hand.name] = nw.get(A.hand.name, 0.0) + follow
                    set_weights(o, k, nw)
                    ws[k] = nw
                    changed += 1
            if changed:
                done.append(f'{o.name}: sleeve weights eased off the hands ({changed} vertices)')
    if 'blend' in steps:
        for o in meshes:
            if o.name not in hand_names:
                continue
            co = world_rest(o)
            ws = weights_of(o)
            changed = 0
            for A in arms:
                t, r = A.frame(co)
                for k, w in enumerate(ws):
                    if not w or r[k] > A.reach * 0.8 or t[k] > 0.02 or t[k] < -A.fore_len * 0.8:
                        continue
                    if share(w, A.arm_bones) < 0.5:
                        continue
                    # the hand's share grows from nothing BLEND_LEN up the forearm to all of it just past the wrist
                    hand_w = smoothstep(-BLEND_LEN, 0.02, float(t[k]))
                    fingers = {n: x for n, x in w.items() if n in A.hand_bones and n != A.hand.name}
                    fsum = sum(fingers.values()) / max(sum(w.values()), 1e-6)
                    nw = {n: x for n, x in fingers.items()}
                    nw[A.hand.name] = max(0.0, hand_w - fsum)
                    nw[A.fore.name] = 1.0 - hand_w
                    set_weights(o, k, nw)
                    changed += 1
            if changed:
                done.append(f'{o.name}: wrist blended from forearm to hand ({changed} vertices)')
    if 'twist' in steps:
        done.extend(add_twist_bones(arm, meshes, arms))
    if 'seams' in steps:
        n = weld_seam_weights(meshes)
        if n:
            done.append(f'seams: {n} touching points given one shared set of weights')
    # Always last: the steps above mix weights, and a game skins with at most MAX_INFLUENCES bones a vertex (Unity, three.js and
    # glTF all keep four and drop the rest without renormalising the way the artist meant).
    n = limit_influences(meshes)
    if n:
        done.append(f'{n} vertices kept to their {MAX_INFLUENCES} strongest bones')
    return done


def add_twist_bones(arm, meshes, arms):
    """
    A twist bone from halfway down each forearm to the wrist, parented to the forearm and with nothing under it, and the
    forearm's weights handed to it from nothing just below the elbow to all of them at the wrist. At rest it changes nothing (it
    sits on the forearm's line with the forearm's own axes); turned about its length it carries the far end of the forearm round
    with the hand, so a roll is spread from the elbow to the wrist the way a real forearm's two bones spread it.
    """
    done = []
    pose_rest(arm)
    want = [A for A in arms if not A.twist]
    if want:
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        bpy.context.view_layer.objects.active = arm
        arm.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        eb = arm.data.edit_bones
        for A in want:
            fore = eb[A.names[1]]
            wrist = eb[A.names[0]].head.copy()
            b = eb.new(twist_name(A.names[1]))
            b.head = fore.head.lerp(wrist, 0.5)
            b.tail = wrist
            b.align_roll(fore.z_axis)
            b.parent = fore
            b.use_connect = False
            b.use_deform = True
            A.twist = b.name
        bpy.ops.object.mode_set(mode='OBJECT')
        for A in arms:
            A.refresh(arm)
        done.append('twist bones added: ' + ', '.join(A.twist for A in want))
    for o in meshes:
        co = world_rest(o)
        ws = weights_of(o)
        changed = 0
        for A in arms:
            t, _ = A.frame(co)
            for k, w in enumerate(ws):
                f = w.get(A.fore.name, 0.0)
                if f <= 1e-4:
                    continue
                along = 1.0 + float(t[k]) / A.fore_len          # 0 at the elbow, 1 at the wrist
                give = smoothstep(0.15, 0.95, along)
                if give <= 1e-4:
                    continue
                nw = dict(w)
                nw[A.fore.name] = f * (1.0 - give)
                nw[A.twist] = nw.get(A.twist, 0.0) + f * give
                set_weights(o, k, nw)
                ws[k] = nw
                changed += 1
        if changed:
            done.append(f'{o.name}: forearm weights spread onto the twist bones ({changed} vertices)')
    return done


def limit_influences(meshes):
    changed = 0
    for o in meshes:
        ws = weights_of(o)
        for k, w in enumerate(ws):
            if len(w) <= MAX_INFLUENCES:
                continue
            keep = dict(sorted(w.items(), key=lambda x: -x[1])[:MAX_INFLUENCES])
            set_weights(o, k, keep)
            changed += 1
    return changed


def weld_seam_weights(meshes):
    """Points that sit together (a UV split, or the sleeve's rim on the glove's) get the average of their weights, so they move as one."""
    pts, refs, wv = [], [], []
    for o in meshes:
        co = world_rest(o)
        ws = weights_of(o)
        for k in range(len(co)):
            tot = sum(ws[k].values()) or 1.0
            pts.append(co[k])
            refs.append((o, k))
            wv.append({n: x / tot for n, x in ws[k].items()})
    kd = KDTree(len(pts))
    for k, p in enumerate(pts):
        kd.insert(Vector(p), k)
    kd.balance()
    parent = list(range(len(pts)))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for k, p in enumerate(pts):
        for (_, j, _d) in kd.find_range(Vector(p), 0.0005):
            if j > k:
                a, b = wv[k], wv[j]
                if sum(abs(a.get(n, 0.0) - b.get(n, 0.0)) for n in set(a) | set(b)) > 1e-3:
                    parent[root(j)] = root(k)
    groups = {}
    for k in range(len(pts)):
        groups.setdefault(root(k), []).append(k)
    changed = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        avg = {}
        for k in members:
            for n, x in wv[k].items():
                avg[n] = avg.get(n, 0.0) + x / len(members)
        for k in members:
            o, i = refs[k]
            set_weights(o, i, avg)
            changed += 1
    return changed


# ----------------------------------------------------------------------------- pictures

SHEET_COLOURS = [(0.80, 0.36, 0.25), (0.25, 0.68, 0.38), (0.32, 0.45, 0.88), (0.88, 0.76, 0.25), (0.70, 0.40, 0.75), (0.45, 0.75, 0.80)]


def shots(arm, meshes, arms, prefix):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.render.resolution_x, sc.render.resolution_y = 420, 320
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    cam_data = bpy.data.cameras.new('rig_doctor_cam')
    cam = bpy.data.objects.new('rig_doctor_cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    # two colourings: by mesh, and by how much each point follows the hand (red all, blue none)
    saved = {o.name: list(o.data.materials) for o in meshes}
    for idx, o in enumerate(meshes):
        m = bpy.data.materials.new(f'rd_{o.name}')
        m.diffuse_color = (*SHEET_COLOURS[idx % len(SHEET_COLOURS)], 1)
        o.data.materials.clear()
        o.data.materials.append(m)
    tiles = []
    pose_rest(arm)
    states = [('rest', None), ('rolled 90', ('Y', 90.0)), ('bent 60 to the palm', ('X', 60.0)), ('bent 60 back', ('X', -60.0))]
    for A in arms:
        follow = {}
        for o in meshes:
            ws = weights_of(o)
            col = o.data.color_attributes.get('rd_follow') or o.data.color_attributes.new('rd_follow', 'FLOAT_COLOR', 'POINT')
            vals = np.zeros((len(ws), 4), np.float32)
            for k, w in enumerate(ws):
                s = share(w, A.hand_bones)
                vals[k] = (s, 0.15, 1 - s, 1)
            col.data.foreach_set('color', vals.ravel())
            o.data.color_attributes.active_color = col
            follow[o.name] = col
        pb = arm.pose.bones[A.hand.name]
        side_vec = A.axis.cross(Vector((0, 0, 1)))
        if side_vec.length < 1e-3:
            side_vec = Vector((1, 0, 0))
        side_vec.normalize()
        views = [('above', Vector((0, 0, 1))), ('side', side_vec)]
        for label, st in states:
            pb.rotation_quaternion = (1, 0, 0, 0) if st is None else Quaternion(
                Vector((1, 0, 0)) if st[0] == 'X' else Vector((0, 1, 0)), math.radians(st[1]))
            bpy.context.view_layer.update()
            for vname, vdir in views:
                for colour in ('MATERIAL', 'VERTEX'):
                    sc.display.shading.color_type = colour
                    target = A.wrist + A.axis * (A.reach * 0.3)
                    cam.location = target + vdir * (A.reach * 3.2) - A.axis * (A.reach * 0.6)
                    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
                    cam_data.lens = 50
                    path = f'{prefix}_{A.side}_{label.replace(" ", "_")}_{vname}_{colour.lower()}.png'
                    sc.render.filepath = path
                    bpy.ops.render.render(write_still=True)
                    tiles.append((A.side, label, vname, colour, path))
        pb.rotation_quaternion = (1, 0, 0, 0)
        for o in meshes:
            o.data.color_attributes.remove(follow[o.name])
    bpy.context.view_layer.update()
    for o in meshes:
        o.data.materials.clear()
        for m in saved[o.name]:
            o.data.materials.append(m)
    bpy.data.objects.remove(cam)
    sheet = compose(tiles, prefix)
    for t in tiles:
        try:
            os.remove(t[4])
        except OSError:
            pass
    return sheet


def compose(tiles, prefix):
    """One picture: a row per arm and view, a column per state, mesh colours then hand-follow colours side by side."""
    W, H = 420, 320
    rows = sorted({(t[0], t[2]) for t in tiles})
    cols = []
    for t in tiles:
        c = (t[1], t[3])
        if c not in cols:
            cols.append(c)
    sheet = np.zeros((H * len(rows), W * len(cols), 4), np.float32)
    for side, label, vname, colour, path in tiles:
        img = bpy.data.images.load(path)
        px = np.array(img.pixels[:], np.float32).reshape(img.size[1], img.size[0], 4)
        bpy.data.images.remove(img)
        r = rows.index((side, vname))
        c = cols.index((label, colour))
        # Blender's pixel rows run bottom to top; the sheet is built the same way and the first row ends up on top
        y0 = (len(rows) - 1 - r) * H
        sheet[y0:y0 + H, c * W:(c + 1) * W] = px[:H, :W]
    out = bpy.data.images.new('rig_doctor_sheet', W * len(cols), H * len(rows), alpha=True)
    out.pixels = sheet.ravel()
    path = f'{prefix}_sheet.png'
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    log(f'sheet: {path} (rows: {", ".join(f"{s} {v}" for s, v in rows)}; columns: {", ".join(f"{l} {c.lower()}" for l, c in cols)})')
    return path


# ----------------------------------------------------------------------------- main

def main():
    arm, meshes = load()
    names = OPT.get('hand-meshes')
    if names:
        hand_names = set(n.strip() for n in names.split(','))
    else:
        hand_names = set()
        hb = set()
        for s in 'lr':
            h = find_hand(arm, s)
            if h:
                hb |= subtree(h)
        for o in meshes:
            ws = weights_of(o)
            tot = sum(sum(w.values()) for w in ws)
            if tot > 0 and sum(sum(x for n, x in w.items() if n in hb) for w in ws) / tot > 0.5:
                hand_names.add(o.name)
    arms = []
    for s in SIDES:
        try:
            arms.append(Arm(arm, s, meshes, hand_names))
        except LookupError as e:
            log(f'skipped: {e}')
    if not arms:
        sys.exit('[rig_doctor] found no arm (hand > forearm > upper arm) to check')
    log(f'armature {arm.name}; hand meshes: {", ".join(sorted(hand_names)) or "none (one-piece skin)"}; '
        f'arms: {", ".join(a.hand.name for a in arms)}')

    report = {'command': CMD}
    if CMD == 'fix':
        steps = {s for s in FLAGS | OPT_IN if OPT.get(s)} or set(FLAGS)
        report['before'] = check(arm, meshes, hand_names, arms)
        report['done'] = fix(arm, meshes, hand_names, arms, steps)
        for d in report['done']:
            log(d)
        report['after'] = check(arm, meshes, hand_names, arms)
        result = report['after']
    else:
        report['result'] = check(arm, meshes, hand_names, arms)
        result = report['result']

    base = OPT.get('in') or bpy.data.filepath
    path = OPT.get('report') or os.path.join(os.path.dirname(base), 'rig_doctor.json')
    if OPT.get('shots'):
        report['sheet'] = shots(arm, meshes, arms, OPT['shots'])
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    log(f'report: {path}')
    for line in result['findings']:
        log('  ' + line)
    for a in result['arms']:
        worst = min(a['wrist'].values(), key=lambda m: m['thickness_kept'])
        log(f'  {a["side"]}: over the hand {sum(x["verts"] for x in a["over_hand"])}, cuff {a["cuff_verts"]}, scraps {len(a["scraps"])}, '
            f'wrist keeps {round(worst["thickness_kept"] * 100)}% at worst')

    if CMD == 'fix':
        if OPT.get('save'):
            pose_rest(arm)
            bpy.ops.wm.save_as_mainfile(filepath=OPT['save'], copy=True)
            log(f'saved: {OPT["save"]}')
        if OPT.get('export'):
            pose_rest(arm)
            ex = OPT['export']
            if ex.lower().endswith('.fbx'):
                bpy.ops.export_scene.fbx(filepath=ex, use_selection=False, add_leaf_bones=False, bake_anim=True,
                                         bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False)
            else:
                bpy.ops.export_scene.gltf(filepath=ex, export_format='GLB')
            log(f'exported: {ex}')
    log('PASS' if result['pass'] else 'NOT CLEAN: see the findings')
    sys.exit(0 if result['pass'] else 3)


try:
    main()
except SystemExit:
    raise
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f'[rig_doctor] error: {e}', flush=True)
    sys.exit(1)
