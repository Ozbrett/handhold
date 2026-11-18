@tool
class_name HandholdGrip
extends SkeletonModifier3D
## Applies a grip exported from Handhold to a character's own skeleton.
##
## Add this node as a child of the character's Skeleton3D and set [member pose]
## to the exported .pose.json file. It runs after the AnimationPlayer, so it
## layers on top of whatever animation is playing. Needs Godot 4.3 or newer.
##
## Arm modes:
## - Animation: your animation (walk, run, idle) moves the arm. Only the fingers
##   and the prop are added on top of it.
## - Hold: the arm stays at the exported hold position while the rest of the
##   body animates. [member sweep] moves it along the exported sweep.
## - Follow camera: the arm follows where [member aim_source] looks, up and
##   down: along the exported sweep if there is one, otherwise by swinging the
##   held pose at the shoulder.
##
## Two-handed grips: the other hand holds on at its own spot, and its arm bends
## to reach it wherever the first hand goes ([member second_hand_weight]).
##
## Saved poses, animations and looks: whatever was saved on Handhold's
## Animations tab is in the file, by name. Show one from your own code:
## [codeblock]
## $Skeleton3D/HandholdGrip.show_saved("Raised")  # a pose: the arm goes there and stays
## $Skeleton3D/HandholdGrip.show_saved("Swing")   # an animation: plays, then goes back
## $Skeleton3D/HandholdGrip.show_saved("Look")    # a look: the arm follows the camera
## $Skeleton3D/HandholdGrip.show_saved("")        # hand the arm back to arm_mode
## [/codeblock]
## [method saved_names] lists what the file has. [member start_with] shows one
## as soon as the file is loaded. With [member arm_mode] left at From Export, a
## file exported to follow the camera starts with its look.
##
## Nothing here depends on how the model was imported: the exported file carries
## the rest position of every bone it names, and those are lined up with the
## same bones of this skeleton, which gives the turn and scale between the two.

enum ArmMode { FROM_EXPORT, ANIMATION, HOLD, FOLLOW_CAMERA }
enum Saved { NONE, POSE, ANIMATION, LOOK }

## Emitted when a saved animation that does not loop reaches its end.
signal finished(saved_name: String)

## The .pose.json exported from Handhold.
@export var pose: JSON:
	set(value):
		pose = value
		_loaded = false

## The prop to put in the hand. Optional.
@export var held_object: Node3D:
	set(value):
		held_object = value
		_loaded = false

## Extra turn for the prop, in degrees, if its model uses different axes.
@export var held_object_turn: Vector3 = Vector3.ZERO:
	set(value):
		held_object_turn = value
		_loaded = false

## 0 leaves the fingers to your animation, 1 is the full grip.
@export_range(0.0, 1.0) var grip: float = 1.0

@export_group("Arm")
@export var arm_mode: ArmMode = ArmMode.FROM_EXPORT
## How strongly the exported arm pose overrides the animation.
@export_range(0.0, 1.0) var arm_weight: float = 1.0
## Hold mode: position along the exported sweep (0 = start, 1 = end).
@export_range(0.0, 1.0) var sweep: float = 0.0

@export_group("Saved poses, animations and looks")
## The saved pose, animation or look to show as soon as the file is loaded. Leave empty for none.
@export var start_with: String = ""
## Seconds the arm takes to move from one saved item to the next. 0 = at once.
@export var blend_time: float = 0.15

@export_group("Follow camera")
## What the arm follows. Leave empty to use the current camera.
@export var aim_source: Node3D
## Looking this far down (degrees) is the start of the sweep.
@export var aim_down: float = -60.0
## Looking this far up (degrees) is the end of the sweep.
@export var aim_up: float = 60.0
## Seconds the arm takes to catch up with the camera. 0 = instantly.
@export var aim_smoothing: float = 0.08

@export_group("Second hand")
## Two-handed grips only: how firmly the second hand holds on. Blend to 0 to let go, for example while reloading.
@export_range(0.0, 1.0) var second_hand_weight: float = 1.0

var _loaded: bool = false
var _ok: bool = false
var _fit: Quaternion = Quaternion.IDENTITY
var _unit: float = 1.0
var _exported_centre: Vector3 = Vector3.ZERO
var _scene_centre: Vector3 = Vector3.ZERO
var _hand: int = -1
var _upper: int = -1
var _fore: int = -1
var _hand_rest: Quaternion = Quaternion.IDENTITY
var _upper_rest: Quaternion = Quaternion.IDENTITY
var _fore_rest: Quaternion = Quaternion.IDENTITY
var _fingers: Array = []          # bone indices, parents before children
var _finger_in_hand: Array = []   # each finger bone's gripped rotation, relative to the hand bone
var _arm: Dictionary = {}
var _object_in_hand: Transform3D = Transform3D.IDENTITY
var _object_scale: Vector3 = Vector3.ONE
var _has_object: bool = false
var _sweep_now: float = 0.0
var _pitch_now: float = 0.0
# second hand (two-handed grips)
var _two_hands: bool = false
var _hand2: int = -1
var _upper2: int = -1
var _fore2: int = -1
var _hand2_rest: Quaternion = Quaternion.IDENTITY
var _upper2_rest: Quaternion = Quaternion.IDENTITY
var _fore2_rest: Quaternion = Quaternion.IDENTITY
var _fingers2: Array = []
var _finger_in_hand2: Array = []
var _arm2: Dictionary = {}
var _reach_point: Vector3 = Vector3.ZERO      # where the second hand bone sits while the first hand is at rest
var _reach_turn: Quaternion = Quaternion.IDENTITY
var _bend_hint: Vector3 = Vector3.BACK        # the character's front, for bending a straight elbow
# what is shown now: a saved pose, animation or look, or none. An arm position is kept as
# [upper arm, forearm, hand, second upper arm, second forearm, has a second arm, second hand let go 0-1],
# the rotations being turns from rest in the skeleton's space.
var _shown: int = Saved.NONE
var _shown_index: int = 0
var _back: int = Saved.NONE                   # what an animation that plays once goes back to
var _back_index: int = 0
var _clip_frame: int = 0
var _clip_time: float = 0.0
var _blend: float = 1.0
var _blend_from: Array = []                   # empty: work it out on the next frame, from where the arm is then
var _last: Array = []
var _placed: bool = false                     # whether this node placed the arm on the last frame
var _front: Vector3 = Vector3.BACK            # the way the character faces, in the skeleton's space
var _upright: Vector3 = Vector3.UP            # and the way it stands
var _yaw_now: float = 0.0


## True when the loaded grip holds the object with both hands.
func has_second_hand() -> bool:
	return _ok and _two_hands


## The names of the saved poses, animations and looks in the file.
func saved_names() -> PackedStringArray:
	var names := PackedStringArray()
	for item in _saved("poses"):
		names.append(str(item.get("name", "")))
	for item in _saved("clips"):
		if _playable(item):
			names.append(str(item.get("name", "")))
	for item in _saved("looks"):
		if _usable(item):
			names.append(str(item.get("name", "")))
	return names


## Shows a saved pose, animation or look by name (upper and lower case do not matter).
## A pose stays, an animation plays (once, or round and round if it loops) and a look
## follows the camera. Pass "" to hand the arm back to [member arm_mode].
## Returns false if the file has nothing by that name.
func show_saved(saved_name: String) -> bool:
	var found := _find_saved(saved_name)
	if not saved_name.is_empty() and found[0] == Saved.NONE:
		return false
	if not _loaded or not _ok:
		start_with = saved_name   # shown as soon as the file is loaded
		return true
	if found[0] != Saved.NONE and (_upper < 0 or _fore < 0):
		return false
	_begin(found[0], found[1], [])
	return true


## The name of the saved pose, animation or look the arm is showing now, or "" for none.
func showing() -> String:
	if not _ok or _shown == Saved.NONE:
		return ""
	var items := _saved("poses")
	if _shown == Saved.ANIMATION:
		items = _saved("clips")
	elif _shown == Saved.LOOK:
		items = _saved("looks")
	return str(items[_shown_index].get("name", "")) if _shown_index < items.size() else ""


## True while a saved animation is playing.
func is_playing() -> bool:
	return _ok and _shown == Saved.ANIMATION


## Jumps to a time (seconds) in the saved animation that is playing. It carries on from there.
func seek(seconds: float) -> void:
	if is_playing():
		_clip_time = maxf(0.0, seconds)


## The saved poses ("poses"), animations ("clips") or looks ("looks") in the file.
func _saved(key: String) -> Array:
	if pose == null or typeof(pose.data) != TYPE_DICTIONARY:
		return []
	var arm = pose.data.get("arm")
	if typeof(arm) != TYPE_DICTIONARY:
		return []
	var items = arm.get(key)
	return items if typeof(items) == TYPE_ARRAY else []


static func _playable(clip) -> bool:
	return typeof(clip) == TYPE_DICTIONARY and typeof(clip.get("frames")) == TYPE_ARRAY and clip["frames"].size() >= 2


static func _usable(look) -> bool:
	if typeof(look) != TYPE_DICTIONARY or typeof(look.get("grid")) != TYPE_ARRAY:
		return false
	if typeof(look.get("yaw")) != TYPE_ARRAY or look["yaw"].size() != 2 or typeof(look.get("pitch")) != TYPE_ARRAY or look["pitch"].size() != 2:
		return false
	var columns := int(look.get("columns", 0))
	var rows := int(look.get("rows", 0))
	return columns >= 1 and rows >= 1 and look["grid"].size() >= columns * rows


## Which saved item has this name: [kind, index].
func _find_saved(saved_name: String) -> Array:
	var wanted := saved_name.to_lower()
	if wanted.is_empty():
		return [Saved.NONE, 0]
	var poses := _saved("poses")
	for i in poses.size():
		if str(poses[i].get("name", "")).to_lower() == wanted:
			return [Saved.POSE, i]
	var clips := _saved("clips")
	for i in clips.size():
		if _playable(clips[i]) and str(clips[i].get("name", "")).to_lower() == wanted:
			return [Saved.ANIMATION, i]
	var looks := _saved("looks")
	for i in looks.size():
		if _usable(looks[i]) and str(looks[i].get("name", "")).to_lower() == wanted:
			return [Saved.LOOK, i]
	return [Saved.NONE, 0]


func _begin(kind: int, index: int, from: Array) -> void:
	if kind == Saved.ANIMATION:
		# an animation that plays once goes back to whatever was shown before it
		if _shown != Saved.ANIMATION:
			_back = _shown
			_back_index = _shown_index
		_clip_time = 0.0
		_clip_frame = 0
	_blend_from = from
	_blend = 0.0 if blend_time > 0.0 else 1.0
	_shown = kind
	_shown_index = index


## The arm as the animation has it right now, as turns from rest: where a blend to something new starts.
func _capture(skeleton: Skeleton3D) -> Array:
	var s := _last.duplicate()
	if _upper < 0 or _fore < 0:
		return s
	s[0] = (skeleton.get_bone_global_pose(_upper).basis.get_rotation_quaternion() * _upper_rest.inverse()).normalized()
	s[1] = (skeleton.get_bone_global_pose(_fore).basis.get_rotation_quaternion() * _fore_rest.inverse()).normalized()
	s[2] = (skeleton.get_bone_global_pose(_hand).basis.get_rotation_quaternion() * _hand_rest.inverse()).normalized()
	s[5] = _two_hands and _upper2 >= 0 and _fore2 >= 0
	if s[5]:
		s[3] = (skeleton.get_bone_global_pose(_upper2).basis.get_rotation_quaternion() * _upper2_rest.inverse()).normalized()
		s[4] = (skeleton.get_bone_global_pose(_fore2).basis.get_rotation_quaternion() * _fore2_rest.inverse()).normalized()
	return s


static func _quat(a) -> Quaternion:
	if a == null or a.size() < 4:
		return Quaternion.IDENTITY
	return Quaternion(a[0], a[1], a[2], a[3]).normalized()


static func _vec(a) -> Vector3:
	if a == null or a.size() < 3:
		return Vector3.ZERO
	return Vector3(a[0], a[1], a[2])


## An exported rotation, as a rotation in this skeleton's space.
func _turn(a) -> Quaternion:
	return (_fit * _quat(a) * _fit.inverse()).normalized()


## An exported point, as a point in this skeleton's space.
func _point(a) -> Vector3:
	return _fit * ((_vec(a) - _exported_centre) * _unit) + _scene_centre


static func _loose(bone_name: String) -> String:
	var out := ""
	for c in bone_name.to_lower():
		if (c >= "a" and c <= "z") or (c >= "0" and c <= "9"):
			out += c
	return out


## Importers disagree about punctuation in bone names ("mixamorig:RightHand",
## "mixamorig_RightHand", "mixamorigRightHand"), so a name that is not found
## exactly is looked for again with only its letters and digits.
func _find(skeleton: Skeleton3D, bone_name: String) -> int:
	if bone_name.is_empty():
		return -1
	var bone := skeleton.find_bone(bone_name)
	if bone >= 0:
		return bone
	var wanted := _loose(bone_name)
	for i in skeleton.get_bone_count():
		if _loose(skeleton.get_bone_name(i)) == wanted:
			return i
	return -1


func _rest_rotation(skeleton: Skeleton3D, bone: int) -> Quaternion:
	return skeleton.get_bone_global_rest(bone).basis.get_rotation_quaternion()


func _depth(skeleton: Skeleton3D, bone: int) -> int:
	var depth := 0
	var at := skeleton.get_bone_parent(bone)
	while at >= 0:
		depth += 1
		at = skeleton.get_bone_parent(at)
	return depth


func _load(skeleton: Skeleton3D) -> void:
	_loaded = true
	_ok = false
	_has_object = false
	if pose == null or typeof(pose.data) != TYPE_DICTIONARY:
		return
	var data: Dictionary = pose.data
	if not data.has("bones") or not data.has("handBone"):
		push_warning("HandholdGrip: this file is not a Handhold pose.")
		return
	_hand = _find(skeleton, str(data["handBone"]))
	if _hand < 0:
		push_warning("HandholdGrip: hand bone '%s' not found in this skeleton." % str(data["handBone"]))
		return
	_line_up(skeleton, data)
	_hand_rest = _rest_rotation(skeleton, _hand)

	var fingers := _load_fingers(skeleton, data["bones"], _hand_rest)
	_fingers = fingers[0]
	_finger_in_hand = fingers[1]

	# Arm
	_arm = {}
	_upper = -1
	_fore = -1
	if data.get("arm") != null and typeof(data["arm"]) == TYPE_DICTIONARY:
		_arm = data["arm"]
		_upper = _find(skeleton, str(_arm.get("upperArm", "")))
		_fore = _find(skeleton, str(_arm.get("forearm", "")))
		if _upper >= 0 and _fore >= 0:
			_upper_rest = _rest_rotation(skeleton, _upper)
			_fore_rest = _rest_rotation(skeleton, _fore)
		else:
			_upper = -1
			_fore = -1

	# Second hand: its fingers, its arm, and where it holds on relative to the first hand
	_two_hands = false
	_hand2 = -1
	_upper2 = -1
	_fore2 = -1
	_fingers2 = []
	_finger_in_hand2 = []
	_arm2 = {}
	_bend_hint = (_fit * Vector3.BACK).normalized()   # glTF characters face +Z
	var second = data.get("secondHand")
	if second != null and typeof(second) == TYPE_DICTIONARY and second.get("reach") != null:
		_hand2 = _find(skeleton, str(second.get("handBone", "")))
		if _hand2 >= 0:
			_hand2_rest = _rest_rotation(skeleton, _hand2)
			var fingers2 := _load_fingers(skeleton, second.get("bones", []), _hand2_rest)
			_fingers2 = fingers2[0]
			_finger_in_hand2 = fingers2[1]
			if second.get("arm") != null and typeof(second["arm"]) == TYPE_DICTIONARY:
				_arm2 = second["arm"]
				_upper2 = _find(skeleton, str(_arm2.get("upperArm", "")))
				_fore2 = _find(skeleton, str(_arm2.get("forearm", "")))
				if _upper2 >= 0 and _fore2 >= 0:
					_upper2_rest = _rest_rotation(skeleton, _upper2)
					_fore2_rest = _rest_rotation(skeleton, _fore2)
				else:
					_upper2 = -1
					_fore2 = -1
			_reach_point = _point(second["reach"].get("position"))
			_reach_turn = _turn(second["reach"].get("delta")) * _hand2_rest
			_two_hands = true
		else:
			push_warning("HandholdGrip: second hand bone '%s' not found; holding with one hand." % str(second.get("handBone", "")))
	_sweep_now = sweep
	_pitch_now = 0.0
	_yaw_now = 0.0
	_shown = Saved.NONE
	_back = Saved.NONE
	_blend = 1.0
	_last = [Quaternion.IDENTITY, Quaternion.IDENTITY, Quaternion.IDENTITY, Quaternion.IDENTITY, Quaternion.IDENTITY, false, 0.0]
	_blend_from = _last
	_placed = false
	# the way the character stands and faces, for measuring where the camera looks
	_upright = (_fit * Vector3.UP).normalized()
	_front = _bend_hint
	var forward = _arm.get("forward")
	if typeof(forward) == TYPE_ARRAY and forward.size() == 3:
		var facing: Vector3 = _fit * _vec(forward)
		facing -= _upright * facing.dot(_upright)
		if facing.length_squared() > 1e-8:
			_front = facing.normalized()

	# Prop: where it sat in the model's space while the hand was at rest, re-expressed relative to the hand bone.
	var at_rest = data.get("objectAtRest")
	if held_object != null and at_rest != null and typeof(at_rest) == TYPE_DICTIONARY:
		var extra := Quaternion.from_euler(held_object_turn * (PI / 180.0))
		var turned := (_fit * _quat(at_rest.get("quaternion")) * extra).normalized()
		var object_rest := Transform3D(Basis(turned), _point(at_rest.get("position")))
		var hand_rest := Transform3D(Basis(_hand_rest), skeleton.get_bone_global_rest(_hand).origin)
		_object_in_hand = hand_rest.affine_inverse() * object_rest
		_object_scale = held_object.global_basis.get_scale()
		_has_object = true
	_ok = true

	# start with what was asked for; failing that, a file exported to follow the camera starts with its look
	var blend_was := blend_time
	blend_time = 0.0
	if not start_with.is_empty():
		if not show_saved(start_with):
			push_warning("HandholdGrip: nothing saved is called '%s'. This file has: %s." % [start_with, ", ".join(saved_names())])
	elif arm_mode == ArmMode.FROM_EXPORT and _mode() == ArmMode.FOLLOW_CAMERA:
		var looks := _saved("looks")
		if looks.size() > 0 and _usable(looks[0]):
			show_saved(str(looks[0].get("name", "")))
	blend_time = blend_was


## Fingers: the exported turn from rest, applied to this skeleton's own rest pose,
## then stored relative to the hand so the grip follows the hand wherever the arm goes.
## Returns [bones, rotations], parents before children.
func _load_fingers(skeleton: Skeleton3D, entries, hand_rest: Quaternion) -> Array:
	var found: Array = []
	if entries != null:
		for entry in entries:
			var bone := _find(skeleton, str(entry["name"]))
			if bone < 0:
				push_warning("HandholdGrip: finger bone '%s' not found; skipped." % str(entry["name"]))
				continue
			var gripped := _turn(entry["delta"]) * _rest_rotation(skeleton, bone)
			found.append({"bone": bone, "depth": _depth(skeleton, bone), "rotation": hand_rest.inverse() * gripped})
	found.sort_custom(func(a, b): return a["depth"] < b["depth"])
	var bones: Array = []
	var rotations: Array = []
	for entry in found:
		bones.append(entry["bone"])
		rotations.append(entry["rotation"])
	return [bones, rotations]


## Finds the turn and scale that carry the exported rest skeleton onto this one.
func _line_up(skeleton: Skeleton3D, data: Dictionary) -> void:
	_fit = Quaternion.IDENTITY
	_unit = 1.0
	_exported_centre = Vector3.ZERO
	_scene_centre = Vector3.ZERO
	var a: Array = []
	var b: Array = []
	for entry in data.get("restPoints", []):
		var bone := _find(skeleton, str(entry["name"]))
		if bone < 0:
			continue
		a.append(_vec(entry["position"]))
		b.append(skeleton.get_bone_global_rest(bone).origin)
	if a.size() < 3:
		push_warning("HandholdGrip: too few bones to line the export up with this skeleton; assuming the same axes and units.")
		return
	var ca := Vector3.ZERO
	var cb := Vector3.ZERO
	for i in a.size():
		ca += a[i]
		cb += b[i]
	ca /= float(a.size())
	cb /= float(b.size())
	var spread_a := 0.0
	var spread_b := 0.0
	var s: Array = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
	for i in a.size():
		var p: Vector3 = a[i] - ca
		var q: Vector3 = b[i] - cb
		spread_a += p.length_squared()
		spread_b += q.length_squared()
		for r in 3:
			for c in 3:
				s[r * 3 + c] += p[r] * q[c]
	if spread_a < 1e-12 or spread_b < 1e-12:
		return
	_exported_centre = ca
	_scene_centre = cb
	_unit = sqrt(spread_b / spread_a)
	_fit = _best_rotation(s)


## Horn's closed-form answer to "which rotation best carries one set of points onto another":
## the quaternion is the leading eigenvector of a 4x4 matrix built from the points' cross-covariance.
static func _best_rotation(s: Array) -> Quaternion:
	var sxx: float = s[0]
	var sxy: float = s[1]
	var sxz: float = s[2]
	var syx: float = s[3]
	var syy: float = s[4]
	var syz: float = s[5]
	var szx: float = s[6]
	var szy: float = s[7]
	var szz: float = s[8]
	var n: Array = [
		sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
		syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
		szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
		sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
	]
	# shift so every eigenvalue is positive, then square the matrix repeatedly:
	# what survives is the leading eigenvector, in every column
	var norm := 0.0
	for v in n:
		norm += v * v
	norm = sqrt(norm)
	if norm < 1e-30:
		return Quaternion.IDENTITY
	for i in 4:
		n[i * 4 + i] += norm
	for _pass in 24:
		var m: Array = []
		m.resize(16)
		var biggest := 0.0
		for r in 4:
			for c in 4:
				var v := 0.0
				for k in 4:
					v += n[r * 4 + k] * n[k * 4 + c]
				m[r * 4 + c] = v
				biggest = maxf(biggest, absf(v))
		for i in 16:
			n[i] = m[i] / biggest
	var best := 0
	var best_length := -1.0
	for c in 4:
		var length := 0.0
		for r in 4:
			length += n[r * 4 + c] * n[r * 4 + c]
		if length > best_length:
			best_length = length
			best = c
	# rows are (w, x, y, z)
	return Quaternion(n[4 + best], n[8 + best], n[12 + best], n[best]).normalized()


func _mode() -> ArmMode:
	if arm_mode != ArmMode.FROM_EXPORT:
		return arm_mode
	var chosen := str(_arm.get("mode", "animation"))
	if chosen == "hold":
		return ArmMode.HOLD
	if chosen == "camera":
		return ArmMode.FOLLOW_CAMERA
	return ArmMode.ANIMATION


## An arm's three exported rotations (upper arm, forearm, hand) at a point along the sweep.
func _sample_arm(arm: Dictionary, t: float) -> Array:
	var keys = arm.get("sweep", [])
	if keys != null and keys.size() >= 2:
		t = clampf(t, 0.0, 1.0)
		var i := 0
		while i < keys.size() - 2 and float(keys[i + 1]["t"]) < t:
			i += 1
		var k0: Dictionary = keys[i]
		var k1: Dictionary = keys[i + 1]
		var span := float(k1["t"]) - float(k0["t"])
		var w := 0.0
		if span > 1e-9:
			w = clampf((t - float(k0["t"])) / span, 0.0, 1.0)
		return [
			_turn(k0["upperArm"]).slerp(_turn(k1["upperArm"]), w),
			_turn(k0["forearm"]).slerp(_turn(k1["forearm"]), w),
			_turn(k0["hand"]).slerp(_turn(k1["hand"]), w),
		]
	var hold = arm.get("hold", {})
	if hold == null:
		hold = {}
	return [_turn(hold.get("upperArm")), _turn(hold.get("forearm")), _turn(hold.get("hand"))]


## Turns one bone to a rotation given in the skeleton's space, blended over the current pose.
func _set_rotation(skeleton: Skeleton3D, bone: int, target: Quaternion, weight: float) -> void:
	var parent := skeleton.get_bone_parent(bone)
	var parent_rotation := Quaternion.IDENTITY
	if parent >= 0:
		parent_rotation = skeleton.get_bone_global_pose(parent).basis.get_rotation_quaternion()
	var local := (parent_rotation.inverse() * target).normalized()
	if weight < 1.0:
		local = skeleton.get_bone_pose_rotation(bone).normalized().slerp(local, weight)
	skeleton.set_bone_pose_rotation(bone, local)


## Where the second hand bone belongs now (skeleton space): wherever the first hand has carried the object.
func _second_goal(skeleton: Skeleton3D) -> Transform3D:
	var first := skeleton.get_bone_global_pose(_hand)
	var carry := (first.basis.get_rotation_quaternion() * _hand_rest.inverse()).normalized()
	var at := first.origin + carry * (_reach_point - skeleton.get_bone_global_rest(_hand).origin)
	return Transform3D(Basis((carry * _reach_turn).normalized()), at)


## Bends the second elbow so the hand is as far from the shoulder as the target, then swings
## the upper arm so the hand lands on it. Keeps the elbow on the side it already bends to.
func _reach_for(skeleton: Skeleton3D, target: Vector3) -> void:
	var a := skeleton.get_bone_global_pose(_upper2).origin
	var b := skeleton.get_bone_global_pose(_fore2).origin
	var c := skeleton.get_bone_global_pose(_hand2).origin
	var lab := a.distance_to(b)
	var lbc := b.distance_to(c)
	if lab < 1e-6 or lbc < 1e-6:
		return
	var lat := clampf(a.distance_to(target), absf(lab - lbc) + 1e-4, lab + lbc - 1e-4)
	var n := (a - b).cross(c - b)
	if n.length_squared() < 1e-6 * lab * lab * lbc * lbc:
		n = (a - b).cross(_bend_hint)   # straight arm: bend the elbow back
	if n.length_squared() < 1e-12:
		return
	n = n.normalized()
	var now := (a - b).angle_to(c - b)
	var want := acos(clampf((lab * lab + lbc * lbc - lat * lat) / (2.0 * lab * lbc), -1.0, 1.0))
	var fore_now := skeleton.get_bone_global_pose(_fore2).basis.get_rotation_quaternion()
	_set_rotation(skeleton, _fore2, Quaternion(n, want - now) * fore_now, 1.0)
	var from := skeleton.get_bone_global_pose(_hand2).origin - a
	var to := target - a
	if from.length_squared() < 1e-12 or to.length_squared() < 1e-12:
		return
	var upper_now := skeleton.get_bone_global_pose(_upper2).basis.get_rotation_quaternion()
	_set_rotation(skeleton, _upper2, Quaternion(from.normalized(), to.normalized()) * upper_now, 1.0)


## The exported arm pose gives the second elbow a natural start, and a reach closes whatever gap is left.
func _place_second_hand(skeleton: Skeleton3D, arm_placed: bool, s: Array, weight: float, w: float) -> void:
	if _upper2 >= 0 and _fore2 >= 0 and arm_placed and s[5]:
		_set_rotation(skeleton, _upper2, s[3] * _upper2_rest, weight * w)
		_set_rotation(skeleton, _fore2, s[4] * _fore2_rest, weight * w)
	var goal := _second_goal(skeleton)
	if _upper2 >= 0 and _fore2 >= 0:
		var now := skeleton.get_bone_global_pose(_hand2).origin
		_reach_for(skeleton, now.lerp(goal.origin, w))
	_set_rotation(skeleton, _hand2, goal.basis.get_rotation_quaternion(), w)


## How far (in skeleton units) the second hand is from its spot on the object. 0 when it reaches.
func second_hand_gap() -> float:
	var skeleton := get_skeleton()
	if skeleton == null or not has_second_hand():
		return 0.0
	return skeleton.get_bone_global_pose(_hand2).origin.distance_to(_second_goal(skeleton).origin)


## One saved arm position (a pose, a frame of an animation, a point of a look) as an arm position.
func _sample(entry: Dictionary, away: float) -> Array:
	var second = entry.get("second")
	var has: bool = typeof(second) == TYPE_DICTIONARY and second.get("upperArm") != null and second.get("forearm") != null
	return [
		_turn(entry.get("upperArm")), _turn(entry.get("forearm")), _turn(entry.get("hand")),
		_turn(second.get("upperArm")) if has else Quaternion.IDENTITY,
		_turn(second.get("forearm")) if has else Quaternion.IDENTITY,
		has, away,
	]


static func _mix(a: Array, b: Array, t: float) -> Array:
	var both: bool = a[5] and b[5]
	return [
		a[0].slerp(b[0], t), a[1].slerp(b[1], t), a[2].slerp(b[2], t),
		a[3].slerp(b[3], t) if both else (b[3] if b[5] else a[3]),
		a[4].slerp(b[4], t) if both else (b[4] if b[5] else a[4]),
		a[5] or b[5],
		lerpf(a[6], b[6], t),
	]


static func _number(value, fallback: float) -> float:
	return float(value) if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT else fallback


func _sample_clip(clip: Dictionary, time: float) -> Array:
	var frames: Array = clip["frames"]
	var i := clampi(_clip_frame, 0, frames.size() - 2)
	while i < frames.size() - 2 and _number(frames[i + 1].get("t"), 0.0) <= time:
		i += 1
	while i > 0 and _number(frames[i].get("t"), 0.0) > time:
		i -= 1
	_clip_frame = i
	var k0: Dictionary = frames[i]
	var k1: Dictionary = frames[i + 1]
	var t0 := _number(k0.get("t"), 0.0)
	var span := _number(k1.get("t"), 0.0) - t0
	var w := clampf((time - t0) / span, 0.0, 1.0) if span > 1e-9 else 0.0
	return _mix(_sample(k0, _number(k0.get("away"), 0.0)), _sample(k1, _number(k1.get("away"), 0.0)), w)


## Which two rows (or columns) of a look's grid a value falls between, and how far along: [first, second, weight].
static func _between(from: float, to: float, value: float, count: int) -> Array:
	if count < 2:
		return [0, 0, 0.0]
	var at := 0.0
	if absf(to - from) > 1e-9:
		at = clampf((value - from) / (to - from), 0.0, 1.0) * (count - 1)
	var first := mini(int(at), count - 2)
	return [first, first + 1, at - first]


## A look is a grid of arm positions over the view's yaw (left to right) and pitch (down to up).
func _sample_look(look: Dictionary, yaw: float, pitch: float) -> Array:
	var columns := int(look["columns"])
	var rows := int(look["rows"])
	var grid: Array = look["grid"]
	var x := _between(_number(look["yaw"][0], 0.0), _number(look["yaw"][1], 0.0), yaw, columns)
	var y := _between(_number(look["pitch"][0], 0.0), _number(look["pitch"][1], 0.0), pitch, rows)
	var c0: int = x[0]
	var c1: int = x[1]
	var r0: int = y[0]
	var r1: int = y[1]
	var low := _mix(_sample(grid[r0 * columns + c0], 0.0), _sample(grid[r0 * columns + c1], 0.0), x[2])
	var high := _mix(_sample(grid[r1 * columns + c0], 0.0), _sample(grid[r1 * columns + c1], 0.0), x[2])
	return _mix(low, high, y[2])


## Reads where the camera looks: pitch above the plane that `up` stands on, yaw to the right of
## `facing` (all in the skeleton's space). Returns the camera's right, laid flat on that plane.
func _read_aim(skeleton: Skeleton3D, up: Vector3, facing: Vector3) -> Vector3:
	var aim: Node3D = aim_source
	if aim == null and get_viewport() != null:
		aim = get_viewport().get_camera_3d()
	var yaw := 0.0
	var pitch := 0.0
	var across := Vector3.RIGHT
	if aim != null:
		var to_skeleton := skeleton.global_transform.basis.orthonormalized().inverse()
		var look: Vector3 = to_skeleton * (-aim.global_transform.basis.z)
		var rise := look.dot(up)
		var flat := look - up * rise
		pitch = rad_to_deg(atan2(rise, flat.length()))
		if flat.length_squared() > 1e-8:
			# a turn to the character's right is a negative turn about its up axis
			yaw = -rad_to_deg(facing.signed_angle_to(flat, up))
		across = to_skeleton * aim.global_transform.basis.x
		across -= up * across.dot(up)
		across = across.normalized() if across.length_squared() > 1e-8 else Vector3.RIGHT
	var follow := 1.0
	if aim_smoothing > 0.0:
		follow = 1.0 - exp(-get_process_delta_time() / aim_smoothing)
	_pitch_now = lerpf(_pitch_now, pitch, follow)
	_yaw_now = rad_to_deg(lerp_angle(deg_to_rad(_yaw_now), deg_to_rad(yaw), follow))
	return across


## The arm position that arm_mode asks for when nothing saved is shown.
func _from_mode(skeleton: Skeleton3D, mode: ArmMode) -> Array:
	var swing := Quaternion.IDENTITY
	var keys = _arm.get("sweep", [])
	var has_sweep: bool = keys != null and keys.size() >= 2
	if mode == ArmMode.FOLLOW_CAMERA:
		# measured against the skeleton's own horizon
		var across := _read_aim(skeleton, Vector3.UP, Vector3.BACK)
		var pitch := clampf(_pitch_now, minf(aim_down, aim_up), maxf(aim_down, aim_up))
		if has_sweep:
			_sweep_now = inverse_lerp(aim_down, aim_up, pitch)
		else:
			# no sweep was marked: swing the held pose at the shoulder
			swing = Quaternion(across, deg_to_rad(pitch))
	else:
		_sweep_now = sweep
	var arm := _sample_arm(_arm, _sweep_now)
	var s: Array = [swing * arm[0], swing * arm[1], swing * arm[2], Quaternion.IDENTITY, Quaternion.IDENTITY, false, 0.0]
	if _two_hands and _arm2.get("hold") != null:
		var arm2 := _sample_arm(_arm2, _sweep_now)
		s[3] = swing * arm2[0]
		s[4] = swing * arm2[1]
		s[5] = true
	return s


## The arm position to aim for on this frame.
func _target(skeleton: Skeleton3D, mode: ArmMode) -> Array:
	if _shown == Saved.POSE:
		return _sample(_saved("poses")[_shown_index], 0.0)
	if _shown == Saved.ANIMATION:
		var clip: Dictionary = _saved("clips")[_shown_index]
		var frames: Array = clip["frames"]
		var length := _number(frames[frames.size() - 1].get("t"), 0.0)
		_clip_time += get_process_delta_time()
		if _clip_time < length:
			return _sample_clip(clip, _clip_time)
		if bool(clip.get("loops", false)) and length > 0.0:
			_clip_time = fmod(_clip_time, length)
			return _sample_clip(clip, _clip_time)
		# it has played once: hold its last frame now, and blend back from it
		var end := _sample_clip(clip, length)
		_begin(_back, _back_index, end)
		finished.emit(str(clip.get("name", "")))
		return end
	if _shown == Saved.LOOK:
		# a look is measured from the way the character itself stands and faces
		_read_aim(skeleton, _upright, _front)
		return _sample_look(_saved("looks")[_shown_index], _yaw_now, _pitch_now)
	return _from_mode(skeleton, mode)


func _process_modification() -> void:
	var skeleton := get_skeleton()
	if skeleton == null:
		return
	if not _loaded:
		_load(skeleton)
	if not _ok:
		return

	var mode := _mode()
	var arm_placed := false
	var weight := arm_weight
	var s: Array = _last
	if _upper >= 0 and _fore >= 0 and arm_weight > 0.0:
		# the arm is ours while something saved is shown, or while arm_mode places it
		var ours: bool = _shown != Saved.NONE or mode != ArmMode.ANIMATION
		if _blend_from.is_empty():
			# something new was asked for since the last frame: blend to it from where the arm is
			_blend_from = _last if _placed else _capture(skeleton)
		var blending := _blend < 1.0
		if ours:
			s = _target(skeleton, mode)
		if blending:
			_blend = minf(1.0, _blend + get_process_delta_time() / blend_time) if blend_time > 0.0 else 1.0
			var k := _blend * _blend * (3.0 - 2.0 * _blend)
			if ours:
				s = _mix(_blend_from, s, k)
			else:
				# handing the arm back to your animation
				s = _blend_from
				weight *= 1.0 - k
		if ours or blending:
			_set_rotation(skeleton, _upper, s[0] * _upper_rest, weight)
			_set_rotation(skeleton, _fore, s[1] * _fore_rest, weight)
			_set_rotation(skeleton, _hand, s[2] * _hand_rest, weight)
			arm_placed = true
			_last = s
	_placed = arm_placed

	# a saved animation can have the second hand let go for a while (a reload, say)
	var hold_on := second_hand_weight
	if arm_placed:
		hold_on *= 1.0 - clampf(s[6], 0.0, 1.0)
	if _two_hands and hold_on > 0.0:
		_place_second_hand(skeleton, arm_placed, s, weight, hold_on)

	if grip > 0.0:
		for i in _fingers.size():
			var hand_now := skeleton.get_bone_global_pose(_hand).basis.get_rotation_quaternion()
			_set_rotation(skeleton, _fingers[i], hand_now * _finger_in_hand[i], grip)
		if _two_hands:
			for i in _fingers2.size():
				var hand2_now := skeleton.get_bone_global_pose(_hand2).basis.get_rotation_quaternion()
				_set_rotation(skeleton, _fingers2[i], hand2_now * _finger_in_hand2[i], grip * hold_on)

	if _has_object and held_object != null and is_instance_valid(held_object):
		var hand_pose := skeleton.get_bone_global_pose(_hand)
		var hand_now := Transform3D(Basis(hand_pose.basis.get_rotation_quaternion()), hand_pose.origin)
		var placed := skeleton.global_transform * hand_now * _object_in_hand
		held_object.global_position = placed.origin
		held_object.global_basis = Basis(placed.basis.get_rotation_quaternion()).scaled(_object_scale)
