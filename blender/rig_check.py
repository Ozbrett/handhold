"""Rig Check: is a skinned character or creature fit to animate? Checks it against a default rig, every weight, and how its skin
holds up when each joint is turned; fixes what can be fixed in the weights. Headless, for any skeleton.

    blender --background --factory-startup --python blender/rig_check.py -- <check|fix> --in <model> [options]

The options can also come in the RIGCHECK_ARGS environment variable (one string, split like a shell would), for launchers that
cannot pass a bare "--". node scripts/rig-check.mjs is that launcher.

What is checked (each a pass, warn or fail with the measurement and the fix):

  skeleton    roles      a humanoid (found by its bone names: Mixamo, Unreal, Unity, Blender .L/.R, Rigify DEF-) has every bone a
                         default rig has: hips, spine, neck, head, and on each side the upper arm, forearm, hand, thigh, shin, foot,
                         each the child of the one before. A creature (no humanoid names) skips the roles and keeps every other check
              lengths    each humanoid limb bone is in a person's range of the body's height, and the left matches the right
              mirror     the left joints mirror the right ones across the body's middle
              aim        every bone with one child points at it (IK and a twist turn about the line it points along)
              joints     every joint that bends skin sits inside the skin, near the middle of the limb (rays from the joint out; a
                         joint --ranges turns by 0 bends none and is not checked);
                         one on an open seam between two pieces (a sleeve ending short of a glove) is a warning
  weights     unweighted a vertex that follows no bone stays behind when the body moves: the mesh tears
              sum        weights that do not add to 1 (engines differ in what they do with the rest)
              influences more than 4 bones on a vertex: game engines keep the 4 strongest and the mesh shifts
              far        a vertex weighted to a bone far from it (an arm vertex on the thigh): that bone drags it across the body.
                         Far on a bone above the vertex's own (a big body on its root) is a warning: the stress turns judge it
              spikes     a vertex whose weights are nothing like its neighbours': a spike or dent when the bone moves
              mirror     a humanoid's left side weighted like its right (only where the mesh itself is mirrored)
              orphans    vertex groups that are named for no bone (ignored by every engine)
  stress      every joint that bends skin is turned, one way at a time, each way about its X (bend), Z (side) and its length
              (roll), by as much as animation turns that joint (RANGES: a wrist rolls 90 and its twist bone takes half, a knee
              barely goes sideways; a creature's joints 60 / 40 / 20; --ranges gives a game's own). For each turn: the skin's
              thickness kept round the joint (under 0.65 it collapses like a sweet wrapper), the 99th percentile and worst 0.1%
              edge stretch near it (a step in the weights tears the outside of a bend), skin far from the joint that moves with it
              anyway (weights leaking along the body), and skin out on the turned limb that does not go round with it (left behind
              on a bone above)

Options
  --in <file>            .fbx / .glb / .gltf / .blend to read
  --report <file.json>   where to write the numbers (default: <model>.rigcheck.json beside --in)
  --kind auto|humanoid|creature   (default auto: humanoid when the names say so)
  --quick                stress only the limbs' main joints (humanoid) or the 24 most weighted joints (creature)
  --ranges <file.json>   how far the game turns each joint: {"<regex on the bone name>": [bend, side, roll], ...}; the first
                         pattern that matches a bone wins over the built-in range (e.g. {"Neck|Head": [30, 20, 20]})

fix only (each a step; with none named, all of them run), then everything is checked again
  --unweighted           a vertex that follows no bone follows its nearest bone
  --far                  weights on bones far from the vertex (not above its own bone) are taken off and the rest renormalised
  --spikes               a spike's weights become its neighbours' average (twice)
  --orphans              vertex groups named for no bone are removed
  --leaks                a joint whose turn drags skin far from it: its weight is faded out of that skin and given to the bones
                         near it that do not turn with it
  --limbs                a joint whose turn leaves skin on its limb behind: the weight that skin has on bones outside the limb is
                         faded over to the limb's own bones
  --smooth               a joint whose turn tears the skin (a hard step in the weights): the weights round it are averaged until the
                         blend is about 0.6 of the limb's radius wide each side
  --mirror               a humanoid's mirrored points (as the mirror check pairs them, in one mesh) both take the average of the two
  (always, last)         every vertex is kept to its 4 strongest bones and its weights add to 1
  --save <file.blend>    save the fixed scene
  --export <file>        also export it (.fbx or .glb); FBX keeps the scene's actions, with no leaf bones

Exit code: 0 when nothing fails (warnings allowed), 3 when something fails, 1 on an error. The JSON has every number.
"""
import json
import math
import os
import re
import shlex
import sys

import bpy
import numpy as np
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

FIX_STEPS = ('unweighted', 'far', 'spikes', 'orphans', 'leaks', 'limbs', 'smooth', 'mirror')

# a person's limb lengths as a share of their height (bone head to its child's head), wide enough for a stylised character
LENGTHS = {'upperarm': (0.11, 0.24), 'lowerarm': (0.09, 0.22), 'thigh': (0.16, 0.32), 'calf': (0.15, 0.32)}
# the stress turns, in the joint bone's own axes (Y runs along the bone): (bend, side, roll) degrees a joint is turned each way. Each
# is what animation moves that joint by, not more: a knee does not swing sideways and a spine bone does not roll a quarter turn, and a
# joint turned past its range stretches any skin. Deep Shift's own limits are inside these: the crew's wrist rolls 90 (a twist bone
# takes half), a monster's head turns 40 split over neck and head, a tail swings up to about 36, a jaw opens 30, legs bend by IK
RANGES = {
    'hips': (25, 15, 20), 'spine': (30, 20, 25), 'neck': (30, 20, 40), 'head': (30, 20, 40), 'clavicle': (20, 20, 10),
    'upperarm': (60, 40, 45), 'lowerarm': (60, 10, 20), 'hand': (60, 30, 90),
    'thigh': (60, 30, 30), 'calf': (60, 5, 10), 'foot': (30, 20, 15), 'toe': (40, 10, 10),
}
CREATURE_RANGE = (60, 40, 20)
TWIST_SHARE = 0.5


def turns_of(rng):
    b, s, r = rng
    return (('bend+', 'X', b), ('bend-', 'X', -b), ('side+', 'Z', s), ('side-', 'Z', -s), ('roll+', 'Y', r), ('roll-', 'Y', -r))
KEPT_FAIL, KEPT_WARN = 0.65, 0.75
STRETCH_MAX_FAIL, STRETCH_P99_FAIL, STRETCH_P99_WARN = 3.0, 2.0, 1.7   # a sound 60 degree bend stretches the outside 1.45x (its arc), as skin does
FAR_SHARE = 0.10        # a weight this strong counts as following the bone
FAR_BY = 0.12           # ... and is "far" when the bone is this share of the body's size farther than the nearest bone
FAR_RATIO = 2.0         # ... and this many times as far
SPIKE_L1 = 1.2          # a vertex this far (sum of weight differences) from its neighbours' average is a spike
DRAG_MOVE = 0.02        # skin moving this share of the body's size ...
DRAG_FROM = 3.0         # ... this many joint radii from every bone the turn moves is dragged
LIMB_WITHIN = 1.5       # skin this many joint radii from the turned limb's bones is on the limb, and must go round with it


def log(msg):
    print(f'[rig_check] {msg}', flush=True)


def parse(argv):
    args = argv[argv.index('--') + 1:] if '--' in argv else shlex.split(os.environ.get('RIGCHECK_ARGS', ''), posix=True)
    if not args or args[0] not in ('check', 'fix'):
        print(__doc__)
        sys.exit(1)
    opt = {'cmd': args[0]}
    i = 1
    while i < len(args):
        a = args[i]
        if not a.startswith('--'):
            sys.exit(f'[rig_check] unexpected "{a}"')
        k = a[2:]
        if k in FIX_STEPS or k == 'quick':
            opt[k] = True
            i += 1
        else:
            if i + 1 >= len(args):
                sys.exit(f'[rig_check] {a} needs a value')
            opt[k] = args[i + 1]
            i += 2
    return opt


# ----------------------------------------------------------------------------- the scene

def load(src):
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
            sys.exit(f'[rig_check] cannot read {src}: use .fbx, .glb, .gltf or .blend')
    return scene_rig()


def scene_rig():
    arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    if not arms:
        sys.exit('[rig_check] the model has no armature')

    def skinned(a):
        return [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.data.vertices) and any(m.type == 'ARMATURE' and m.object == a for m in o.modifiers)]
    arm = max(arms, key=lambda a: sum(len(o.data.vertices) for o in skinned(a)))
    meshes = skinned(arm)
    if not meshes:
        sys.exit('[rig_check] no mesh is skinned to the armature')
    return arm, meshes


def pose_rest(arm):
    if arm.animation_data:
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()


def world_co(obj, posed):
    if posed:
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get('co', co)
        ev.to_mesh_clear()
    else:
        co = np.empty(len(obj.data.vertices) * 3)
        obj.data.vertices.foreach_get('co', co)
    m = np.array(obj.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def edges_of(obj):
    e = np.empty(len(obj.data.edges) * 2, dtype=np.int64)
    obj.data.edges.foreach_get('vertices', e)
    return e.reshape(-1, 2)


# ----------------------------------------------------------------------------- names

SIDE_RE = [
    (re.compile(r'(?i)(^|[_.\-\s:])(l|left)$'), r'\1'), (re.compile(r'(?i)(^|[_.\-\s:])(r|right)$'), r'\1'),
    (re.compile(r'(?i)^(l|left)([_.\-\s])'), ''), (re.compile(r'(?i)^(r|right)([_.\-\s])'), ''),
    (re.compile(r'(?i)[_.\-\s](l|left)([_.\-\s])'), '_'), (re.compile(r'(?i)[_.\-\s](r|right)([_.\-\s])'), '_'),
]


def strip_prefix(name):
    n = name.split(':')[-1]
    n = re.sub(r'^mixamorig\d*[_.]?', '', n)
    # a short prefix only with a separator after it: "RightArm" starts with "rig", "Deform" with "def"
    n = re.sub(r'(?i)^(def|org|mch|bip0?1|bip|cc_base|rig)[_.\-\s]+', '', n)
    return n


def side_of(name):
    """'l', 'r' or '' from a bone name (hand_l, LeftHand, Hand.L, L_Hand, upperarm_twist_01_l)."""
    n = strip_prefix(name)
    if re.match(r'^Left[A-Z]', n) or re.search(r'(?i)(^|[_.\-\s])(l|left)($|[_.\-\s])', n):
        return 'l'
    if re.match(r'^Right[A-Z]', n) or re.search(r'(?i)(^|[_.\-\s])(r|right)($|[_.\-\s])', n):
        return 'r'
    return ''


def base_of(name):
    n = strip_prefix(name)
    n = re.sub(r'^(Left|Right)(?=[A-Z])', '', n)
    n = re.sub(r'\.\d{3}$', '', n)   # Blender's copy suffix: spine.001 is a spine bone
    for rx, rep in SIDE_RE:
        n = rx.sub(rep, n)
    return re.sub(r'[^a-z0-9]', '', n.lower())


ROLE_BASES = {
    'hips': {'hips', 'pelvis', 'hip', 'root_pelvis'}, 'spine': {'spine', 'spine0', 'spine00', 'spine01', 'spine1', 'torso'},
    'neck': {'neck', 'neck0', 'neck01', 'neck1'}, 'head': {'head'},
    'clavicle': {'clavicle', 'shoulder', 'collar', 'collarbone'},
    'upperarm': {'upperarm', 'arm', 'uparm', 'humerus'}, 'lowerarm': {'lowerarm', 'forearm', 'elbow', 'lowarm'},
    'hand': {'hand', 'wrist'}, 'thigh': {'thigh', 'upleg', 'upperleg', 'femur'},
    'calf': {'calf', 'shin', 'leg', 'lowerleg', 'lowleg', 'knee'}, 'foot': {'foot', 'ankle'},
}
SIDED = {'clavicle', 'upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot'}
CHAIN = (('upperarm', 'lowerarm'), ('lowerarm', 'hand'), ('thigh', 'calf'), ('calf', 'foot'))
SKIP_RE = re.compile(r'(?i)(twist|roll|ik|pole|target|end$|_end|nub|tip$|helper|socket|weapon|prop)')


def real_parent(b):
    p = b.parent
    while p is not None and (p.head_local - b.head_local).length < 1e-5:
        p = p.parent
    return p


def find_roles(arm):
    roles = {}
    for b in arm.data.bones:
        if SKIP_RE.search(b.name):
            continue
        base, side = base_of(b.name), side_of(b.name)
        for role, names in ROLE_BASES.items():
            if base in names and ((role in SIDED) == bool(side)):
                key = f'{role}_{side}' if side else role
                # the outermost bone of a name wins (a spine's first bone, not the third)
                if key not in roles or len(b.parent_recursive) < len(roles[key].parent_recursive):
                    roles[key] = b
    return roles


def mirror_name(name, names):
    for a, b in (('_l', '_r'), ('.l', '.r'), ('Left', 'Right'), ('left', 'right'), ('L_', 'R_'), ('.L', '.R'), ('_L', '_R'), ('-l', '-r')):
        for x, y in ((a, b), (b, a)):
            if x in name:
                cand = name[::-1].replace(x[::-1], y[::-1], 1)[::-1] if x.startswith(('_', '.', '-')) else name.replace(x, y, 1)
                if cand in names and cand != name:
                    return cand
    return None


# ----------------------------------------------------------------------------- the model as numbers

class Model:
    def __init__(self, arm, meshes):
        self.arm, self.meshes = arm, meshes
        pose_rest(arm)
        mw = arm.matrix_world
        self.deform = [b for b in arm.data.bones if b.use_deform]
        self.bone_names = [b.name for b in self.deform]
        self.bidx = {n: i for i, n in enumerate(self.bone_names)}
        self.head = np.array([tuple(mw @ b.head_local) for b in self.deform]).reshape(-1, 3)
        self.tail = np.array([tuple(mw @ b.tail_local) for b in self.deform]).reshape(-1, 3)
        self.co, self.W, self.edges, self.counts, self.sums, self.orphans, self._nearest = {}, {}, {}, {}, {}, {}, {}
        for o in meshes:
            self.co[o.name] = world_co(o, False)
            self.edges[o.name] = edges_of(o)
            self.read_weights(o)
        # bones that hold skin: a bone with none (a socket, a prop's handle, an end bone) is no vertex's nearest bone
        held = np.zeros(len(self.bone_names), bool)
        for o in meshes:
            held |= (self.W[o.name] > 0).any(0)
        self.holds = held if held.any() else np.ones(len(self.bone_names), bool)
        allco = np.concatenate([self.co[o.name] for o in meshes])
        lo, hi = allco.min(0), allco.max(0)
        self.height = float(hi[2] - lo[2])
        self.size = float(max(hi - lo))
        verts, polys, off = [], [], 0
        for o in meshes:
            verts.extend(map(tuple, self.co[o.name]))
            polys.extend([[off + v for v in p.vertices] for p in o.data.polygons])
            off += len(o.data.vertices)
        self.bvh = BVHTree.FromPolygons(verts, polys) if polys else None

    def read_weights(self, o):
        names = {g.index: g.name for g in o.vertex_groups}
        n = len(o.data.vertices)
        W = np.zeros((n, len(self.bone_names)), np.float32)
        counts = np.zeros(n, np.int32)
        sums = np.zeros(n, np.float32)
        orph = set()
        for v in o.data.vertices:
            for g in v.groups:
                if g.weight <= 0 or g.group not in names:
                    continue
                name = names[g.group]
                j = self.bidx.get(name)
                if j is None:
                    orph.add(name)
                    continue
                W[v.index, j] += g.weight
                counts[v.index] += 1
                sums[v.index] += g.weight
        self.W[o.name], self.counts[o.name], self.sums[o.name], self.orphans[o.name] = W, counts, sums, orph

    def seg_dist(self, co, idx=None):
        """Distance from each point to each deform bone's segment (N x B), or to the bones idx only; infinite to a bone that holds
        no skin."""
        h = self.head if idx is None else self.head[idx]
        t = self.tail if idx is None else self.tail[idx]
        holds = self.holds if idx is None else self.holds[idx]
        ab = t - h
        L2 = np.maximum((ab * ab).sum(1), 1e-12)
        out = np.empty((len(co), len(h)), np.float32)
        for k in range(0, len(co), 8192):
            p = co[k:k + 8192, None, :] - h[None]
            s = np.clip((p * ab[None]).sum(2) / L2[None], 0, 1)
            out[k:k + 8192] = np.linalg.norm(p - s[..., None] * ab[None], axis=2)
        out[:, ~holds] = np.inf
        return out

    def nearest(self, o):
        """Each vertex's nearest deform bone (by distance to the bone's segment)."""
        if o.name not in self._nearest:
            self._nearest[o.name] = self.seg_dist(self.co[o.name]).argmin(1)
        return self._nearest[o.name]

    def subtree(self, b):
        names = {b.name} | {c.name for c in b.children_recursive}
        return [self.bidx[n] for n in names if n in self.bidx]


def check(level, status, key, title, value, fix='', **extra):
    level.append({'key': key, 'title': title, 'status': status, 'value': value, 'fix': fix if status != 'pass' else '', **extra})


# ----------------------------------------------------------------------------- skeleton

def joint_radius(M, b):
    """Rays from the joint (the bone's head) out across the parent bone: whether it is inside the skin, how far off the middle,
    and the limb's radius there. None when the joint is outside."""
    if M.bvh is None:
        return None
    mw = M.arm.matrix_world
    head = mw @ b.head_local
    par = real_parent(b)
    axis = (head - mw @ par.head_local) if par else (mw @ b.tail_local - head)
    if axis.length < 1e-6:
        axis = mw @ b.tail_local - head
    axis.normalize()
    u = axis.orthogonal().normalized()
    v = axis.cross(u).normalized()
    reach = 0.35 * M.size
    along = (mw @ b.tail_local - head)
    step = 0.1 * min(along.length, (head - mw @ par.head_local).length if par else along.length)
    along = along.normalized() if along.length > 1e-9 else axis

    def ring(at):
        hits = []
        for k in range(12):
            a = 2 * math.pi * k / 12
            d = (u * math.cos(a) + v * math.sin(a)).normalized()
            loc, _, _, dist = M.bvh.ray_cast(at, d, reach)
            if loc is not None:
                hits.append((loc, dist))
        return hits
    # the joint, then a tenth of a bone either side of it (a joint near the surface still counts, off the middle). Past that, a quarter
    # of a bone: a wrist can sit on the open seam where a sleeve ends and a glove begins, covered on both sides and not at the joint
    best, at = ring(head), head
    if len(best) < 9:
        for p in (head + along * step, head - axis * step):
            hits = ring(p)
            if len(hits) > len(best):
                best, at = hits, p
    if len(best) < 9:
        # up to a quarter of each bone: forward along this one, back along its parent (a flared cuff leaves the sleeve open for a
        # few centimetres before the wrist)
        back = (head - mw @ par.head_local).length if par else step * 10
        fwd = (mw @ b.tail_local - head).length
        ahead = [h for h in (ring(head + along * fwd * f) for f in (0.1, 0.25)) if len(h) >= 9]
        behind = [h for h in (ring(head - axis * back * f) for f in (0.1, 0.25)) if len(h) >= 9]
        if ahead and behind:
            # the limb's radius from the nearer covered ring, so the joint is still turned in the stress test
            return {'inside': False, 'hits': len(best), 'gap': True, 'radius': float(np.median([h[1] for h in behind[0]]))}
        return {'inside': False, 'hits': len(best), 'gap': False}
    r = np.array([h[1] for h in best])
    radius = float(np.median(r))
    centre = np.array([tuple(h[0]) for h in best]).mean(0)
    off = float(np.linalg.norm(centre - np.array(tuple(at))))
    return {'inside': True, 'hits': len(best), 'radius': radius, 'off': off / max(radius, 1e-6)}


def skeleton_checks(M, kind, roles, ranges=None):
    """ranges: each bone's turn range; a joint turned by none (0, 0, 0) bends no skin, so where it sits is not checked."""
    ranges = ranges or {}
    out = []
    arm = M.arm
    mw = arm.matrix_world

    def P(b):
        return mw @ b.head_local
    if kind == 'humanoid':
        want = ['hips', 'spine', 'neck', 'head'] + [f'{r}_{s}' for s in 'lr' for r in ('upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot')]
        missing = [w for w in want if w not in roles]
        broken = []
        for s in 'lr':
            for a, c in CHAIN:
                A, C = roles.get(f'{a}_{s}'), roles.get(f'{c}_{s}')
                if A and C and A.name not in {x.name for x in C.parent_recursive}:
                    broken.append(f'{C.name} is not under {A.name}')
        st = 'fail' if missing or broken else 'pass'
        check(out, st, 'roles', 'Every bone a default humanoid rig has, in its place',
              'all 16' if st == 'pass' else '; '.join((['missing ' + ', '.join(missing)] if missing else []) + broken),
              'Name or add the missing bones (Mixamo, Unreal or Blender names are all read), each limb bone the child of the one before.')
        # lengths, against the height and left against right
        bad, lr = [], []
        for role, (lo, hi) in LENGTHS.items():
            child = dict(CHAIN)[role]
            ls = {}
            for s in 'lr':
                A, C = roles.get(f'{role}_{s}'), roles.get(f'{child}_{s}')
                if A and C:
                    ls[s] = (P(C) - P(A)).length / max(M.height, 1e-6)
                    if not lo <= ls[s] <= hi:
                        bad.append(f'{role}_{s} {ls[s]:.2f}')
            if len(ls) == 2 and abs(ls['l'] - ls['r']) / max(ls['l'], ls['r'], 1e-6) > 0.04:
                lr.append(f'{role} l {ls["l"]:.3f} r {ls["r"]:.3f}')
        st = 'fail' if bad else 'warn' if lr else 'pass'
        check(out, st, 'lengths', "Limb lengths in a person's range, left as long as right",
              'in range' if st == 'pass' else '; '.join(bad + lr) + ' (of the height)',
              'A joint placed off where the skin bends: move it to the crease (elbow, knee) so the bone lengths come out right.')
        # mirror: the arms' and legs' joints, across the plane half way between the upper arms
        L, R = roles.get('upperarm_l'), roles.get('upperarm_r')
        if L and R:
            n = (P(L) - P(R)).normalized()
            mid = (P(L) + P(R)) * 0.5
            worst, where = 0.0, ''
            for role in ('upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot'):
                a, b = roles.get(f'{role}_l'), roles.get(f'{role}_r')
                if a and b:
                    pa = P(a)
                    mirrored = pa - n * (2 * (pa - mid).dot(n))
                    d = (mirrored - P(b)).length / max(M.height, 1e-6)
                    if d > worst:
                        worst, where = d, role
            st = 'fail' if worst > 0.05 else 'warn' if worst > 0.02 else 'pass'
            check(out, st, 'mirror', 'Left joints mirror the right', f'worst {worst * 100:.1f}% of the height ({where})',
                  'Symmetrize the armature (Blender: Armature > Symmetrize), then put the skin back on it.')
    # aim: every bone with one child points at it
    worst, where, n_bad = 0.0, '', 0
    for b in arm.data.bones:
        kids = [c for c in b.children if (c.head_local - b.tail_local).length < 0.25 * max(b.length, 1e-6) or len(b.children) == 1]
        kids = [c for c in kids if not SKIP_RE.search(c.name)]
        if len(kids) != 1 or b.length < 1e-6 or SKIP_RE.search(b.name):
            continue
        to = kids[0].head_local - b.head_local
        if to.length < 0.2 * b.length:
            continue
        ang = math.degrees((b.tail_local - b.head_local).angle(to))
        if ang > 10:
            n_bad += 1
        if ang > worst:
            worst, where = ang, b.name
    st = 'fail' if worst > 30 else 'warn' if worst > 10 else 'pass'
    check(out, st, 'aim', 'Every bone points at its child', f'{worst:.0f} degrees off at worst ({where}); {n_bad} over 10',
          'Point the bone tails at their children (Blender: select the bones, Armature > Snap tail to child) and keep their roll.')
    # joints inside the skin, near the limb's middle
    radii, outside, offc, gaps = {}, [], [], []
    for b in M.deform:
        par = real_parent(b)
        if par is None or SKIP_RE.search(b.name) or tuple(ranges.get(b.name, (1,))) == (0, 0, 0):
            continue
        j = M.bidx[b.name]
        heavy = sum(int((M.W[o.name][:, j] > 0.2).sum()) for o in M.meshes)
        if heavy < 20:
            continue
        jr = joint_radius(M, b)
        if jr and jr.get('gap'):
            gaps.append(b.name)
            radii[b.name] = jr['radius']
            continue
        if not jr or not jr['inside']:
            outside.append(b.name)
            continue
        radii[b.name] = jr['radius']
        if jr['off'] > 0.45:
            offc.append(f'{b.name} {jr["off"] * 100:.0f}%')
    st = 'fail' if outside else 'warn' if offc or gaps else 'pass'
    check(out, st, 'joints', 'Every joint inside the skin, near the middle of the limb',
          f'{len(radii) - len(gaps)} inside' + (f'; outside: {", ".join(outside[:8])}' if outside else '')
          + (f'; in a gap between two pieces of the mesh: {", ".join(gaps[:8])}' if gaps else '')
          + (f'; off the middle: {", ".join(offc[:8])}' if offc else ''),
          'Move the joint into the limb, at the crease where the skin bends; a joint outside the skin bends it about a point in the air. '
          'A joint in a gap (a sleeve ending short of a glove) shows the gap when it bends: close it in the mesh.',
          outside=outside, off_centre=offc, gaps=gaps)
    return out, radii


# ----------------------------------------------------------------------------- weights

def neighbours_mean(W, edges, n):
    acc = np.zeros_like(W)
    deg = np.zeros(n, np.float32)
    if len(edges):
        np.add.at(acc, edges[:, 0], W[edges[:, 1]])
        np.add.at(acc, edges[:, 1], W[edges[:, 0]])
        np.add.at(deg, edges[:, 0], 1)
        np.add.at(deg, edges[:, 1], 1)
    return acc / np.maximum(deg, 1)[:, None], deg


def far_bones(M, o):
    """(vertex, bone) pairs where the bone is FAR_BY of the size farther away than the vertex's nearest bone, and at least FAR_RATIO
    times as far: skin on a big body is far from every bone, and its weight on the root beside the chest is sound."""
    d = M.seg_dist(M.co[o.name])
    near = d.min(1)
    return (d - near[:, None] > FAR_BY * M.size) & (d > FAR_RATIO * near[:, None])


def far_mask(M, o):
    """(vertex, bone) pairs weighted FAR_SHARE or more to a far bone."""
    return (M.W[o.name] >= FAR_SHARE) & far_bones(M, o)


def may_follow(M, o):
    """(vertex, bone) pairs a fix may give weight to: the bones the vertex already follows (a body riding its root keeps its root),
    and the bones not far from it. Averaging weights over the mesh is held to these, or it carries a bone's weight out to skin far
    from it, which the far check then fails and its fix takes off again, leaving the step the averaging was for."""
    return (M.W[o.name] > 0) | (~far_bones(M, o) & M.holds[None, :])


def held_to(S, ok, before):
    """Weight rows with the weight on bones a vertex may not follow dropped, adding to what they added to; a row left with none is
    the vertex's weights before (its neighbours are all on bones far from it)."""
    tot = S.sum(1, keepdims=True)
    K = S * ok
    k = K.sum(1, keepdims=True)
    return np.where(k > 1e-9, K * tot / np.maximum(k, 1e-9), before)


def ancestor_matrix(M):
    """A[i, j]: deform bone j is above deform bone i (its parent, the parent's parent ...)."""
    A = np.zeros((len(M.deform), len(M.deform)), bool)
    for i, b in enumerate(M.deform):
        for p in b.parent_recursive:
            j = M.bidx.get(p.name)
            if j is not None:
                A[i, j] = True
    return A


def spike_mask(M, o):
    W = M.W[o.name]
    tot = W.sum(1, keepdims=True)
    Wn = W / np.maximum(tot, 1e-9)
    avg, deg = neighbours_mean(Wn, M.edges[o.name], len(W))
    return (np.abs(Wn - avg).sum(1) > SPIKE_L1) & (deg >= 3) & (tot[:, 0] > 0)


def weight_checks(M, kind):
    out = []
    n_all = sum(len(M.W[o.name]) for o in M.meshes)
    unw = sum(int((M.sums[o.name] <= 1e-6).sum()) for o in M.meshes)
    check(out, 'fail' if unw else 'pass', 'unweighted', 'Every vertex follows a bone', f'{unw} of {n_all:,} follow none',
          'rig-check fix --unweighted gives each its nearest bone; better, paint them in with their neighbours.')
    off = sum(int(((np.abs(M.sums[o.name] - 1) > 0.02) & (M.sums[o.name] > 1e-6)).sum()) for o in M.meshes)
    check(out, 'warn' if off else 'pass', 'sum', 'Weights add to 1', f'{off} vertices off by more than 0.02',
          'rig-check fix normalises every vertex (Blender: Weights > Normalize All).')
    over = sum(int((M.counts[o.name] > 4).sum()) for o in M.meshes)
    check(out, 'fail' if over else 'pass', 'influences', 'At most 4 bones a vertex (what game engines blend)', f'{over} vertices have more',
          'rig-check fix keeps each vertex to its 4 strongest bones (Blender: Weights > Limit Total, 4).')
    # far weights on a bone below the nearest one or on another branch drag skin across the body when that bone turns: a fault. On a
    # bone above it (a big body riding its root) the skin only lags its own bone, and the stress turns measure whether that shows
    far, far_up, far_where = 0, 0, {}
    anc = ancestor_matrix(M)
    for o in M.meshes:
        m = far_mask(M, o)
        if not m.any():
            continue
        nearest = M.seg_dist(M.co[o.name]).argmin(1)
        up = m & anc[nearest]
        bad = m & ~up
        far += int(bad.any(1).sum())
        far_up += int((up.any(1) & ~bad.any(1)).sum())
        for j in np.where(bad.any(0))[0]:
            far_where[M.bone_names[j]] = far_where.get(M.bone_names[j], 0) + int(bad[:, j].sum())
    top = ', '.join(f'{k} {v}' for k, v in sorted(far_where.items(), key=lambda x: -x[1])[:5])
    check(out, 'fail' if far else 'warn' if far_up else 'pass', 'far', 'No vertex weighted to a bone far from it',
          f'{far} vertices' + (f' (on {top})' if top else '') + (f'; {far_up} more on a bone above their own' if far_up else ''),
          'rig-check fix --far takes those weights off; they drag skin across the body when that bone moves.', bones=far_where)
    spikes = sum(int(spike_mask(M, o).sum()) for o in M.meshes)
    check(out, 'fail' if spikes > max(5, n_all * 0.0005) else 'warn' if spikes else 'pass', 'spikes', 'Weights change smoothly from vertex to vertex',
          f'{spikes} vertices unlike their neighbours', 'rig-check fix --spikes gives each its neighbours\' average (Blender: Weights > Smooth).')
    orph = sorted(set().union(*[M.orphans[o.name] for o in M.meshes]))
    check(out, 'warn' if orph else 'pass', 'orphans', 'Every vertex group is a bone', f'{len(orph)} are not' + (f': {", ".join(orph[:6])}' if orph else ''),
          'rig-check fix --orphans removes them.')
    if kind == 'humanoid':
        out.append(weight_mirror(M))
    return out


def mirror_plane(M):
    """Each bone's other side (itself for a middle bone) and the mirror plane's x. The plane is the skeleton's middle along x (the
    body is imported standing with its sides along x): the heads of the bones with no other side. The skin's own median is not: a
    pouch, a holster or a sleeve on one side moves it off the middle, and every point is then compared with a point beside its true
    twin."""
    names = set(M.bone_names)
    swap = np.arange(len(M.bone_names))
    for i, n in enumerate(M.bone_names):
        m = mirror_name(n, names)
        if m:
            swap[i] = M.bidx[m]
    centre = [i for i in range(len(M.bone_names)) if swap[i] == i]
    allco = np.concatenate([M.co[o.name] for o in M.meshes])
    mid = float(np.median(M.head[centre, 0])) if centre and len(centre) < len(M.bone_names) else float(np.median(allco[:, 0]))
    return swap, mid


def weight_mirror(M):
    swap, mid = mirror_plane(M)
    worst, matched, differ = 0.0, 0, 0
    allco = np.concatenate([M.co[o.name] for o in M.meshes])
    allW = np.concatenate([M.W[o.name] for o in M.meshes])
    kd = KDTree(len(allco))
    for i, p in enumerate(allco):
        kd.insert(p, i)
    kd.balance()
    tol = 0.004 * M.size
    step = max(1, len(allco) // 6000)
    for i in range(0, len(allco), step):
        p = allco[i]
        if p[0] - mid < 0.02 * M.size:
            continue
        q = (2 * mid - p[0], p[1], p[2])
        _, j, d = kd.find(q)
        if d is None or d > tol:
            continue
        matched += 1
        diff = float(np.abs(allW[i] - allW[j][swap]).sum())
        if diff > 0.3:
            differ += 1
        worst = max(worst, diff)
    share = differ / max(matched, 1)
    st = 'pass' if matched < 50 or share < 0.03 else 'warn' if share < 0.15 else 'fail'
    value = f'{share * 100:.0f}% of {matched} mirrored points weighted unlike their other side' if matched >= 50 else 'the mesh is not mirrored: not compared'
    return {'key': 'mirror_weights', 'title': 'The left weighted like the right', 'status': st, 'value': value,
            'fix': '' if st == 'pass' else 'rig-check fix --mirror gives each mirrored pair the average of the two (Blender: Weights > Mirror from the better side).'}


# ----------------------------------------------------------------------------- stress

def stress_joints(M, kind, roles, radii, quick):
    cand = [b for b in M.deform if b.name in radii]
    if quick:
        if kind == 'humanoid':
            keys = [f'{r}_{s}' for s in 'lr' for r in ('upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot')] + ['spine', 'neck', 'head']
            names = {roles[k].name for k in keys if k in roles}
            cand = [b for b in cand if b.name in names]
        else:
            w = {b.name: sum(float(M.W[o.name][:, M.bidx[b.name]].sum()) for o in M.meshes) for b in cand}
            cand = sorted(cand, key=lambda b: -w[b.name])[:24]
    elif kind == 'humanoid':
        # fingers are their own small joints: their holds are measured by Handhold, not by turning them here
        hands = [roles[k] for k in ('hand_l', 'hand_r') if k in roles]
        under = set()
        for h in hands:
            under |= {c.name for c in h.children_recursive}
        cand = [b for b in cand if b.name not in under]
    return cand


def joint_ranges(M, kind, roles, given=None):
    """Each bone's turn range: the game's own (given: a dict, or a JSON file, of bone-name regex to [bend, side, roll]) first, then
    its humanoid role's, the role of the nearest named bone above it for the bones between (spine_02 is a spine, a ball or toe under
    the foot is a toe), and the creature range on a creature."""
    if isinstance(given, str):
        with open(given, encoding='utf-8') as f:
            given = json.load(f)
    pats = [(re.compile(k), tuple(float(x) for x in v)) for k, v in (given or {}).items()]
    out = {}
    for b in M.deform:
        for rx, rng in pats:
            if rx.search(b.name):
                out[b.name] = rng
                break
    if kind != 'humanoid':
        return out
    named = {}
    for key, b in roles.items():
        named[b.name] = key.rsplit('_', 1)[0] if key[-2:] in ('_l', '_r') else key
    for b in M.deform:
        if b.name in out:
            continue
        p, role = b, None
        while p is not None and role is None:
            role = named.get(p.name)
            p = p.parent
        if role == 'foot' and b.name not in named:
            role = 'toe'
        out[b.name] = RANGES.get(role, CREATURE_RANGE)
    return out


def stress(M, joints, radii, ranges=None):
    ranges = ranges or {}
    arm = M.arm
    rows = []
    rest = {o.name: M.co[o.name] for o in M.meshes}
    for b in joints:
        pb = arm.pose.bones[b.name]
        par = real_parent(b)
        twist = None
        if par is not None:
            tw = [c for c in par.children if 'twist' in c.name.lower() and c.name != b.name and not c.children]
            twist = arm.pose.bones[tw[0].name] if tw else None
        r = radii[b.name]
        head = np.array(tuple(arm.matrix_world @ b.head_local))
        moved = M.subtree(b) + ([M.bidx[twist.name]] if twist and twist.name in M.bidx else [])
        near_idx = {}
        for o in M.meshes:
            co = rest[o.name]
            dh = np.linalg.norm(co - head, axis=1)
            ring = np.where(dh < 1.6 * r)[0]
            band = set(np.where(dh < 2.5 * r)[0].tolist())
            e = M.edges[o.name]
            e = e[np.isin(e[:, 0], list(band)) & np.isin(e[:, 1], list(band))] if band else e[:0]
            dsub = M.seg_dist(co, moved).min(1) if moved else np.full(len(co), np.inf)
            far = np.where((dsub > max(DRAG_FROM * r, 0.1 * M.size)) & (dh > DRAG_FROM * r))[0]
            # skin out on the turned limb, away from the joint: it should go round with its bone. On the limb means nearest its bones
            # and within its thickness of them: body skin beside a small bone (the head round an ear) is nearest it and is not on it.
            # A twist bone's skin turns by half
            own = np.isin(M.nearest(o), [j for j in moved if not (twist and M.bone_names[j] == twist.name)])
            limb = np.where(own & (dh > DRAG_FROM * r) & (dsub <= LIMB_WITHIN * r))[0]
            near_idx[o.name] = (ring, e, far, dh, limb)
        rng = ranges.get(b.name, CREATURE_RANGE)
        row = {'bone': b.name, 'radius_cm': round(r * 100, 1), 'range': list(rng), 'turns': {}}
        for name, axis, deg in turns_of(rng):
            v = Vector((1, 0, 0)) if axis == 'X' else Vector((0, 1, 0)) if axis == 'Y' else Vector((0, 0, 1))
            pb.rotation_quaternion = Quaternion(v, math.radians(deg))
            if twist is not None and axis == 'Y':
                twist.rotation_quaternion = Quaternion(Vector((0, 1, 0)), math.radians(deg * TWIST_SHARE))
            bpy.context.view_layer.update()
            mw = arm.matrix_world
            T = mw @ (pb.matrix @ b.matrix_local.inverted()) @ mw.inverted()
            R, tr = np.array(T.to_3x3()), np.array(tuple(T.translation))
            d0s, d1s, ratios, drag, lag = [], [], [], 0, 0
            for o in M.meshes:
                ring, e, far, dh, limb = near_idx[o.name]
                if not len(ring) and not len(e) and not len(far) and not len(limb):
                    continue
                co1 = world_co(o, True)
                co0 = rest[o.name]
                if len(ring):
                    d0s.append(dh[ring])
                    # the joint itself stays where it is in every turn
                    d1s.append(np.linalg.norm(co1[ring] - head, axis=1))
                if len(e):
                    l0 = np.linalg.norm(co0[e[:, 0]] - co0[e[:, 1]], axis=1)
                    l1 = np.linalg.norm(co1[e[:, 0]] - co1[e[:, 1]], axis=1)
                    ok = l0 > 1e-6
                    ratios.append(l1[ok] / l0[ok])
                if len(far):
                    drag += int((np.linalg.norm(co1[far] - co0[far], axis=1) > DRAG_MOVE * M.size).sum())
                if len(limb):
                    want = co0[limb] @ R.T + tr
                    lag += int((np.linalg.norm(co1[limb] - want, axis=1) > DRAG_MOVE * M.size).sum())
            kept = float(np.concatenate(d1s).mean() / max(np.concatenate(d0s).mean(), 1e-9)) if d0s and sum(len(x) for x in d0s) else 1.0
            rr = np.concatenate(ratios) if ratios and sum(len(x) for x in ratios) else np.ones(1)
            # the worst 0.1% of edges, not the single worst: a mesh's sliver edges near a joint blow up on their own
            row['turns'][name] = {'kept': round(kept, 3), 'stretch_max': round(float(np.percentile(rr, 99.9)), 2),
                                  'stretch_p99': round(float(np.percentile(rr, 99)), 2), 'dragged': drag, 'left_behind': lag}
            pb.rotation_quaternion = (1, 0, 0, 0)
            if twist is not None:
                twist.rotation_quaternion = (1, 0, 0, 0)
        bpy.context.view_layer.update()
        t = row['turns'].values()
        row['kept'] = min(x['kept'] for x in t)
        row['stretch_max'] = max(x['stretch_max'] for x in t)
        row['stretch_p99'] = max(x['stretch_p99'] for x in t)
        row['dragged'] = max(x['dragged'] for x in t)
        row['left_behind'] = max(x['left_behind'] for x in t)
        fail = (row['kept'] < KEPT_FAIL or row['stretch_max'] > STRETCH_MAX_FAIL or row['stretch_p99'] > STRETCH_P99_FAIL
                or row['dragged'] > 20 or row['left_behind'] > 20)
        warn = row['kept'] < KEPT_WARN or row['stretch_p99'] > STRETCH_P99_WARN or row['dragged'] > 0 or row['left_behind'] > 0
        row['status'] = 'fail' if fail else 'warn' if warn else 'pass'
        rows.append(row)
    return rows


def stress_checks(rows):
    out = []

    def worst(key, low=False):
        if not rows:
            return None
        return (min if low else max)(rows, key=lambda r: r[key])
    if not rows:
        check(out, 'warn', 'stress', 'Joints turned', 'no joint with enough skin round it to turn')
        return out
    w = worst('kept', True)
    check(out, 'fail' if w['kept'] < KEPT_FAIL else 'warn' if w['kept'] < KEPT_WARN else 'pass', 'stress_kept',
          'The skin keeps its thickness when a joint turns', f'{w["kept"]:.2f} kept at worst ({w["bone"]}); {sum(r["kept"] < KEPT_FAIL for r in rows)} joints collapse',
          'Blend the weights across the joint over a wider band (rig-doctor --blend for wrists), or add a twist bone for a roll (rig-doctor --twist).')
    w = worst('stretch_p99')
    wm = worst('stretch_max')
    st = 'fail' if wm['stretch_max'] > STRETCH_MAX_FAIL or w['stretch_p99'] > STRETCH_P99_FAIL else 'warn' if w['stretch_p99'] > STRETCH_P99_WARN else 'pass'
    check(out, st, 'stress_stretch', 'No edge tears or stretches when a joint turns',
          f'99% of edges within {w["stretch_p99"]:.2f}x ({w["bone"]}); the worst 0.1% {wm["stretch_max"]:.2f}x ({wm["bone"]})',
          'A hard step in the weights at the joint: rig-check fix --smooth widens the blend round it (Blender: Weights > Smooth on that joint).')
    w = worst('dragged')
    check(out, 'fail' if w['dragged'] > 20 else 'warn' if w['dragged'] else 'pass', 'stress_drag', 'Skin far from a joint stays put when it turns',
          f'{w["dragged"]} vertices dragged at worst ({w["bone"]})', 'Take that bone\'s weight off skin far from it (rig-check fix --far).')
    w = worst('left_behind')
    check(out, 'fail' if w['left_behind'] > 20 else 'warn' if w['left_behind'] else 'pass', 'stress_lag',
          'Skin out on a limb goes round with it', f'{w["left_behind"]} vertices left behind at worst ({w["bone"]})',
          'That skin is weighted to a bone outside the limb: give it to the limb\'s own bones (rig-check fix --limbs, or paint it).')
    return out


# ----------------------------------------------------------------------------- fixes

def write_weights(o, M, rows):
    """Writes the weight rows of M.W back into the mesh's vertex groups, for the vertices listed."""
    groups = {g.name: g for g in o.vertex_groups}
    W = M.W[o.name]
    for j, name in enumerate(M.bone_names):
        col = W[rows, j]
        if not (col > 0).any() and name not in groups:
            continue
        g = groups.get(name) or o.vertex_groups.new(name=name)
        groups[name] = g
        g.remove(rows.tolist())
        for i, w in zip(rows.tolist(), col.tolist()):
            if w > 0:
                g.add([i], w, 'REPLACE')


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def stop_leaks(M, o, W, rows):
    """Skin far from a joint that moves when it turns (the drag the stress pass fails): that joint's weight, and its children's, is
    faded out of the skin from 0.6 to 1 of the distance the drag check measures from (none is left where it counts a vertex dragged),
    and given to the bones the vertex follows that do not turn with the joint (its nearest such bone when it follows none). Only joints that fail drag. Returns the vertices changed."""
    changed = np.zeros(len(W), bool)
    co = M.co[o.name]
    for row in rows:
        if row.get('dragged', 0) <= 20 or row['bone'] not in M.bidx:
            continue
        b = M.arm.data.bones[row['bone']]
        r = row['radius_cm'] / 100
        moved = M.subtree(b)
        rest = [j for j in range(len(M.bone_names)) if j not in set(moved)]
        if not moved or not rest:
            continue
        reach = max(DRAG_FROM * r, 0.1 * M.size)
        dsub = M.seg_dist(co, moved).min(1)
        keep = 1.0 - smoothstep(0.6 * reach, reach, dsub)
        on = W[:, moved].sum(1)
        hit = (keep < 1.0) & (on > 0)
        if not hit.any():
            continue
        idx = np.where(hit)[0]
        taken = W[np.ix_(idx, moved)].sum(1) * (1.0 - keep[idx])
        W[np.ix_(idx, moved)] *= keep[idx][:, None]
        # to the bones the vertex already follows that are near it (not twice as far as its nearest), in their shares: they change
        # smoothly across the skin, and a far one would only leak in turn. A vertex that follows none near it takes its nearest bone
        D = M.seg_dist(co[idx], rest)
        nearby = D <= FAR_RATIO * D.min(1, keepdims=True)
        R = W[np.ix_(idx, rest)] * nearby
        others = R.sum(1)
        has = others > 1e-6
        add = np.where(has[:, None], R / np.maximum(others, 1e-9)[:, None] * taken[:, None], 0.0)
        W[np.ix_(idx, rest)] += add
        lone = np.where(~has)[0]
        if len(lone):
            W[idx[lone], np.array(rest)[D[lone].argmin(1)]] += taken[lone]
        changed[idx] = True
    return changed


def follow_limbs(M, o, W, rows):
    """Skin out on a limb that stays behind when the limb's joint turns (the lag the stress pass fails): skin nearest the limb's
    bones and within its thickness of them, weighted to bones outside the limb. That weight is handed to the limb's bones (in the
    shares the vertex already has on them, else to its nearest), fully from 3 joint radii out and 1.5 radii of the limb's bones,
    fading to none at 2 radii out and 2.5 of the bones, so no step is left. Only joints that fail lag. Returns the vertices changed."""
    changed = np.zeros(len(W), bool)
    co = M.co[o.name]
    nearest = M.nearest(o)
    for row in rows:
        if row.get('left_behind', 0) <= 20 or row['bone'] not in M.bidx:
            continue
        b = M.arm.data.bones[row['bone']]
        r = row['radius_cm'] / 100
        moved = M.subtree(b)
        rest = [j for j in range(len(M.bone_names)) if j not in set(moved)]
        if not moved or not rest:
            continue
        head = np.array(tuple(M.arm.matrix_world @ b.head_local))
        dh = np.linalg.norm(co - head, axis=1)
        D = M.seg_dist(co, moved)
        g = smoothstep(2 * r, 3 * r, dh) * (1.0 - smoothstep(1.5 * r, 2.5 * r, D.min(1))) * np.isin(nearest, moved)
        out = W[:, rest].sum(1)
        hit = (g > 1e-4) & (out > 0)
        if not hit.any():
            continue
        idx = np.where(hit)[0]
        taken = out[idx] * g[idx]
        W[np.ix_(idx, rest)] *= (1.0 - g[idx])[:, None]
        own = W[np.ix_(idx, moved)]
        tot = own.sum(1)
        has = tot > 1e-6
        W[np.ix_(idx, moved)] += np.where(has[:, None], own / np.maximum(tot, 1e-9)[:, None] * taken[:, None], 0.0)
        lone = np.where(~has)[0]
        if len(lone):
            W[idx[lone], np.array(moved)[D[idx[lone]].argmin(1)]] += taken[lone]
        changed[idx] = True
    return changed


def mirror_weights(M, o, W):
    """Each vertex whose mirror point is within the mirror check's distance of a vertex of the same mesh, and that vertex, both take
    the average of their weights, the twin's with left and right swapped: the two sides end weighted alike where the mesh is
    mirrored, and where it is not (a pouch, a sleeve cut on one side) nothing changes. Returns the vertices changed."""
    changed = np.zeros(len(W), bool)
    swap, mid = mirror_plane(M)
    if (swap == np.arange(len(swap))).all():
        return changed
    co = M.co[o.name]
    tol = 0.004 * M.size
    kd = KDTree(len(co))
    for i, p in enumerate(co):
        kd.insert(p, i)
    kd.balance()
    pi, pj = [], []
    for i in np.where(co[:, 0] - mid > tol)[0]:
        p = co[i]
        _, j, d = kd.find((2 * mid - p[0], p[1], p[2]))
        if d is not None and d <= tol and j != i:
            pi.append(int(i))
            pj.append(int(j))
    if not pi:
        return changed
    pi, pj = np.array(pi), np.array(pj)
    A = 0.5 * (W[pi] + W[pj][:, swap])
    W[pi] = A
    W[pj] = A[:, swap]
    changed[pi] = True
    changed[pj] = True
    return changed


def smooth_joints(M, o, W, rows):
    """A hard step in the weights at a joint (the stretch the stress pass fails): the weights round it are averaged over the mesh's
    edges until the blend is about 0.6 of the limb's radius wide each side, fully within 2 radii of the joint and fading out by 3,
    each vertex keeping to the bones it may follow (may_follow). Only joints that fail stretch. Returns the vertices changed."""
    changed = np.zeros(len(W), bool)
    co = M.co[o.name]
    e = M.edges[o.name]
    if not len(e):
        return changed
    elen = np.linalg.norm(co[e[:, 0]] - co[e[:, 1]], axis=1)
    ok = may_follow(M, o)
    for row in rows:
        if row['bone'] not in M.bidx or not (row.get('stretch_p99', 0) > STRETCH_P99_FAIL or row.get('stretch_max', 0) > STRETCH_MAX_FAIL):
            continue
        b = M.arm.data.bones[row['bone']]
        r = row['radius_cm'] / 100
        head = np.array(tuple(M.arm.matrix_world @ b.head_local))
        dh = np.linalg.norm(co - head, axis=1)
        region = dh < 3 * r
        if region.sum() < 4:
            continue
        inner = region[e[:, 0]] & region[e[:, 1]]
        step = float(np.median(elen[inner])) if inner.any() else float(np.median(elen))
        rounds = int(np.clip(np.ceil(0.75 * (r / max(step, 1e-6)) ** 2), 4, 100))
        S = W.copy()
        for _ in range(rounds):
            tot = S.sum(1, keepdims=True)
            avg, deg = neighbours_mean(S / np.maximum(tot, 1e-9), e, len(S))
            mix = region & (deg > 0)
            S[mix] = held_to(0.5 * S[mix] / np.maximum(tot[mix], 1e-9) + 0.5 * avg[mix], ok[mix], S[mix])
        g = (1.0 - smoothstep(2 * r, 3 * r, dh))[:, None]
        idx = np.where(region)[0]
        W[idx] = g[idx] * S[idx] + (1 - g[idx]) * W[idx]
        changed |= region
    return changed


def keep_seams(M, before, changes):
    """Points that sit together (a split in one mesh, or the rim of one piece on another) and moved as one before the fix get the
    average of their new weights: every step works on one mesh along its edges, and two points that share no edge would otherwise
    come out weighted apart and the skin open between them. Points that were apart before are left apart. Returns the points
    changed."""
    refs, pts = [], []
    for o in M.meshes:
        for k, p in enumerate(M.co[o.name]):
            refs.append((o.name, k))
            pts.append(p)
    if len(pts) < 2:
        return 0

    def unit(w):
        t = w.sum()
        return w / t if t > 1e-9 else w
    kd = KDTree(len(pts))
    for k, p in enumerate(pts):
        kd.insert(p, k)
    kd.balance()
    parent = list(range(len(pts)))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    tol = 0.0003 * M.size
    for k, p in enumerate(pts):
        nk, ik = refs[k]
        for (_, j, _d) in kd.find_range(p, tol):
            if j <= k:
                continue
            nj, ij = refs[j]
            if np.abs(unit(before[nk][ik]) - unit(before[nj][ij])).sum() > 1e-3:
                continue
            if np.abs(unit(M.W[nk][ik]) - unit(M.W[nj][ij])).sum() > 1e-6:
                parent[root(j)] = root(k)
    groups = {}
    for k in range(len(pts)):
        groups.setdefault(root(k), []).append(k)
    n = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        avg = sum(unit(M.W[refs[k][0]][refs[k][1]]) for k in members) / len(members)
        for k in members:
            nk, ik = refs[k]
            M.W[nk][ik] = avg
            changes[nk][ik] = True
            n += 1
    return n


def fix(M, opt, rows=None, kind='humanoid'):
    """rows: the stress pass's joints (the report's 'joints'), which the leaks, limbs and smooth steps work from; without them those steps
    do nothing."""
    steps = {s for s in FIX_STEPS if opt.get(s)} or set(FIX_STEPS)
    done = {}
    rows = rows or []
    before = {o.name: M.W[o.name].copy() for o in M.meshes}
    changes = {}
    for o in M.meshes:
        W = M.W[o.name]
        changed = np.zeros(len(W), bool)
        changes[o.name] = changed
        if 'far' in steps:
            # every weight on a far bone, however small: one left behind grows past the far check's share when the rest is
            # normalised. Not on a bone above the vertex's own: that is a body riding its root
            m = (W > 0) & far_bones(M, o)
            if m.any():
                m &= ~ancestor_matrix(M)[M.seg_dist(M.co[o.name]).argmin(1)]
            W[m] = 0
            changed |= m.any(1)
            done['far'] = done.get('far', 0) + int(m.any(1).sum())
        if 'unweighted' in steps:
            z = W.sum(1) <= 1e-6
            if z.any():
                d = M.seg_dist(M.co[o.name][z])
                W[np.where(z)[0], d.argmin(1)] = 1.0
                changed |= z
                done['unweighted'] = done.get('unweighted', 0) + int(z.sum())
        if 'spikes' in steps:
            n = 0
            for _ in range(2):
                s = spike_mask(M, o)
                if not s.any():
                    break
                tot = W.sum(1, keepdims=True)
                avg, _ = neighbours_mean(W / np.maximum(tot, 1e-9), M.edges[o.name], len(W))
                W[s] = held_to(avg[s], may_follow(M, o)[s], W[s])
                changed |= s
                n += int(s.sum())
            done['spikes'] = done.get('spikes', 0) + n
        if 'leaks' in steps:
            c = stop_leaks(M, o, W, rows)
            changed |= c
            done['leaks'] = done.get('leaks', 0) + int(c.sum())
        if 'limbs' in steps:
            c = follow_limbs(M, o, W, rows)
            changed |= c
            done['limbs'] = done.get('limbs', 0) + int(c.sum())
        if 'smooth' in steps:
            c = smooth_joints(M, o, W, rows)
            changed |= c
            done['smooth'] = done.get('smooth', 0) + int(c.sum())
        if 'mirror' in steps and kind == 'humanoid':
            c = mirror_weights(M, o, W)
            changed |= c
            done['mirror'] = done.get('mirror', 0) + int(c.sum())
    n = keep_seams(M, before, changes)
    if n:
        done['seams kept'] = n
    for o in M.meshes:
        W = M.W[o.name]
        changed = changes[o.name]
        # always: the 4 strongest, adding to 1
        over = (W > 0).sum(1) > 4
        if over.any():
            idx = np.where(over)[0]
            keep = np.argsort(-W[idx], axis=1)[:, :4]
            mask = np.zeros_like(W[idx], bool)
            np.put_along_axis(mask, keep, True, axis=1)
            W[idx] = np.where(mask, W[idx], 0)
            changed |= over
            done['limited'] = done.get('limited', 0) + int(over.sum())
        tot = W.sum(1)
        off = (np.abs(tot - 1) > 1e-4) & (tot > 0)
        W[off] /= tot[off][:, None]
        changed |= off
        touched = np.where(changed)[0]
        if len(touched):
            write_weights(o, M, touched)
        if 'orphans' in steps:
            bones = set(M.arm.data.bones.keys())
            for g in list(o.vertex_groups):
                if g.name not in bones:
                    o.vertex_groups.remove(g)
                    done['orphans'] = done.get('orphans', 0) + 1
    return done


# ----------------------------------------------------------------------------- run

def detect_kind(roles, want):
    if want in ('humanoid', 'creature'):
        return want
    core = ['hips', 'head', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r']
    return 'humanoid' if sum(k in roles for k in core) >= 8 else 'creature'


def run_checks(arm, meshes, opt):
    M = Model(arm, meshes)
    roles = find_roles(arm)
    kind = detect_kind(roles, opt.get('kind', 'auto'))
    ranges = joint_ranges(M, kind, roles, opt.get('ranges'))
    skel, radii = skeleton_checks(M, kind, roles, ranges)
    weights = weight_checks(M, kind)
    joints = stress_joints(M, kind, roles, radii, bool(opt.get('quick')))
    rows = stress(M, joints, radii, ranges)
    allc = skel + weights + stress_checks(rows)
    passed = not any(c['status'] == 'fail' for c in allc)
    return M, {
        'model': opt.get('in'), 'kind': kind, 'pass': passed,
        'score': {'pass': sum(c['status'] == 'pass' for c in allc), 'warn': sum(c['status'] == 'warn' for c in allc),
                  'fail': sum(c['status'] == 'fail' for c in allc), 'of': len(allc)},
        'height_m': round(M.height, 3), 'bones': len(arm.data.bones), 'deform_bones': len(M.deform),
        'meshes': [{'name': o.name, 'vertices': len(o.data.vertices)} for o in meshes],
        'roles': {k: v.name for k, v in sorted(roles.items())},
        'skeleton': skel, 'weights': weights, 'stress': stress_checks(rows), 'joints': rows,
    }


def summary(rep):
    s = rep['score']
    log(f'{rep["kind"]}, {rep["bones"]} bones, {sum(m["vertices"] for m in rep["meshes"]):,} vertices: '
        f'{s["pass"]} pass, {s["warn"]} warn, {s["fail"]} fail of {s["of"]}')
    for c in rep['skeleton'] + rep['weights'] + rep['stress']:
        if c['status'] != 'pass':
            log(f'  {c["status"].upper():4} {c["title"]}: {c["value"]}')


def main():
    opt = parse(sys.argv)
    if not opt.get('in'):
        sys.exit('[rig_check] --in <model> is needed')
    arm, meshes = load(opt['in'])
    report = opt.get('report') or os.path.splitext(opt['in'])[0] + '.rigcheck.json'
    M, rep = run_checks(arm, meshes, opt)
    if opt['cmd'] == 'fix':
        before = rep
        done = fix(M, opt, rep['joints'], rep['kind'])
        log('fixed: ' + (', '.join(f'{k} {v}' for k, v in done.items()) or 'nothing to fix'))
        M, rep = run_checks(arm, meshes, opt)
        rep['before'] = {'score': before['score'], 'pass': before['pass']}
        rep['fixed'] = done
    summary(rep)
    with open(report, 'w', encoding='utf-8') as f:
        json.dump(rep, f, indent=1)
    log(f'report: {report}')
    if opt['cmd'] == 'fix':
        if opt.get('save'):
            bpy.ops.wm.save_as_mainfile(filepath=opt['save'], copy=True)
            log(f'saved: {opt["save"]}')
        if opt.get('export'):
            ex = opt['export']
            if ex.lower().endswith('.fbx'):
                bpy.ops.export_scene.fbx(filepath=ex, use_selection=False, add_leaf_bones=False, bake_anim=True,
                                         bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False)
            else:
                bpy.ops.export_scene.gltf(filepath=ex, export_format='GLB')
            log(f'exported: {ex}')
    log('PASS' if rep['pass'] else 'FAIL: see the findings')
    sys.exit(0 if rep['pass'] else 3)


if __name__ == '__main__':
    main()
