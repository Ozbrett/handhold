# Checks the Blender export against the app's own answer, with no window:
#
#   blender -b --factory-startup --python-exit-code 1 --python scripts/check-blender.py -- \
#       <character file> <prop file> <apply_*.py from the Blender zip> <fixture.json> <posed .glb from the zip> [twist]
#
# With "twist" the armature is first turned, shrunk and moved, and that is baked
# into its bones, the way a character from another exporter might arrive. The
# script has to work out that difference by itself for the check to pass.
# With "sweep" the pose was exported with an arm sweep and the app was left at
# its end: the keyed sweep is played to its last frame before comparing.
#
# The untouched character and prop are imported, the exported script is run on
# them exactly as a user would, and every bone is then compared with where the
# app put it (the fixture written by scripts/try-models.mjs). The prop is
# compared with where it sits in the app's own posed GLB.
#
# Saved poses, animations and looks have to arrive as Actions: a pose called
# "Held" must put the hand on the exported hold, a look's two Actions must pass
# through it and end on the arc the app drew, and an animation must move the hand.

import json
import math
import sys

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

arguments = sys.argv[sys.argv.index('--') + 1:]
character_file, prop_file, script_file, fixture_file, posed_file = arguments[:5]
twisted = 'twist' in arguments[5:]
swept = 'sweep' in arguments[5:]


def import_model(path):
    before = set(bpy.data.objects)
    if path.lower().endswith('.fbx'):
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def to_blender_quaternion(q):
    return Quaternion((q[3], q[0], -q[2], q[1]))


bpy.ops.wm.read_factory_settings(use_empty=True)
fixture = json.load(open(fixture_file))

character = import_model(character_file)
armature = next(o for o in character if o.type == 'ARMATURE')
prop_objects = import_model(prop_file)
prop = next(o for o in prop_objects if o.parent is None)
bpy.context.view_layer.update()

# the fixture carries the app's tidied-up bone names; find the armature's own spelling
loose = lambda name: ''.join(c for c in name.lower() if c.isalnum())
spelling = {loose(b.name): b.name for b in armature.data.bones}
for b in fixture['bones']:
    b['name'] = spelling[loose(b['name'])]

# optionally make this armature differ from the file the app read: other axes, other units, another place
twist = Matrix.Identity(4)
if twisted:
    twist = Matrix.LocRotScale(Vector((1.0, 2.0, 0.5)), Euler((0.4, -0.3, 1.1)), Vector((0.5, 0.5, 0.5)))
    armature.matrix_world = twist @ armature.matrix_world
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()
twist_turn = twist.to_quaternion()
twist_scale = twist.to_scale().x
expected = lambda p: twist @ to_blender(p)

# the fixture and the imported character must agree at rest, or nothing below means anything
world = armature.matrix_world
size = twist_scale * max((to_blender(b['rest']['p']) - to_blender(fixture['bones'][0]['rest']['p'])).length for b in fixture['bones'])
rest_error = max((world @ armature.data.bones[b['name']].head_local - expected(b['rest']['p'])).length for b in fixture['bones'])
print('CHECK%s rest positions agree to %.5f (arm + hand span %.3f)' % (' (twisted armature)' if twisted else '', rest_error, size))

# run the exported script the way a user would: armature active, prop selected too
bpy.ops.object.select_all(action='DESELECT')
prop.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
exec(compile(open(script_file, encoding='utf8').read(), script_file, 'exec'), {'__name__': '__main__'})
if swept:
    bpy.context.scene.frame_set(bpy.context.scene.frame_current + 24)
bpy.context.view_layer.update()

worst_position = 0.0
worst_angle = 0.0
worst_bone = ''
armature_turn = world.to_quaternion()
for b in fixture['bones']:
    pose_bone = armature.pose.bones[b['name']]
    position = world @ pose_bone.head
    worst_position = max(worst_position, (position - expected(b['posed']['p'])).length)
    # how the bone was turned from rest, in world space, here and in the app
    here = armature_turn @ pose_bone.matrix.to_quaternion() @ pose_bone.bone.matrix_local.to_quaternion().inverted() @ armature_turn.inverted()
    there = to_blender_quaternion(b['posed']['q']) @ to_blender_quaternion(b['rest']['q']).inverted()
    there = twist_turn @ there @ twist_turn.inverted()
    angle = math.degrees(here.rotation_difference(there).angle)
    angle = min(angle, 360.0 - angle)
    if angle > worst_angle:
        worst_angle, worst_bone = angle, b['name']
print('CHECK bones: worst position error %.5f (%.2f%% of the span), worst turn error %.2f deg (%s)' % (
    worst_position, 100 * worst_position / size, worst_angle, worst_bone))

# the prop: compare with the app's own posed GLB, where it hangs off the hand bone
prop_here = prop.matrix_world.copy()
posed = import_model(posed_file)
bpy.context.view_layer.update()
posed_armature = next(o for o in posed if o.type == 'ARMATURE')
carried = [o for o in posed if o.parent is posed_armature and o.parent_type == 'BONE']
if carried:
    there = twist @ carried[0].matrix_world
    offset = (prop_here.to_translation() - there.to_translation()).length
    turn = math.degrees(prop_here.to_quaternion().rotation_difference(there.to_quaternion()).angle)
    turn = min(turn, 360.0 - turn)
    print('CHECK prop: %.5f from where the app put it (%.2f%% of the span), turned %.2f deg from it' % (offset, 100 * offset / size, turn))
else:
    offset, turn = 0.0, 0.0
    print('CHECK prop: the posed GLB has no object on the hand bone to compare with')



def count_keys(action):
    if action is None:
        return 0
    curves = []
    if hasattr(action, 'layers'):   # Blender 4.4 and later keep curves in layers, strips and channel bags
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    curves.extend(bag.fcurves)
    elif hasattr(action, 'fcurves'):
        curves = list(action.fcurves)
    return sum(len(c.keyframe_points) for c in curves)


keys = count_keys(armature.animation_data.action if armature.animation_data else None)
print('CHECK keyframes written: %d' % keys)

# --- saved poses, animations and looks, read back from the Actions the script made
text = open(script_file, encoding='utf8').read()
start = text.index("json.loads(r'''") + len("json.loads(r'''")
exported = json.loads(text[start:text.index("''')", start)])
saved_arm = exported.get('arm') or {}
prefix = exported.get('object') or 'Handhold'
saved_ok = True
if saved_arm.get('poses') or saved_arm.get('clips') or saved_arm.get('looks'):
    hand_bone = armature.pose.bones[spelling[loose(exported['handBone'])]]
    shoulder = world @ armature.pose.bones[spelling[loose(saved_arm['upperArm'])]].head
    held = expected(next(b for b in fixture['bones'] if b['name'] == hand_bone.name)['posed']['p'])
    held_arm = held - shoulder
    up = twist_turn @ to_blender((0.0, 1.0, 0.0))
    front = twist_turn @ to_blender(saved_arm.get('forward') or (0.0, 0.0, 1.0))
    right = front.cross(up).normalized()

    def show(action, frame):
        data = armature.animation_data
        data.action = action
        if hasattr(data, 'action_slot') and getattr(action, 'slots', None):
            data.action_slot = action.slots[0]
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        return world @ hand_bone.head

    def key_frames(action):
        curves = []
        if hasattr(action, 'layers'):
            for layer in action.layers:
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        curves.extend(bag.fcurves)
        elif hasattr(action, 'fcurves'):
            curves = list(action.fcurves)
        return sorted(set(round(p.co[0]) for c in curves for p in c.keyframe_points))

    def find(name):
        action = bpy.data.actions.get('%s %s' % (prefix, name))
        if action is None:
            print("CHECK saved: no Action called '%s %s'" % (prefix, name))
        return action

    for saved in saved_arm.get('poses') or []:
        action = find(saved['name'])
        if action is None:
            saved_ok = False
            continue
        off = (show(action, 1) - held).length
        must = saved['name'] == 'Held'
        print("CHECK saved pose '%s': Action '%s', %d key frame(s), %s; hand %.5f from the hold (%.2f%% of the span)%s" % (
            saved['name'], action.name, len(key_frames(action)), 'a pose asset' if action.asset_data else 'not an asset',
            off, 100 * off / size, ' (has to match it)' if must else ''))
        saved_ok &= len(key_frames(action)) == 1 and (not must or off < 0.02 * size)

    for clip in saved_arm.get('clips') or []:
        action = find(clip['name'])
        if action is None:
            saved_ok = False
            continue
        frames = key_frames(action)
        first = show(action, frames[0]) if frames else Vector()
        travel = max([(show(action, f) - first).length for f in frames] or [0.0])
        print("CHECK saved animation '%s': Action '%s', frames %s to %s (%d keyed)%s; the hand travels %.4f (%.1f%% of the span)" % (
            clip['name'], action.name, frames[0] if frames else '-', frames[-1] if frames else '-', len(frames),
            ', cyclic' if getattr(action, 'use_cyclic', False) else '', travel, 100 * travel / size))
        saved_ok &= len(frames) >= 2 and travel > 0 and bool(getattr(action, 'use_cyclic', False)) == bool(clip.get('loops'))

    for look in saved_arm.get('looks') or []:
        down_up, left_right = find(look['name'] + ' Down-Up'), find(look['name'] + ' Left-Right')
        if down_up is None or left_right is None:
            saved_ok = False
            continue
        last = key_frames(down_up)[-1]
        middle = (1 + last) // 2
        centred = abs(look['yaw'][0] + look['yaw'][1]) < 0.01 and abs(look['pitch'][0] + look['pitch'][1]) < 0.01
        ahead = max((show(down_up, middle) - held).length, (show(left_right, middle) - held).length)
        top = (show(down_up, last) - (shoulder + Quaternion(right, math.radians(look['pitch'][1])) @ held_arm)).length
        side = (show(left_right, last) - (shoulder + Quaternion(up, -math.radians(look['yaw'][1])) @ held_arm)).length
        print("CHECK saved look '%s': straight ahead (frame %d) the hand is %.5f from the hold (%.2f%%%s); fully up %.5f from the arc (%.2f%%), fully right %.5f (%.2f%%)" % (
            look['name'], middle, ahead, 100 * ahead / size, '' if centred else ', range not centred',
            top, 100 * top / size, side, 100 * side / size))
        saved_ok &= (not centred or ahead < 0.02 * size) and top < 0.03 * size and side < 0.03 * size
    print('CHECK saved: %s' % ('all as the app drew them' if saved_ok else 'SOMETHING IS OFF'))

ok = rest_error < 0.01 * size and worst_position < 0.02 * size and worst_angle < 2.0 and offset < 0.03 * size and turn < 3.0 and keys > 0 and saved_ok
print('RESULT', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
