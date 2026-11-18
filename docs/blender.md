# Handhold in Blender

Handhold gives Blender a posed hand and arm, a prop sitting in the hand, and a set of Actions you can keep working on with ordinary tools. Nothing it makes is locked: every pose and animation is plain keyframes on your own arm and finger bones.

Checked in Blender 5.1.

## The short version

1. In Handhold, load your character and the prop, mark where the hand holds on, and pick a grip.
2. On the **Animations** tab, add the poses, animations and looks you want.
3. Press **Export > Blender** and unpack the zip.
4. In Blender, select your character's armature, open the `.py` in the Scripting tab and press **Run Script**.

Your character is now holding the prop, and everything you saved is in the Action Editor.

## Getting your character into Handhold

Export it from Blender as a single `.glb` (**File > Export > glTF 2.0**), with the hands open and the fingers apart, as in a T-pose or A-pose. FBX, OBJ, STL and PLY load as well. The prop is loaded the same way.

Use the same character in Blender afterwards. The script finds bones by name, ignoring case and punctuation, so `mixamorig:RightHand`, `mixamorig_RightHand` and `mixamorigRightHand` are the same bone. It does not matter how the character was imported, which way it faces or what scale it has.

## What is in the zip

| File | What it is |
|---|---|
| `apply_<name>.py` | The script. The pose travels inside it, so it is the only file you need |
| `<name>.glb` | The model already posed and holding the prop, with every animation |
| `README.txt` | These steps in brief |

There are two ways to use it.

### A character already in your scene

1. Select the armature. To put the prop in the hand as well, select the prop too, with the armature as the active object (click it last).
2. **Scripting** tab > **Text > Open** > `apply_<name>.py`, then **Run Script**.

The script:

- turns the finger bones into the grip and places the arm, keyed at the current frame;
- parents the prop to the hand bone at the right offset;
- adds an Action for everything saved on the Animations tab, then puts back the Action you had assigned;
- touches only the arm and finger bones. The rest of the rig stays as it was.

Run it again after changing something in Handhold and the Actions it made are replaced.

### A new model

**File > Import > glTF 2.0** and choose the `.glb`. The model arrives posed and holding the prop, with the animations as Actions.

## Where your poses and animations are

Open **Dope Sheet**, switch its mode to **Action Editor**, and pick from the Action list. Each Action is named after the prop, so a torch gives `Torch Raised`, `Torch Swing` and so on.

| Saved in Handhold | In Blender |
|---|---|
| Pose | An Action with one keyframe. It is also marked as a pose asset, so it is in the Pose Library: the asset shelf in Pose Mode, and the Asset Browser under Current File. Click a pose to apply it, drag to blend into it |
| Animation | An Action keyed from frame 1 at the scene's frame rate, with its frame range set. A looping one is marked cyclic |
| Look | Two Actions, `<name> Down-Up` and `<name> Left-Right`, 24 frames each, with straight ahead on the middle frame |

Every Action has a fake user, so it stays in the file while nothing uses it. Push one down to an NLA strip to layer it with a walk or an idle.

The two Actions of a look are source material for an aim offset or blend space in a game engine: Down-Up drives one axis and Left-Right the other. Scrub them to see how the arm follows the view.

## Settings

The top of the script has a few settings. Change them before pressing Run Script.

| Setting | Default | What it does |
|---|---|---|
| `KEYFRAME` | `True` | Key the pose at the current frame |
| `APPLY_ARM` | `None` | `None` places the arm if the export asked for it. `True` or `False` forces it |
| `SWEEP_FRAMES` | `24` | Length of the keyed sweep, if one was marked in the Arm step. 0 leaves it out |
| `PROP_TURN` | `(0, 0, 0)` | Extra turn for the prop in degrees, if its model uses different axes |
| `SAVED_ACTIONS` | `True` | Add the saved poses, animations and looks as Actions |
| `ACTION_PREFIX` | `None` | What the Action names start with. `None` uses the prop's name |
| `POSE_ASSETS` | `True` | Mark saved poses as pose assets |
| `LOOK_FRAMES` | `24` | Length of each of a look's two Actions |

## Carrying on from here

- The fingers are keyed bone by bone, so you can loosen one finger or tighten the thumb by hand and key it again.
- An animation from Handhold moves the arm and hand only. The character stays on the spot, so it layers over your own body animation.
- For a two-handed prop, both arms are posed and keyed. In an animation where the second hand lets go (a reload, turning the item over), its fingers open and close with it.
- To send the result on to a game engine, export from Blender as you normally would. The Actions are ordinary ones.
