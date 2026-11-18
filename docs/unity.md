# Handhold in Unity

The Unity download is a `.unitypackage`. It works on a character that is already in your project, with its own bones and its own animations.

Checked in Unity 6000.6.

## Add a grip to a character

1. Drag the `.unitypackage` into the Project window and press **Import**. It adds `Assets/Handhold` with the `HandholdGrip` component, a menu command and the pose file.
2. Select your character in the scene. To put a prop in its hand, Ctrl-click the prop as well.
3. Choose **Tools > Handhold > Add grip to selected character**, then press Play.

The menu command adds a `HandholdGrip` component to the character and gives it the newest pose in the project. Import a second grip and the two scripts are replaced, not duplicated.

The component runs in `LateUpdate`, after the Animator, so it sits on top of whatever animation is playing. The character has to be in its bind pose (T-pose or A-pose) when the component starts, which is the normal state before any animation has run.

## Poses, animations and looks

Everything saved on the Animations tab is in the pose file under its name. Show one from your own script:

```csharp
var hold = character.GetComponent<HandholdGrip>();

hold.Show("Raised");   // a pose: the arm goes there and stays
hold.Show("Swing");    // an animation: plays once, then goes back to what was shown before
hold.Show("Walk");     // a looping animation: plays until something else is shown
hold.Show("Look");     // a look: the arm follows the camera up, down, left and right
hold.Show(null);       // hand the arm back to armMode
```

Names ignore upper and lower case. `Show` returns `false` if the file has nothing by that name.

| Member | What it is |
|---|---|
| `SavedNames` | The names of everything in the file |
| `Showing` | The name being shown now, or `""` |
| `IsPlaying` | True while a saved animation is playing |
| `Seek(seconds)` | Jumps to a time in the animation that is playing |
| `Finished` | Event raised with the name when an animation that does not loop reaches its end |
| `startWith` | Shows this one as soon as the file is loaded (also in the Inspector) |
| `blendTime` | Seconds taken to move from one saved item to the next. Default 0.15 |

A look reads the angle between the camera and the way the character faces. In a first-person rig where the body turns with the camera, only up and down change. With a free camera, left and right come through as well. Set `aimSource` to your camera; it defaults to `Camera.main`.

A typical player item:

```csharp
using UnityEngine;

public class HeldItem : MonoBehaviour
{
    HandholdGrip hold;

    void Start()
    {
        hold = GetComponent<HandholdGrip>();
        hold.aimSource = Camera.main.transform;
        hold.Show("Look");
        hold.Finished += name => Debug.Log(name + " finished");
    }

    void Update()
    {
        if (Input.GetMouseButtonDown(0)) hold.Show("Swing");
    }
}
```

When the swing ends, the arm goes back to the look by itself.

## What the arm does the rest of the time

`armMode` decides what the arm does while nothing saved is shown.

| Mode | What happens | Use it for |
|---|---|---|
| `Animation` | Your walk, run or idle moves the arm. Only the fingers and the prop are added | Carrying something while animations play |
| `Hold` | The arm stays at the exported hold position while the body animates | Holding a torch or a shield out |
| `FollowCamera` | The arm follows the camera up and down | First person and aiming |
| `FromExport` | Whichever of the three was chosen in the Export step | The default |

With `armMode` left at `FromExport`, a file exported to follow the camera starts with its look, if it has one.

The fingers are always applied relative to the hand bone, after animation, so the grip stays closed whatever moves the hand.

## The other settings

```csharp
hold.grip = isHolding ? 1f : 0f;                   // 0 = your animation's fingers, 1 = the grip
hold.armWeight = isSprinting ? 0f : 1f;            // hand the arm back to the animation
hold.secondHandWeight = isReloading ? 0f : 1f;     // two-handed grips: let go with the second hand
hold.heldObject = torch.transform;                 // the prop to keep in the hand
hold.heldObjectTurn = new Vector3(0f, 90f, 0f);    // extra turn if the prop's model uses different axes
hold.Load(anotherPoseJson);                        // switch to a different grip
```

`aimDown`, `aimUp` and `aimSmoothing` set how far `FollowCamera` follows and how quickly. `sweep` (0 to 1) moves the arm along the sweep marked in the Arm step, if one was.

## Two-handed grips

The pose carries the second hand as well: its fingers, its arm, and where its hand bone sits relative to the first hand. In every arm mode the component carries that spot along with the first hand and bends the second arm to reach it, so both hands stay on the prop. Blend `secondHandWeight` to 0 to let go, for example while reloading. Saved animations made for a two-handed item (reload, turn over) do this themselves.

## The posed model

When there are saved animations, or the hand was rigged in Handhold from a mesh with no bones, the package also holds the posed model as a `.glb` with every animation in it. Unity needs the [glTFast](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@latest) package to read it. You do not need it to use the component.
