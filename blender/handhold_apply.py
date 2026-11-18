# Handhold grip for Blender.
#
# Applies a grip exported from Handhold to a character that is already in your
# scene, with its own armature.
#
# How to use
#   1. Select the character's armature. To put a prop in the hand as well,
#      select the prop too (the armature must be the active object).
#   2. Scripting tab > Text > Open > this file, then Run Script.
#
# The pose is keyed at the current frame, so you can blend into and out of it
# like any other pose. If a sweep was exported, the arm is keyed along it over
# SWEEP_FRAMES frames, starting at the current frame.
#
# Saved poses, animations and looks
#   Everything saved on Handhold's Animations tab is added to the file as an
#   Action, named after the prop ("Torch Raised", "Torch Swing"):
#     - a pose is one frame, and is also marked as a pose asset, so it shows
#       up in the Pose Library (Asset Browser, or the sidebar in the 3D view);
#     - an animation is keyed from frame 1 at the scene's frame rate;
#     - a look becomes two Actions, "... Down-Up" and "... Left-Right", each
#       LOOK_FRAMES long with straight ahead in the middle.
#   Pick one in the Action editor (Dope Sheet > Action Editor), or push it down
#   to an NLA strip. Running the script again replaces the Actions it made.
#
# Nothing here depends on how the model was imported: the file carries the rest
# position of every bone it names, and those are lined up with the same bones
# of your armature, which gives the turn and scale between the two.

import json

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

# --- settings -----------------------------------------------------------------
KEYFRAME = True      # key the pose at the current frame
APPLY_ARM = None     # None: as chosen when exporting. True / False: always / never place the arm
SWEEP_FRAMES = 24    # length of the keyed arm sweep, if one was exported (0 = do not key it)
PROP_TURN = (0.0, 0.0, 0.0)   # extra turn for the prop in degrees (XYZ), if its model uses different axes
SAVED_ACTIONS = True # add every saved pose, animation and look as an Action
ACTION_PREFIX = None # what their names start with. None: the prop's name
POSE_ASSETS = True   # mark saved poses as pose assets, for the Pose Library
LOOK_FRAMES = 24     # length of each of a look's two Actions
# ------------------------------------------------------------------------------

POSE = json.loads(r'''__POSE_JSON__''')


def to_blender_vector(p):
    # glTF is Y-up, Blender is Z-up
    return Vector((p[0], -p[2], p[1]))


def to_blender_quaternion(q):
    # exported as (x, y, z, w); mathutils wants (w, x, y, z)
    return Quaternion((q[3], q[0], -q[2], q[1]))


def loose(name):
    return ''.join(c for c in name.lower() if c.isalnum())


def use_armature_names(armature):
    """Importers disagree about punctuation in bone names ("mixamorig:RightHand",
    "mixamorig_RightHand", "mixamorigRightHand"), so every name in the pose is
    swapped for the armature's own spelling of it, matched on letters and digits."""
    by_loose = {loose(b.name): b.name for b in armature.data.bones}
    names = set(b.name for b in armature.data.bones)

    def fix(name):
        if not name or name in names:
            return name
        return by_loose.get(loose(name), name)

    second = POSE.get('secondHand') or {}
    for part in (POSE, second):
        if part.get('handBone'):
            part['handBone'] = fix(part['handBone'])
        for entry in part.get('bones') or []:
            entry['name'] = fix(entry['name'])
        arm = part.get('arm') or {}
        for key in ('upperArm', 'forearm', 'hand'):
            if key in arm:
                arm[key] = fix(arm[key])
    for entry in POSE.get('restPoints') or []:
        entry['name'] = fix(entry['name'])


def best_rotation(a, b):
    """Horn's closed-form answer to 'which rotation best carries points a onto points b'."""
    s = np.zeros((3, 3))
    for p, q in zip(a, b):
        s += np.outer(p, q)
    sxx, sxy, sxz = s[0]
    syx, syy, syz = s[1]
    szx, szy, szz = s[2]
    n = np.array([
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ])
    values, vectors = np.linalg.eigh(n)
    w, x, y, z = vectors[:, int(np.argmax(values))]
    return Quaternion((w, x, y, z)).normalized()


class Fit:
    """The turn and scale that carry the exported rest skeleton onto an armature."""

    def __init__(self, armature):
        self.rotation = Quaternion()
        self.unit = 1.0
        self.exported_centre = Vector()
        self.scene_centre = Vector()
        a, b = [], []
        for entry in POSE.get('restPoints') or []:
            bone = armature.data.bones.get(entry['name'])
            if bone is None:
                continue
            a.append(to_blender_vector(entry['position']))
            b.append(bone.head_local.copy())
        if len(a) < 3:
            print('Handhold: too few bones to line the export up with this armature; assuming the same axes and units.')
            return
        ca = sum(a, Vector()) / len(a)
        cb = sum(b, Vector()) / len(b)
        a = [p - ca for p in a]
        b = [p - cb for p in b]
        spread_a = sum(p.length_squared for p in a)
        spread_b = sum(p.length_squared for p in b)
        if spread_a < 1e-12 or spread_b < 1e-12:
            return
        self.exported_centre, self.scene_centre = ca, cb
        self.unit = (spread_b / spread_a) ** 0.5
        self.rotation = best_rotation(a, b)

    def turn(self, q):
        """An exported rotation, as a rotation in the armature's space."""
        if not q:
            return Quaternion()
        return (self.rotation @ to_blender_quaternion(q) @ self.rotation.inverted()).normalized()

    def point(self, p):
        """An exported point, as a point in the armature's space."""
        return self.rotation @ ((to_blender_vector(p) - self.exported_centre) * self.unit) + self.scene_centre


def rest_rotation(armature, name):
    return armature.data.bones[name].matrix_local.to_quaternion()


class Poser:
    """Turns pose bones to rotations given in the armature's space, parents before children."""

    def __init__(self, armature):
        self.armature = armature
        self.posed = {}   # bone name -> rotation in armature space, for bones turned here

    def current(self, name):
        if name in self.posed:
            return self.posed[name]
        return self.armature.pose.bones[name].matrix.to_quaternion()

    def set(self, name, target, frame=None, weight=1.0):
        pose_bone = self.armature.pose.bones[name]
        rest = rest_rotation(self.armature, name)
        if pose_bone.parent is not None:
            parent_rest = rest_rotation(self.armature, pose_bone.parent.name)
            parent_now = self.current(pose_bone.parent.name)
            from_parent = parent_now @ parent_rest.inverted() @ rest
        else:
            from_parent = rest
        basis = from_parent.inverted() @ target
        basis.normalize()
        if weight < 1.0:
            # part of the way from the rest pose
            basis = Quaternion().slerp(basis, max(0.0, weight))
            target = from_parent @ basis
        mode = pose_bone.rotation_mode
        if mode == 'QUATERNION':
            pose_bone.rotation_quaternion = basis
            path = 'rotation_quaternion'
        elif mode == 'AXIS_ANGLE':
            axis, angle = basis.to_axis_angle()
            pose_bone.rotation_axis_angle = (angle, axis.x, axis.y, axis.z)
            path = 'rotation_axis_angle'
        else:
            pose_bone.rotation_euler = basis.to_euler(mode)
            path = 'rotation_euler'
        self.posed[name] = target
        if frame is not None:
            pose_bone.keyframe_insert(path, frame=frame)


def find_armature():
    active = bpy.context.view_layer.objects.active
    if active is not None and active.type == 'ARMATURE':
        return active
    chosen = [o for o in bpy.context.selected_objects if o.type == 'ARMATURE']
    if chosen:
        return chosen[0]
    hand = loose(POSE.get('handBone') or '')
    matching = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE' and any(loose(b.name) == hand for b in o.data.bones)]
    if len(matching) == 1:
        return matching[0]
    raise RuntimeError("Handhold: select your character's armature first.")


def find_prop(armature):
    for o in bpy.context.selected_objects:
        if o is armature or o.type == 'ARMATURE':
            continue
        if o.parent is armature and o.parent_type != 'BONE':
            continue   # the character's own mesh
        return o
    return None


def depth(bone):
    count = 0
    while bone.parent is not None:
        count += 1
        bone = bone.parent
    return count


def slerp_arm(fit, key0, key1, weight):
    return [fit.turn(key0[k]).slerp(fit.turn(key1[k]), weight) for k in ('upperArm', 'forearm', 'hand')]


def apply():
    armature = find_armature()
    use_armature_names(armature)
    hand = POSE.get('handBone')
    if not hand or hand not in armature.data.bones:
        raise RuntimeError("Handhold: hand bone '%s' was not found in armature '%s'." % (hand, armature.name))
    prop = find_prop(armature)
    scene = bpy.context.scene
    frame = scene.frame_current if KEYFRAME else None
    bpy.context.view_layer.update()

    fit = Fit(armature)
    poser = Poser(armature)
    bones = armature.data.bones
    hand_rest = rest_rotation(armature, hand)

    # Fingers: the exported turn from rest, stored relative to the hand so the grip follows the hand.
    def load_fingers(entries, hand_name):
        rest = rest_rotation(armature, hand_name)
        found = []
        for entry in entries or []:
            name = entry['name']
            if name not in bones:
                print("Handhold: finger bone '%s' not found; skipped." % name)
                continue
            gripped = fit.turn(entry['delta']) @ rest_rotation(armature, name)
            found.append((depth(bones[name]), name, rest.inverted() @ gripped))
        found.sort(key=lambda item: item[0])
        return found

    fingers = load_fingers(POSE.get('bones'), hand)

    # Two-handed grips: the second hand, its fingers and its arm
    second = POSE.get('secondHand') or {}
    hand2 = second.get('handBone')
    if hand2 and hand2 not in bones:
        print("Handhold: second hand bone '%s' not found; holding with one hand." % hand2)
        hand2 = None
    fingers2 = load_fingers(second.get('bones'), hand2) if hand2 else []

    def pose_fingers(at_frame, second_grip=1.0):
        for hand_name, found, weight in ((hand, fingers, 1.0), (hand2, fingers2, second_grip)):
            if not found:
                continue
            hand_now = poser.current(hand_name)
            for _, name, in_hand in found:
                poser.set(name, hand_now @ in_hand, at_frame, weight)

    # Arms: each is a chain of upper arm, forearm and hand with its own exported turns
    def chain(arm, hand_name):
        names = [arm.get('upperArm'), arm.get('forearm'), hand_name]
        if not arm or not hand_name or not all(n in bones for n in names):
            return None
        return names, [rest_rotation(armature, n) for n in names]

    arm = POSE.get('arm') or {}
    use_arm = APPLY_ARM if APPLY_ARM is not None else arm.get('mode') in ('hold', 'camera')
    chains = [(chain(arm, hand), arm)]
    if hand2:
        chains.append((chain(second.get('arm') or {}, hand2), second.get('arm') or {}))
    have_arm = chains[0][0] is not None

    def pose_arms(sample, at_frame):
        for found, part in chains:
            if found is None:
                continue
            turns = sample(part)
            if turns is None:
                continue
            for name, turn, rest in zip(found[0], turns, found[1]):
                poser.set(name, turn @ rest, at_frame)

    def at_key(i):
        def sample(part):
            keys = part.get('sweep') or []
            return [fit.turn(keys[i][k]) for k in ('upperArm', 'forearm', 'hand')] if i < len(keys) else None
        return sample

    def at_hold(part):
        hold = part.get('hold') or {}
        return [fit.turn(hold.get(k)) for k in ('upperArm', 'forearm', 'hand')] if hold else None

    # Saved poses, animations and looks: each becomes an Action of its own.
    parts = ('upperArm', 'forearm', 'hand')

    def turns_of(entry):
        """A saved arm position (and the second arm's, if it has one) as turns in the armature's space."""
        other = entry.get('second')
        return [fit.turn(entry.get(k)) for k in parts], [fit.turn(other.get(k)) for k in parts] if other else None

    def mix(a, b, weight):
        first = [p.slerp(q, weight) for p, q in zip(a[0], b[0])]
        if a[1] and b[1]:
            return first, [p.slerp(q, weight) for p, q in zip(a[1], b[1])]
        return first, b[1] or a[1]

    def pose_turns(turns, at_frame, second_grip=1.0):
        poser.posed.clear()
        for (found, _), turned in zip(chains, turns):
            if found is None or turned is None:
                continue
            for name, turn, rest in zip(found[0], turned, found[1]):
                poser.set(name, turn @ rest, at_frame)
        pose_fingers(at_frame, second_grip)

    def look_at(look, yaw, pitch):
        """A look is a grid of arm positions over the view's yaw and pitch; this reads it at one direction."""
        columns, rows, grid = int(look['columns']), int(look['rows']), look['grid']

        def between(ends, value, count):
            if count < 2 or abs(ends[1] - ends[0]) < 1e-9:
                return 0, 0, 0.0
            at = min(max((value - ends[0]) / (ends[1] - ends[0]), 0.0), 1.0) * (count - 1)
            first = min(int(at), count - 2)
            return first, first + 1, at - first

        c0, c1, across = between(look['yaw'], yaw, columns)
        r0, r1, upward = between(look['pitch'], pitch, rows)
        low = mix(turns_of(grid[r0 * columns + c0]), turns_of(grid[r0 * columns + c1]), across)
        high = mix(turns_of(grid[r1 * columns + c0]), turns_of(grid[r1 * columns + c1]), across)
        return mix(low, high, upward)

    def saved_actions():
        """Adds every saved pose, animation and look as an Action. Returns their names."""
        poses, clips, looks = arm.get('poses') or [], arm.get('clips') or [], arm.get('looks') or []
        if not have_arm or not (poses or clips or looks):
            return []
        prefix = ACTION_PREFIX if ACTION_PREFIX is not None else (POSE.get('object') or 'Handhold')
        rate = scene.render.fps / scene.render.fps_base
        touched = [n for found, _ in chains if found for n in found[0]] + [f[1] for f in fingers + fingers2]
        before = {n: (armature.pose.bones[n].rotation_quaternion.copy(), armature.pose.bones[n].rotation_euler.copy(),
                      tuple(armature.pose.bones[n].rotation_axis_angle)) for n in touched}
        data = armature.animation_data_create()
        action_was = data.action
        slot_was = getattr(data, 'action_slot', None)
        made = []

        def begin(name):
            name = ('%s %s' % (prefix, name)).strip()
            old = bpy.data.actions.get(name)
            if old is not None:
                bpy.data.actions.remove(old)   # made by an earlier run of this script
            action = bpy.data.actions.new(name)
            action.use_fake_user = True         # keep it in the file even while nothing uses it
            data.action = action
            made.append(action.name)
            return action

        for saved in poses:
            action = begin(saved.get('name') or 'Pose')
            pose_turns(turns_of(saved), 1)
            if POSE_ASSETS:
                try:
                    action.asset_mark()
                except Exception:
                    pass

        for clip in clips:
            frames = clip.get('frames') or []
            if len(frames) < 2:
                continue
            action = begin(clip.get('name') or 'Animation')
            for at in frames:
                pose_turns(turns_of(at), 1 + round(at['t'] * rate), 1.0 - min(max(at.get('away') or 0.0, 0.0), 1.0))
            try:
                action.use_frame_range = True
                action.frame_start, action.frame_end = 1, 1 + round(frames[-1]['t'] * rate)
                action.use_cyclic = bool(clip.get('loops'))
            except Exception:
                pass

        steps = 8
        for look in looks:
            if not look.get('grid') or len(look['grid']) < int(look.get('columns') or 0) * int(look.get('rows') or 0):
                continue
            name = look.get('name') or 'Look'
            if LOOK_FRAMES > 0:
                begin(name + ' Down-Up')
                for i in range(steps + 1):
                    pitch = look['pitch'][0] + (look['pitch'][1] - look['pitch'][0]) * i / steps
                    pose_turns(look_at(look, 0.0, pitch), 1 + round(LOOK_FRAMES * i / steps))
                begin(name + ' Left-Right')
                for i in range(steps + 1):
                    yaw = look['yaw'][0] + (look['yaw'][1] - look['yaw'][0]) * i / steps
                    pose_turns(look_at(look, yaw, 0.0), 1 + round(LOOK_FRAMES * i / steps))

        # hand the armature back as it was: its own action, and its bones where they were
        data.action = action_was
        if action_was is not None and slot_was is not None:
            try:
                data.action_slot = slot_was
            except Exception:
                pass
        for n, (as_quaternion, as_euler, as_axis_angle) in before.items():
            pose_bone = armature.pose.bones[n]
            pose_bone.rotation_quaternion = as_quaternion
            pose_bone.rotation_euler = as_euler
            pose_bone.rotation_axis_angle = as_axis_angle
        poser.posed.clear()
        bpy.context.view_layer.update()
        return made

    actions = saved_actions() if SAVED_ACTIONS else []

    sweep = arm.get('sweep') or []
    if use_arm and have_arm:
        if len(sweep) >= 2 and SWEEP_FRAMES > 0 and KEYFRAME:
            for i, key in enumerate(sweep):
                at = frame + round(key['t'] * SWEEP_FRAMES)
                poser.posed.clear()
                pose_arms(at_key(i), at)
                pose_fingers(at)
            poser.posed.clear()
            pose_arms(at_key(0), None)
        else:
            pose_arms(at_hold, frame)
    pose_fingers(frame)
    bpy.context.view_layer.update()

    # Prop: where it sat in the model's space while the hand was at rest, carried along with the hand.
    at_rest = POSE.get('objectAtRest')
    if prop is not None and at_rest:
        extra = Matrix.Rotation(np.radians(PROP_TURN[2]), 4, 'Z') @ Matrix.Rotation(np.radians(PROP_TURN[1]), 4, 'Y') @ Matrix.Rotation(np.radians(PROP_TURN[0]), 4, 'X')
        turned = (fit.rotation @ to_blender_quaternion(at_rest['quaternion'])).to_matrix().to_4x4() @ extra
        object_rest = Matrix.Translation(fit.point(at_rest['position'])) @ turned
        hand_rest_matrix = Matrix.Translation(bones[hand].head_local) @ hand_rest.to_matrix().to_4x4()
        in_hand = hand_rest_matrix.inverted() @ object_rest
        pose_bone = armature.pose.bones[hand]
        hand_now = Matrix.Translation(pose_bone.head) @ pose_bone.matrix.to_quaternion().to_matrix().to_4x4()
        scale = prop.matrix_world.to_scale()
        world = armature.matrix_world @ hand_now @ in_hand
        location, rotation, _ = world.decompose()
        prop.parent = armature
        prop.parent_type = 'BONE'
        prop.parent_bone = hand
        bpy.context.view_layer.update()
        prop.matrix_world = Matrix.LocRotScale(location, rotation, scale)

    print("Handhold: applied '%s' to %s (%d finger bones%s%s%s)." % (
        POSE.get('object') or 'grip', armature.name, len(fingers),
        ', arm placed' if use_arm and have_arm else '',
        ', second hand %s with %d finger bones' % (hand2, len(fingers2)) if hand2 else '',
        ', prop ' + prop.name if prop is not None and at_rest else ''))
    if actions:
        print('Handhold: added %d Actions (Dope Sheet > Action Editor): %s.' % (len(actions), ', '.join(actions)))


apply()
