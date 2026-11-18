# The pose file

Every export carries the same data: a `.pose.json` with `"format": "handhold-pose"`. The Unity, Godot and Blender scripts all read it, and you can read it yourself to drive another engine or your own IK.

## Why it lines up whatever the importer does

Every engine and importer picks its own axes, units and spelling of bone names. The pose file therefore says, for each bone, how far it turns from rest **in the model's own space**, and lists where every bone it names sits at rest. A reader lines those rest positions up with the same bones in its scene, which gives the turn and scale between the two, and matches names on letters and digits only (`mixamorig:RightHand`, `mixamorig_RightHand` and `mixamorigRightHand` are the same bone).

The space is right-handed with Y up, as in glTF. Quaternions are `[x, y, z, w]`.

## Top level

| Field | Meaning |
|---|---|
| `format`, `version` | `"handhold-pose"` and the format version, currently 3 |
| `skeleton` | `"original"` when the grip is on the model's own bones, `"handhold"` when it is on the bones Handhold made for a mesh that had none |
| `handedness` | `"left"` or `"right"` |
| `object` | The prop's name |
| `stable` | Whether the grip holds |
| `gripForcePerWeight` | The squeeze needed, as a multiple of the prop's weight |
| `handBone` | The hand bone's name, as the file had it |
| `bones` | Each finger bone: `name`, `restQuaternion`, `quaternion` (local) and `delta`, its turn from rest in the model's space |
| `restPoints` | The rest position of every bone named anywhere in the file |
| `objectAtRest` | Where the prop sits in the model's space while the hand is at rest: `position`, `quaternion`, `scale` |
| `objectInHandBone` | The same, relative to the hand bone |
| `fingerSegmentsTouching`, `fingerSegments` | How much of the fingers is on the prop |
| `arm` | The arm, described below. Null for a bare hand |
| `secondHand` | The second hand of a two-handed grip, otherwise null |

## `arm`

| Field | Meaning |
|---|---|
| `upperArm`, `forearm`, `hand` | Bone names |
| `mode` | `animation`, `hold` or `camera`: what the arm does while nothing saved is shown |
| `forward` | The way the character faces, in the model's space |
| `hold` | The hold position, as three turns from rest: `upperArm`, `forearm`, `hand` |
| `sweep` | 13 points along the sweep marked in the Arm step, or empty |
| `poses` | Saved poses |
| `clips` | Saved animations |
| `looks` | Saved looks |

Every arm position in the file has the same shape: `upperArm`, `forearm` and `hand`, each a turn from rest in the model's space. For a two-handed grip it also has `second`, the same three turns for the other arm.

### `poses`

```json
{ "name": "Raised", "upperArm": [x, y, z, w], "forearm": [x, y, z, w], "hand": [x, y, z, w] }
```

### `clips`

```json
{
  "name": "Swing",
  "fps": 30,
  "duration": 1.0,
  "loops": false,
  "frames": [{ "t": 0.0, "away": 0, "upperArm": [...], "forearm": [...], "hand": [...] }]
}
```

`t` is the time in seconds. `away` runs from 0 to 1 and says how far the second hand has let go at that frame, for a reload or for turning the item over.

### `looks`

```json
{
  "name": "Look",
  "yaw": [-45, 45],
  "pitch": [-40, 50],
  "columns": 5,
  "rows": 5,
  "grid": [{ "yaw": -45, "pitch": -40, "upperArm": [...], "forearm": [...], "hand": [...] }]
}
```

A look is a grid of arm positions over the direction the player looks. `yaw` is degrees to the player's left (negative) and right (positive); `pitch` is degrees down (negative) and up (positive). The grid is stored row by row, lowest pitch first, each row running from left to right. To read it at a direction, clamp to the ranges, find the four entries around it and blend between them.

## `secondHand`

| Field | Meaning |
|---|---|
| `handBone`, `bones` | As at the top level, for the second hand |
| `arm` | As above, without `mode` and the saved items |
| `reach` | Where its hand bone is, and its turn from rest, while the first hand bone is at rest. Carry it along with the first hand to find where the second hand belongs |
| `handBoneInObject` | Its hand bone in the prop's own space, for an engine's own IK |

## The GLB

The posed `.glb` holds the same things as animations on the model's bones:

| Animation | What it is |
|---|---|
| `Grip` | From the rest pose to the grip |
| `Sweep` | Along the sweep, if one was marked |
| One per saved pose and animation | Under the name it was saved with |
| Two per look | `<name> Down-Up` and `<name> Left-Right`, with straight ahead in the middle |

Animations are sampled at 30 frames a second, so they import into any program that reads glTF.
