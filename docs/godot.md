# Handhold in Godot

The Godot download is a zip for Godot 4.3 or newer. It holds a `SkeletonModifier3D` script, the pose file, and the posed model as a GLB.

> **Not yet run in Godot.** The script follows the same logic as the Unity component, which is checked against the app bone by bone, but nobody has run it inside Godot yet. If something is off, please [open an issue](https://github.com/Ozbrett/handhold/issues). The GLB in the same zip carries the pose and every animation and does not need the script.

## Add a grip to a character

1. Unpack the zip into your project folder. It adds a `handhold` folder.
2. Open your character's scene and add a **HandholdGrip** node as a child of its `Skeleton3D`.
3. Drag the `.pose.json` onto **Pose** in the Inspector. To put a prop in the hand, set **Held Object**.

The node is a `SkeletonModifier3D`, so it runs after the `AnimationPlayer` and sits on top of whatever animation is playing.

## Poses, animations and looks

Everything saved on the Animations tab is in the pose file under its name:

```gdscript
@onready var hold: HandholdGrip = $Skeleton3D/HandholdGrip

func _ready() -> void:
    hold.aim_source = $Camera3D
    hold.show_saved("Look")       # a look: the arm follows the camera
    hold.finished.connect(_on_finished)

func _unhandled_input(event: InputEvent) -> void:
    if event.is_action_pressed("attack"):
        hold.show_saved("Swing")  # an animation: plays, then goes back to the look
    if event.is_action_pressed("raise"):
        hold.show_saved("Raised") # a pose: the arm goes there and stays

func _on_finished(saved_name: String) -> void:
    print(saved_name, " finished")
```

| Member | What it is |
|---|---|
| `show_saved(name)` | Shows a saved pose, animation or look. `""` hands the arm back to `arm_mode`. Returns `false` if the file has nothing by that name |
| `saved_names()` | The names of everything in the file |
| `showing()` | The name being shown now, or `""` |
| `is_playing()` | True while a saved animation is playing |
| `seek(seconds)` | Jumps to a time in the animation that is playing |
| `finished` | Signal emitted with the name when an animation that does not loop reaches its end |
| `start_with` | Shows this one as soon as the file is loaded (also in the Inspector) |
| `blend_time` | Seconds taken to move from one saved item to the next. Default 0.15 |

## What the arm does the rest of the time

**Arm Mode** decides what the arm does while nothing saved is shown.

| Mode | What happens | Use it for |
|---|---|---|
| Animation | Your walk, run or idle moves the arm. Only the fingers and the prop are added | Carrying something while animations play |
| Hold | The arm stays at the exported hold position while the body animates | Holding a torch or a shield out |
| Follow Camera | The arm follows `aim_source` up and down | First person and aiming |
| From Export | Whichever of the three was chosen in the Export step | The default |

## The other settings

| Property | What it does |
|---|---|
| `grip` | 0 = your animation's fingers, 1 = the grip |
| `arm_weight` | 0 hands the arm back to the animation |
| `second_hand_weight` | Two-handed grips: 0 lets go with the second hand |
| `held_object`, `held_object_turn` | The prop to keep in the hand, and an extra turn in degrees if its model uses different axes |
| `sweep` | 0 to 1 along the sweep marked in the Arm step, if one was |
| `aim_down`, `aim_up`, `aim_smoothing` | How far Follow Camera follows, and how quickly |

## Using the GLB instead

`handhold/<name>.glb` is the model already posed and holding the object. Its animations are `Grip`, one for each saved pose and animation, and two for each look (`<name> Down-Up` and `<name> Left-Right`). Godot imports them as ordinary animations for an `AnimationPlayer`.
