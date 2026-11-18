"""Rig Check's own test: a humanoid built here with smooth weights must pass, and each fault put into a copy of it must be
caught by the check that is for it (and fixed, where Rig Check fixes it). Headless:

    blender --background --factory-startup --python-exit-code 1 --python blender/test_rig_check.py

npm run test:blender runs it. Prints one line a case and exits 1 if any case is wrong.
"""
import importlib.util
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('rig_check', os.path.join(here, 'rig_check.py'))
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)

# ----------------------------------------------------------------------------- the test body

BONES = {
    'hips': ((0, 0, 1.0), (0, 0, 1.1), None), 'spine': ((0, 0, 1.1), (0, 0, 1.4), 'hips'),
    'neck': ((0, 0, 1.4), (0, 0, 1.55), 'spine'), 'head': ((0, 0, 1.55), (0, 0, 1.8), 'neck'),
}
for s, x in (('l', 1), ('r', -1)):
    BONES.update({
        f'upperarm_{s}': ((0.2 * x, 0, 1.4), (0.5 * x, 0, 1.4), 'spine'),
        f'lowerarm_{s}': ((0.5 * x, 0, 1.4), (0.76 * x, 0, 1.4), f'upperarm_{s}'),
        f'hand_{s}': ((0.76 * x, 0, 1.4), (0.86 * x, 0, 1.4), f'lowerarm_{s}'),
        f'thigh_{s}': ((0.1 * x, 0, 1.0), (0.1 * x, 0, 0.55), 'hips'),
        f'calf_{s}': ((0.1 * x, 0, 0.55), (0.1 * x, 0, 0.1), f'thigh_{s}'),
        f'foot_{s}': ((0.1 * x, 0, 0.1), (0.1 * x, -0.15, 0.02), f'calf_{s}'),
    })


def tubes():
    """Each part a tube along its bones: a polyline whose inner points are the joints, its radius at each point, and the bone
    of each span (the first span is the parent the part hangs from)."""
    out = [([(0, 0, 0.95), (0, 0, 1.1), (0, 0, 1.4), (0, 0, 1.55), (0, 0, 1.82)], [0.14, 0.14, 0.12, 0.07, 0.1], ['hips', 'spine', 'neck', 'head'])]
    for s, x in (('l', 1), ('r', -1)):
        out.append(([(0.08 * x, 0, 1.4), (0.2 * x, 0, 1.4), (0.5 * x, 0, 1.4), (0.76 * x, 0, 1.4), (0.88 * x, 0, 1.4)], [0.05, 0.05, 0.045, 0.035, 0.03],
                    ['spine', f'upperarm_{s}', f'lowerarm_{s}', f'hand_{s}']))
        out.append(([(0.1 * x, 0, 1.1), (0.1 * x, 0, 1.0), (0.1 * x, 0, 0.55), (0.1 * x, 0, 0.1), (0.1 * x, -0.17, 0.02)], [0.07, 0.07, 0.055, 0.045, 0.035],
                    ['hips', f'thigh_{s}', f'calf_{s}', f'foot_{s}']))
    return out


def tube_mesh(points, radii, step=0.015, sides=16):
    P = [Vector(p) for p in points]
    seg = [(P[i + 1] - P[i]).length for i in range(len(P) - 1)]
    total = sum(seg)
    n = max(2, int(total / step) + 1)
    verts, rings, arc = [], [], []
    for k in range(n):
        s = total * k / (n - 1)
        here_s = s
        i = 0
        while i < len(seg) - 1 and s > seg[i]:
            s -= seg[i]
            i += 1
        f = min(1.0, s / seg[i])
        c = P[i].lerp(P[i + 1], f)
        r = radii[i] + (radii[i + 1] - radii[i]) * f
        t = (P[i + 1] - P[i]).normalized()
        ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()
        v = t.cross(u).normalized()
        ring = []
        for j in range(sides):
            a = 2 * math.pi * j / sides
            ring.append(len(verts))
            verts.append(c + (u * math.cos(a) + v * math.sin(a)) * r)
            arc.append(here_s)
        rings.append(ring)
    faces = []
    for k in range(n - 1):
        for j in range(sides):
            a, b = rings[k][j], rings[k][(j + 1) % sides]
            c, d = rings[k + 1][(j + 1) % sides], rings[k + 1][j]
            faces.append((a, b, c, d))
    joints = [sum(seg[:i]) for i in range(1, len(P) - 1)]
    return verts, faces, arc, joints


def seg_d(p, h, t):
    ab = t - h
    s = max(0.0, min(1.0, (p - h).dot(ab) / max(ab.length_squared, 1e-12)))
    return (p - (h + ab * s)).length


def build(rigid=False, left_arm_shift=0.0, names=None):
    """The test body. rigid: each vertex on its nearest bone only (a hard step at every joint). left_arm_shift: the left arm,
    bones and skin, moved forward by this much (an unmirrored rig). names: bone renames (a creature, a missing bone)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    names = names or {}
    ad = bpy.data.armatures.new('rig')
    arm = bpy.data.objects.new('rig', ad)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for n, (h, t, p) in BONES.items():
        b = ad.edit_bones.new(names.get(n, n))
        off = Vector((0, -left_arm_shift, 0)) if n.endswith('arm_l') or n == 'hand_l' else Vector()
        b.head, b.tail = Vector(h) + off, Vector(t) + off
        eb[n] = b
    for n, (h, t, p) in BONES.items():
        if p:
            eb[n].parent = eb[p]
            eb[n].use_connect = (eb[p].tail - eb[n].head).length < 1e-6
    bpy.ops.object.mode_set(mode='OBJECT')
    verts, faces, weights = [], [], []
    for k, (pts, rad, bones) in enumerate(tubes()):
        if k == 1:   # the left arm's tube
            pts = [(p[0], p[1] - left_arm_shift, p[2]) for p in pts]
        v, f, arc, joints = tube_mesh(pts, rad)
        o = len(verts)
        verts += v
        faces += [tuple(i + o for i in q) for q in f]
        for s in arc:
            # each joint blends the span before it into the span after it over 1.2 of the limb's radius either side, centred on the
            # joint (a sound rig); rigid: a hard step at the joint
            j = min(range(len(joints)), key=lambda q: abs(s - joints[q]))
            width = 1.2 * rad[j + 1]
            x = (s - joints[j]) / width
            t = (1.0 if x > 0 else 0.0) if rigid else min(1.0, max(0.0, 0.5 + 0.5 * x))
            t = t * t * (3 - 2 * t)
            w = {bones[j]: 1 - t, bones[j + 1]: t}
            weights.append({n: x for n, x in w.items() if x > 1e-4})
    me = bpy.data.meshes.new('body')
    me.from_pydata([tuple(v) for v in verts], [], faces)
    body = bpy.data.objects.new('body', me)
    bpy.context.scene.collection.objects.link(body)
    groups = {n: body.vertex_groups.new(name=names.get(n, n)) for n in BONES}
    for i, w in enumerate(weights):
        for n, x in w.items():
            groups[n].add([i], x, 'REPLACE')
    mod = body.modifiers.new('arm', 'ARMATURE')
    mod.object = arm
    body.parent = arm
    bpy.context.view_layer.update()
    return arm, body


def near(body, at, count):
    co = np.array([tuple(v.co) for v in body.data.vertices])
    return np.argsort(np.linalg.norm(co - np.array(at), axis=1))[:count].tolist()


def set_w(body, i, w):
    for g in body.vertex_groups:
        g.remove([i])
    for n, x in w.items():
        g = body.vertex_groups.get(n) or body.vertex_groups.new(name=n)
        g.add([i], x, 'REPLACE')


def run(arm, body, **opt):
    _, rep = rc.run_checks(arm, [body], {'in': 'test', **opt})
    return rep


def status(rep, key):
    for c in rep['skeleton'] + rep['weights'] + rep['stress']:
        if c['key'] == key:
            return c['status']
    return 'missing'


# ----------------------------------------------------------------------------- the cases

failures = []


def expect(case, rep, key, want):
    got = status(rep, key)
    ok = got == want if isinstance(want, str) else got in want
    line = f'{"ok  " if ok else "FAIL"} {case}: {key} {got} (want {want})'
    print('[test_rig_check] ' + line, flush=True)
    if not ok:
        failures.append(line)
        c = next((c for c in rep['skeleton'] + rep['weights'] + rep['stress'] if c['key'] == key), None)
        if c:
            print('[test_rig_check]      ' + str(c['value']), flush=True)


ALL = ('roles', 'lengths', 'mirror', 'aim', 'joints', 'unweighted', 'sum', 'influences', 'far', 'spikes', 'orphans', 'mirror_weights',
       'stress_kept', 'stress_stretch', 'stress_drag', 'stress_lag')

# a sound humanoid: every check passes
arm, body = build()
rep = run(arm, body)
print(f'[test_rig_check] the sound body: {rep["kind"]}, {rep["score"]}', flush=True)
for r in rep['joints']:
    print(f'[test_rig_check]   {r["bone"]:12} kept {r["kept"]:.2f} stretch p99 {r["stretch_p99"]:.2f} max {r["stretch_max"]:.2f} dragged {r["dragged"]}', flush=True)
for k in ALL:
    expect('sound', rep, k, 'pass')
if rep['kind'] != 'humanoid':
    failures.append('sound: not read as a humanoid')

# a hard step in the weights at every joint: the outside of a bend tears
arm, body = build(rigid=True)
rep = run(arm, body)
print('[test_rig_check]   rigid: ' + ', '.join(f'{r["bone"]} p99 {r["stretch_p99"]:.2f} max {r["stretch_max"]:.2f} kept {r["kept"]:.2f}' for r in rep['joints'][:6]), flush=True)
expect('rigid weights', rep, 'stress_stretch', 'fail')
# ... and a game that only turns its joints 5 degrees never sees the tear: its own ranges are the ones turned
rep = run(arm, body, ranges={'.*': [5, 5, 5]})
expect('rigid weights, turned 5 degrees', rep, 'stress_stretch', 'pass')
if any(r['range'] != [5.0, 5.0, 5.0] for r in rep['joints']):
    failures.append('ranges: a joint was not turned by the given range')

# a hard step at every joint, smoothed: the blend is widened round each joint that tears, and nothing else starts failing
arm, body = build(rigid=True)
rep = run(arm, body)
done = rc.fix(rc.Model(arm, [body]), {'smooth': True}, rep['joints'])
rep = run(arm, body)
print('[test_rig_check]   rigid, smoothed (' + str(done.get('smooth')) + ' vertices): ' + ', '.join(f'{r["bone"]} p99 {r["stretch_p99"]:.2f} max {r["stretch_max"]:.2f}' for r in rep['joints'][:6]), flush=True)
expect('rigid weights, smoothed', rep, 'stress_stretch', ('pass', 'warn'))
for k in ('far', 'spikes', 'stress_kept', 'stress_drag', 'stress_lag'):
    expect('rigid weights, smoothed', rep, k, 'pass')

# a long coarse limb of three bones with a hard step at its first joint, and a joint radius as wide as the limb (a mound): the
# averaging reaches far down it, and must not carry the first bone's weight out to skin far from that bone
def coarse_limb():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ad = bpy.data.armatures.new('limb')
    arm = bpy.data.objects.new('limb', ad)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    prev = None
    for k in range(3):
        b = ad.edit_bones.new(f'bone_{k}')
        b.head, b.tail = Vector((k, 0, 0)), Vector((k + 1, 0, 0))
        if prev:
            b.parent, b.use_connect = prev, True
        prev = b
    bpy.ops.object.mode_set(mode='OBJECT')
    v, f, arc, _ = tube_mesh([(0, 0, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0)], [0.05] * 4, step=0.15)
    me = bpy.data.meshes.new('limb')
    me.from_pydata([tuple(p) for p in v], [], f)
    body = bpy.data.objects.new('limb', me)
    bpy.context.scene.collection.objects.link(body)
    g = [body.vertex_groups.new(name=f'bone_{k}') for k in range(3)]
    for i, s in enumerate(arc):
        g[min(2, int(s))].add([i], 1.0, 'REPLACE')
    body.modifiers.new('arm', 'ARMATURE').object = arm
    body.parent = arm
    bpy.context.view_layer.update()
    return arm, body


arm, body = coarse_limb()
expect('a coarse limb', run(arm, body), 'far', 'pass')
rc.fix(rc.Model(arm, [body]), {'smooth': True}, [{'bone': 'bone_1', 'radius_cm': 100.0, 'stretch_p99': 5.0, 'stretch_max': 9.0}])
expect('a coarse limb, smoothed wide', run(arm, body), 'far', 'pass')

# the neck's weight leaking down to the belly: the belly moves when the neck turns. --leaks alone (not --far) fades it out of the
# belly and gives it back to the bones the belly follows, with no step left behind
arm, body = build()
co = np.array([tuple(v.co) for v in body.data.vertices])
rings = np.hypot(co[:, 0], co[:, 1])
for i in range(len(co)):
    dz = abs(co[i][2] - 1.0)
    if dz < 0.1 and abs(rings[i] - 0.14) < 0.012:
        f = 0.45 * (1 - dz / 0.1) ** 2
        w = {g.group: g.weight for g in body.data.vertices[i].groups}
        names = {g.index: g.name for g in body.vertex_groups}
        set_w(body, i, {**{names[k]: x * (1 - f) for k, x in w.items()}, 'neck': f})
rep = run(arm, body)
expect('neck leaking to the belly', rep, 'stress_drag', 'fail')
done = rc.fix(rc.Model(arm, [body]), {'leaks': True}, rep['joints'])
rep = run(arm, body)
print(f'[test_rig_check]   leaks fixed on {done.get("leaks")} vertices', flush=True)
for k in ('stress_drag', 'stress_stretch', 'stress_lag', 'spikes'):
    expect('neck leaking to the belly, fixed', rep, k, 'pass')

# vertices that follow no bone
arm, body = build()
for i in near(body, (0.6, 0, 1.45), 10):
    set_w(body, i, {})
rep = run(arm, body)
expect('unweighted', rep, 'unweighted', 'fail')

# forearm skin weighted to the thigh: far, and dragged when the thigh turns
arm, body = build()
for i in near(body, (0.62, 0, 1.4), 40):
    set_w(body, i, {'lowerarm_l': 0.5, 'thigh_l': 0.5})
rep = run(arm, body)
expect('far weights', rep, 'far', 'fail')
expect('far weights', rep, 'stress_drag', 'fail')
_, rep2 = rc.run_checks(arm, [body], {'in': 'test'})
done = rc.fix(rc.Model(arm, [body]), {'far': True})
rep = run(arm, body)
expect('far weights, fixed', rep, 'far', 'pass')
expect('far weights, fixed', rep, 'stress_drag', 'pass')

# ... and with a little on the calf as well (under the far check's share): taking the thigh off must not leave the calf's share
# grown into a far weight of its own
arm, body = build()
for i in near(body, (0.62, 0, 1.4), 40):
    set_w(body, i, {'lowerarm_l': 0.2, 'thigh_l': 0.72, 'calf_l': 0.08})
rc.fix(rc.Model(arm, [body]), {'far': True})
expect('far weights and a little more, fixed', run(arm, body), 'far', 'pass')

# forearm skin weighted half to the spine, a bone above it: not dragged anywhere, but left behind when the arm turns
arm, body = build()
for i in near(body, (0.62, 0, 1.4), 40):
    set_w(body, i, {'lowerarm_l': 0.5, 'spine': 0.5})
rep = run(arm, body)
expect('forearm on the spine', rep, 'far', 'warn')
expect('forearm on the spine', rep, 'stress_lag', 'fail')
# ... handed to the forearm's own bones by --limbs, with no tear left at the edge of what was handed over
rc.fix(rc.Model(arm, [body]), {'limbs': True}, rep['joints'])
rep = run(arm, body)
expect('forearm on the spine, fixed', rep, 'stress_lag', 'pass')
expect('forearm on the spine, fixed', rep, 'stress_stretch', ('pass', 'warn'))
expect('forearm on the spine, fixed', rep, 'far', 'pass')

# single vertices on the upper arm weighted to the hand: spikes
arm, body = build()
co = np.array([tuple(v.co) for v in body.data.vertices])
on_upper = [i for i in range(len(co)) if 0.25 < co[i][0] < 0.45 and abs(co[i][2] - 1.4) < 0.06]
for i in on_upper[::9][:14]:
    set_w(body, i, {'hand_l': 1.0})
rep = run(arm, body)
expect('spikes', rep, 'spikes', 'fail')
rc.fix(rc.Model(arm, [body]), {'spikes': True})
expect('spikes, fixed', run(arm, body), 'spikes', ('pass', 'warn'))

# more than 4 bones on a vertex
arm, body = build()
for i in near(body, (0.5, 0, 1.4), 20):
    set_w(body, i, {'upperarm_l': 0.4, 'lowerarm_l': 0.3, 'hand_l': 0.1, 'spine': 0.1, 'neck': 0.1})
expect('5 influences', run(arm, body), 'influences', 'fail')
rc.fix(rc.Model(arm, [body]), {})
rep = run(arm, body)
expect('5 influences, fixed', rep, 'influences', 'pass')
expect('5 influences, fixed', rep, 'sum', 'pass')

# unweighted, fixed
arm, body = build()
for i in near(body, (0.6, 0, 1.45), 10):
    set_w(body, i, {})
rc.fix(rc.Model(arm, [body]), {'unweighted': True})
expect('unweighted, fixed', run(arm, body), 'unweighted', 'pass')

# a bone that holds no skin (a socket, a prop's handle) beside the forearm: unweighted forearm skin is given to the forearm, the
# nearest bone that holds skin, not to the socket (which hangs off the spine and would leave it behind when the elbow turns)
arm, body = build()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
sk = arm.data.edit_bones.new('socket_1')
sk.head, sk.tail = Vector((0.56, -0.06, 1.4)), Vector((0.68, -0.06, 1.4))
sk.parent = arm.data.edit_bones['spine']
bpy.ops.object.mode_set(mode='OBJECT')
for i in near(body, (0.62, 0, 1.4), 60):
    set_w(body, i, {})
rc.fix(rc.Model(arm, [body]), {'unweighted': True})
g = body.vertex_groups.get('socket_1')
on_socket = sum(1 for v in body.data.vertices for x in v.groups if g is not None and x.group == g.index and x.weight > 0)
line = f'{"ok  " if on_socket == 0 else "FAIL"} unweighted beside a socket, fixed: {on_socket} vertices on the socket (want 0)'
print('[test_rig_check] ' + line, flush=True)
if on_socket:
    failures.append(line)
expect('unweighted beside a socket, fixed', run(arm, body), 'stress_stretch', ('pass', 'warn'))

# an elbow out in the air beside the arm
arm, body = build()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
arm.data.edit_bones['lowerarm_l'].head = Vector((0.5, 0.0, 1.62))
bpy.ops.object.mode_set(mode='OBJECT')
expect('elbow outside', run(arm, body), 'joints', 'fail')
# ... a joint the game never turns bends no skin, wherever it sits
expect('elbow outside, never turned', run(arm, body, ranges={'^lowerarm_l$': [0, 0, 0]}), 'joints', 'pass')

# a sleeve ending short of the glove: the skin cut away 1.5 cm either side of the left wrist. Covered on both sides, so a gap to
# close (a warning), not a joint out in the air, and the wrist is still turned
import bmesh
arm, body = build()
bm = bmesh.new()
bm.from_mesh(body.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if abs(v.co.x - 0.76) < 0.008], context='VERTS')
bm.to_mesh(body.data)
bm.free()
rep = run(arm, body)
c = next(c for c in rep['skeleton'] if c['key'] == 'joints')
expect('wrist in a gap', rep, 'joints', 'warn')
if c.get('gaps') != ['hand_l']:
    failures.append(f'wrist in a gap: gaps {c.get("gaps")}, want hand_l')
if 'hand_l' not in [r['bone'] for r in rep['joints']]:
    failures.append('wrist in a gap: the wrist was not turned')

# a forearm that does not point at its hand
arm, body = build()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
eb['hand_l'].use_connect = False
eb['lowerarm_l'].tail = Vector((0.6, -0.25, 1.4))
bpy.ops.object.mode_set(mode='OBJECT')
expect('forearm off its hand', run(arm, body), 'aim', 'fail')

# a missing bone: no neck
arm, body = build(names={'neck': 'bone_7'})
expect('no neck', run(arm, body), 'roles', 'fail')

# an unmirrored rig: the left arm 12 cm forward
arm, body = build(left_arm_shift=0.12)
expect('left arm forward', run(arm, body), 'mirror', 'fail')

# the same body under each naming a rig comes with: every role found, read as a humanoid
MIXAMO = {'hips': 'Hips', 'spine': 'Spine', 'neck': 'Neck', 'head': 'Head'}
BLENDER = {'hips': 'pelvis', 'spine': 'spine.001', 'neck': 'neck', 'head': 'head'}
for s, side in (('l', 'Left'), ('r', 'Right')):
    MIXAMO.update({f'upperarm_{s}': f'{side}Arm', f'lowerarm_{s}': f'{side}ForeArm', f'hand_{s}': f'{side}Hand',
                   f'thigh_{s}': f'{side}UpLeg', f'calf_{s}': f'{side}Leg', f'foot_{s}': f'{side}Foot'})
    BLENDER.update({f'upperarm_{s}': f'upper_arm.{s.upper()}', f'lowerarm_{s}': f'forearm.{s.upper()}', f'hand_{s}': f'hand.{s.upper()}',
                    f'thigh_{s}': f'thigh.{s.upper()}', f'calf_{s}': f'shin.{s.upper()}', f'foot_{s}': f'foot.{s.upper()}'})
NAMINGS = {
    'mixamo': {k: 'mixamorig:' + v for k, v in MIXAMO.items()},
    'mixamo, no colon': {k: 'mixamorig' + v for k, v in MIXAMO.items()},
    'mixamo, bare': MIXAMO,
    'blender': BLENDER,
    'rigify': {k: 'DEF-' + v for k, v in BLENDER.items()},
}
for label, names in NAMINGS.items():
    arm, body = build(names=names)
    rep = run(arm, body)
    if rep['kind'] != 'humanoid':
        failures.append(f'{label} names read as {rep["kind"]}: roles {sorted(rep["roles"])}')
        print(f'[test_rig_check] FAIL {label} names: read as {rep["kind"]}, roles {sorted(rep["roles"])}', flush=True)
    expect(f'{label} names', rep, 'roles', 'pass')
    expect(f'{label} names', rep, 'mirror_weights', 'pass')

# a pouch on the right hip: the skin's median moves off the body's middle, and the left must still be compared with the right
def with_pouch(rigid=False):
    arm, body = build(rigid=rigid)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=0.06, location=(-0.2, -0.1, 1.0))
    pouch = bpy.context.active_object
    pouch.vertex_groups.new(name='hips').add(list(range(len(pouch.data.vertices))), 1.0, 'REPLACE')
    pouch.modifiers.new('arm', 'ARMATURE').object = arm
    bpy.context.view_layer.update()
    return arm, body, pouch


arm, body, pouch = with_pouch()
_, rep = rc.run_checks(arm, [body, pouch], {'in': 'test'})
expect('a pouch on one side', rep, 'mirror_weights', 'pass')
if 'not compared' in next(c['value'] for c in rep['weights'] if c['key'] == 'mirror_weights'):
    failures.append('a pouch on one side: the sides were not compared')
    print('[test_rig_check] FAIL a pouch on one side: the sides were not compared', flush=True)
# ... and with the left weighted unlike the right, that is caught
arm, body, pouch = with_pouch()
for v in body.data.vertices:
    if v.co.x > 0.04:
        set_w(body, v.index, {'spine': 1.0})
_, rep = rc.run_checks(arm, [body, pouch], {'in': 'test'})
expect('a pouch on one side, the left weighted unlike the right', rep, 'mirror_weights', 'fail')

# a model of two meshes is fixed mesh by mesh, each from the same joints
arm, body, pouch = with_pouch(rigid=True)
_, rep = rc.run_checks(arm, [body, pouch], {'in': 'test'})
try:
    rc.fix(rc.Model(arm, [body, pouch]), {}, rep['joints'])
    _, rep = rc.run_checks(arm, [body, pouch], {'in': 'test'})
    expect('two meshes, fixed', rep, 'stress_stretch', ('pass', 'warn'))
except Exception as e:
    failures.append(f'two meshes, fixed: {e!r}')
    print(f'[test_rig_check] FAIL two meshes, fixed: {e!r}', flush=True)

# a vertex whose neighbours are all on a bone far from it keeps its own weights when they are averaged, not the far bone
S = np.array([[0.0, 1.0], [0.5, 0.5]])
ok = np.array([[True, False], [True, True]])
got = rc.held_to(S, ok, np.array([[1.0, 0.0], [0.0, 1.0]]))
line = f'held to near bones: {got.tolist()} (want [[1, 0], [0.5, 0.5]])'
print('[test_rig_check] ' + ('ok   ' if np.allclose(got, [[1, 0], [0.5, 0.5]]) else 'FAIL ') + line, flush=True)
if not np.allclose(got, [[1, 0], [0.5, 0.5]]):
    failures.append(line)

# a creature: no humanoid names, still checked for weights and stress
arm, body = build(names={n: f'bone_{i}' for i, n in enumerate(BONES)})
rep = run(arm, body)
if rep['kind'] != 'creature':
    failures.append(f'unnamed bones read as {rep["kind"]}')
expect('creature', rep, 'roles', 'missing')
for k in ('joints', 'far', 'stress_kept', 'stress_stretch', 'stress_drag'):
    expect('creature', rep, k, 'pass')

print(f'[test_rig_check] {"ALL PASS" if not failures else str(len(failures)) + " WRONG"}', flush=True)
sys.exit(1 if failures else 0)
