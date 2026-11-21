# Handhold in Unreal

There is no Unreal plugin to install. The `.glb` download carries the grip and every saved pose, animation and look. Unreal 5
imports it straight onto your character's own skeleton as ordinary animations, and the `.pose.json` says where the prop goes as a
socket on the hand bone.

> **Checked in Unreal 5.7** with the UE5 mannequin (Manny), headless, by `scripts/check-unreal.py`: in every animation, at its first
> and last key, all 89 bones land where the `.glb` has them and the prop on the socket lands where the `.glb` holds it, to well under
> a thousandth of a millimetre. A prop `.glb` imported as a Static Mesh keeps the file's origin and axes. Other Unreal versions have
> not been run.

## 1. Take the character and the prop out of Unreal

Handhold has to see the skeleton exactly as Unreal has it, so the animations it makes find the same bones. The surest way is to
export it from Unreal itself:

1. In the Content Browser, right-click your character's **Skeletal Mesh**, **Asset Actions > Export**, and save it as **glTF
   binary (.glb)**.
2. Do the same for the prop's **Static Mesh**. The exported file keeps the mesh's origin and axes, so the Static Mesh already in
   your project is the one that goes in the hand.

The file you first imported works too when its bone names are plain (`hand_r`, `Hand_R`). An FBX whose bones have a namespace
(`mixamorig:RightHand`) does not: Unreal drops the `mixamorig:` part when it imports an FBX, so the animations would look for
bones the skeleton does not have. Exporting from Unreal avoids that.

## 2. Make the grip

Open [Handhold](https://ozbrett.github.io/handhold/). On the **Character** tab, **Choose a character** and pick the character
`.glb`. On the **Grip** tab, under **Object**, **Choose a file** and pick the prop `.glb`, mark where the hand goes on it, and pick a
grip that **HOLDS**. Place the arm, then save what the game needs on the **Animations** tab: a pose to hold it, animations to swing or
fire it, a look for the arm to follow the camera.

Click **Export** (top right), keep **Use the skeleton my model already has** ticked, and under **Or just the files** download both
the **GLB** and the **Pose JSON**.

## 3. Import the animations onto your skeleton

Drag the `.glb` into the Content Browser. In the import dialog:

| Setting | Set it to |
|---|---|
| **Skeleton** | Your character's skeleton |
| **Import Only Animations** | On |

Unreal makes one Animation Sequence for each animation in the file, named after the file and the animation:
`knight-holding-sword.glb` gives `knight-holding-swordGrip`, `knight-holding-swordSwing`, `knight-holding-swordLook_Down-Up` and so
on. Every one but `Grip` holds the fingers in the grip from start to end, so any of them can play on its own and the hand stays closed
round the prop.

| Animation | What it is |
|---|---|
| `Grip` | From the open hand to the grip, one second |
| `Sweep` | Along the sweep marked in the Arm step, if one was |
| One per saved pose and animation | Under the name it was saved with. A pose is a still, one frame long |
| Two per look | `<name> Down-Up` and `<name> Left-Right`, one second each |

## 4. Put the prop in the hand

Open the character's Skeleton, right-click the hand bone the pose file names (`unreal.socketBone`, for Manny `hand_r`) and **Add
Socket**. Call it `Held` and copy the three values from the pose file's `unreal` block into the socket's details:

```json
"unreal": {
  "socketBone": "hand_r",
  "location": [-8.9119, 7.1635, 0.6734],
  "rotation": { "roll": 150.6743, "pitch": 42.3427, "yaw": -27.8172 },
  "scale": [1, 1, 1]
}
```

| Socket field | From |
|---|---|
| **Relative Location** X, Y, Z | `location` (centimetres) |
| **Relative Rotation** X (Roll), Y (Pitch), Z (Yaw) | `rotation.roll`, `rotation.pitch`, `rotation.yaw` (degrees) |
| **Relative Scale** | `scale` |

Right-click the socket, **Add Preview Asset**, and pick the prop's Static Mesh to see it in the hand. In the game, attach a
**Static Mesh Component** with the prop to the character's mesh with **Parent Socket** `Held`.

These values are for the prop imported from the same `.glb` you gave Handhold, which Unreal brings in with the file's own origin and
axes. A prop in several pieces comes in as several Static Meshes, all with that same origin: tick **Combine Static Meshes** in the
import dialog to get one, or attach each piece to the same socket.

## 5. Play them

**A pose or an animation.** Play it like any other Animation Sequence: as the state's animation in the Anim Blueprint, or as a
Montage (right-click the sequence, **Create > Create AnimMontage**) for a swing or a reload on a button.

**Only the arm and the hand, over the body's own animation.** In the Anim Graph, feed the body's animation into a **Layered blend per
bone** as the base pose and the Handhold animation as blend pose 0. Under **Layer Setup > Branch Filters** add `upperarm_r` (your
character's upper arm on that side) with depth 0. The legs and the body keep their animation, the arm and the fingers take
Handhold's. For the fingers only, so the arm keeps the body's animation and still holds the prop, add a filter for each finger's first
bone instead (`thumb_01_r`, `index_metacarpal_r`, `middle_metacarpal_r`, `ring_metacarpal_r`, `pinky_metacarpal_r` on Manny) and use
a saved pose.

**A look.** Its two animations are not played but scrubbed to where the player looks.

1. Put `<name> Down-Up` in a **Sequence Evaluator** and expose **Explicit Time** as a pin, fed from the view's pitch (below). That
   alone is enough when the character turns with the camera.
2. To follow left and right as well, open `<name> Left-Right` and under **Additive Settings** set **Additive Anim Type** to *Local
   Space*, **Base Pose Type** to *Selected animation frame* and **Ref Frame Index** to the frame where it looks straight ahead (the
   middle frame when left and right are the same). Put it in a second Sequence Evaluator fed from the yaw, and add it onto the first
   with **Apply Additive**.
3. Use the result as the Handhold pose in the **Layered blend per bone** above.

```
Down-Up time    = (pitch + down) / (down + up)      pitch in degrees, up is positive
Left-Right time = (yaw + left) / (left + right)     yaw in degrees, right is positive
```

`down`, `up`, `left` and `right` are the look's ranges, in the pose file under `arm.looks` (`pitch` is `[-down, up]` and `yaw` is
`[-left, right]`). Clamp both times to 0 to 1. The pitch and yaw are where the camera points against the way the character faces:
**Get Base Aim Rotation** minus **Get Actor Rotation**, then **Normalize Axis** on each.

## Two hands

A two-handed grip carries the second hand's fingers in every animation too, and its arm in the saved poses and animations. Play
them the same way; with a branch filter, add the second arm's upper arm (`upperarm_l`) as well.

## When something is off

| What you see | Why, and what to do |
|---|---|
| The import makes a new Skeleton or a Skeletal Mesh | **Skeleton** was not set to your character's, or **Import Only Animations** was off |
| The animations play but the fingers stay open | The bone names in the file are not the skeleton's. Export the character from Unreal (step 1) and make the grip again |
| The prop is in the hand but turned or off to one side | The Static Mesh did not come from the file Handhold was given (an FBX of it, say, or a mesh whose pivot was moved). Export it from Unreal as in step 1, load that in Handhold, and use the new socket values |
| The prop is the wrong size | Copy the socket's **Relative Scale** from the pose file too |

The pose file holds the same grip again for your own code or IK: see [pose-format.md](pose-format.md).
