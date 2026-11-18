# Using Handhold with Claude Code

Handhold has a command-line front end, and this repository ships a Claude Code skill that knows how to run it. Together they let you ask for a grip in plain words:

> Make my character hold the torch in her right hand, low in front, and give me a swing I can play in Unity.

Claude runs Handhold with no window, reads the result, looks at the pictures it took, and tells you whether the grip holds. The files it writes are the same ones the app's Export step gives you.

## Set up

You need [Node.js](https://nodejs.org) 22.12 or newer, Microsoft Edge or Chrome (used headless, never shown), and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/Ozbrett/handhold.git
```

```bash
cd handhold
```

```bash
npm ci
```

The first run builds the site into `dist/` by itself.

There are two ways to work, depending on where you start Claude Code.

**From the Handhold folder.** Nothing more to do. The skill in `.claude/skills/handhold` is loaded when Claude Code starts there. Give Claude the full paths of your models and say where the output should go.

**From your game project.** Copy the skill into the project and tell Claude where Handhold is:

1. Copy `handhold/.claude/skills/handhold` to `<your game>/.claude/skills/handhold`. To have it in every project instead, copy it to `~/.claude/skills/handhold`.
2. Add one line to your game's `CLAUDE.md`, with your own path:

```markdown
Handhold is installed at D:/Tools/handhold. Run it with `node D:/Tools/handhold/scripts/handhold.mjs`.
```

The script finds its own files from where it is installed, so it can be run from any folder. Model paths and `--out` are read relative to the folder you run it from.

## What to ask for

Say what the item is, which hand, and what the character does with it. Claude picks the options. These are real requests and the command each one turns into.

**A torch held out in front, with a pose and a look**

> Make the character in Assets/Models/Hero.fbx hold Assets/Props/Torch.glb in the right hand. I want a raised pose, and the arm should follow the camera.

```bash
node scripts/handhold.mjs --hand Assets/Models/Hero.fbx --object Assets/Props/Torch.glb --grip 0.25,0.5,0.5 --size 3.5 --mode camera --poses "Held/Raised:0.5,0.25,0.05" --look Look --out handhold-out/hero-torch
```

**An axe that is swung**

> Hero should carry the axe while walking and chop with it.

```bash
node scripts/handhold.mjs --hand Hero.fbx --object Axe.glb --grip 0.5,0.15,0.5 --size 4 --style tool --clips idle,walk,run,use:Chop,raise:Ready
```

**A rifle in both hands**

> It is a rifle. Both hands, aims where the player looks, with fire and reload.

```bash
node scripts/handhold.mjs --hand Hero.fbx --object Rifle.glb --grip 0.3,0.5,0.5 --second 0.7,0.5,0.5 --size 5.5 --hold 0.75,-0.1,-0.25 --mode camera --style weapon --clips use:Fire,second:Reload,idle --look Aim --look-range 40,40,45,45
```

**No model yet**

> Show me what a character holding a hammer looks like, I do not have models yet.

```bash
node scripts/handhold.mjs --hand sample --object sample:hammer --style tool --clips use --poses Held --look
```

`--hand sample` is a built-in rigged player and `sample:hammer`, `stick`, `box`, `ball` and `mug` are built-in props, so you can try an idea first and rerun the same command with your own files later.

Every option is described in [command-line.md](command-line.md).

## What comes back

Everything lands in one folder (`handhold-out/<hand>-<object>` unless you say otherwise):

| File | What it is |
|---|---|
| `summary.json` | What was found: whether a grip holds, each grip's effort, what the wrist and second hand did, the saved items, every animation in the GLB, and any problems |
| `*.png` | The chosen grip close up, the second hand, and the arm from in front |
| `<name>.unitypackage` | For Unity |
| `<name>-godot.zip` | For Godot |
| `<name>-blender.zip` | For Blender |
| `<name>.glb` | The posed model with every animation |
| `<name>.pose.json` | The pose as data ([format](pose-format.md)) |

The command exits with 0 only when a grip holds, every export was written and the page reported no errors. Claude reads `summary.json` and opens the pictures before it says anything worked. If the grip slips or the wrist cannot turn far enough, it moves the grip point or the hold position and runs again.

## The three kinds of saved item

Whatever you ask for is saved under a name, and your game shows it by that name.

| Kind | What it does in the game | Ask for it with |
|---|---|---|
| Pose | The arm goes there and stays | `--poses` |
| Animation | It plays, once or in a loop | `--clips` |
| Look | The arm follows the player's view: look up and the item goes up, look down and it goes down, and the same to the left and right | `--look` |

## Putting it in the game

Once the files exist, Claude can do the engine side as well. Ask for it directly: "import the package and make left click play Chop".

### Unity

Import the `.unitypackage`, select the character (Ctrl-click the prop too) and choose **Tools > Handhold > Add grip to selected character**. Then drive it from your own script:

```csharp
using UnityEngine;

public class HeldItem : MonoBehaviour
{
    HandholdGrip hold;

    void Start()
    {
        hold = GetComponent<HandholdGrip>();
        hold.aimSource = Camera.main.transform;   // what a look follows
        hold.Show("Look");                         // the arm follows the view from now on
        hold.Finished += name => Debug.Log(name + " finished");
    }

    void Update()
    {
        if (Input.GetMouseButtonDown(0)) hold.Show("Chop");    // plays once, then goes back to the look
        if (Input.GetKeyDown(KeyCode.R)) hold.Show("Raised");  // a pose: stays until something else is shown
        if (Input.GetKeyDown(KeyCode.H)) hold.Show(null);      // hand the arm back to your own animation
    }
}
```

More in [unity.md](unity.md).

### Godot

Unpack the zip into the project, add a **HandholdGrip** node under the character's `Skeleton3D`, and drag the `.pose.json` onto **Pose**.

```gdscript
@onready var hold: HandholdGrip = $Skeleton3D/HandholdGrip

func _ready() -> void:
    hold.aim_source = $Camera3D
    hold.show_saved("Look")
    hold.finished.connect(func(saved_name): print(saved_name, " finished"))

func _unhandled_input(event: InputEvent) -> void:
    if event.is_action_pressed("attack"):
        hold.show_saved("Chop")
```

More in [godot.md](godot.md).

### Blender

Unpack the zip, select the armature and run the `.py` from the Scripting tab. Every saved item arrives as an Action, and saved poses are in the Pose Library. More in [blender.md](blender.md).

## Letting Claude check its own work

Claude can run an export inside Unity and Blender without opening either, and compare every bone with where Handhold put it:

```bash
blender -b --factory-startup --python-exit-code 1 --python scripts/check-blender.py -- character.glb prop.glb apply_x.py x-fixture.json x.glb
```

```bash
Unity -batchmode -nographics -quit -projectPath P -executeMethod HandholdCheck.Run
```

[development.md](development.md) explains how to produce the fixture these read. There is no such check for Godot yet.

Claude also checks the poses themselves, not just the bones. `scripts/hold-check.mjs` and `scripts/motion-check.mjs` run the whole-pose checks (joints in range, no torn or folded skin, nothing inside anything, elbows out, the gun the right way up, hands staying on what they hold) and draw a sheet with every fault in red. The skill has Claude answer four questions in order: do the machine checks pass; what does the sheet show; does the picture agree with the checks (if it shows something wrong that passed, the check is wrong and is fixed first); and only then approve or reject with a note saying what it saw:

```bash
node scripts/review.mjs approve checked tt_33 --note "palm on the grip, trigger finger on the trigger, elbow down and out"
```

`handhold.mjs` treats its exports as final only when `--review checked` shows everything approved (or with `--unreviewed`), so a pose nobody looked at does not slip through.

Before a grip, Claude can check the character itself. A second skill, `.claude/skills/rig-doctor`, runs [Rig Doctor](rig-doctor.md): it measures the sleeve over the hand, the cuff weights and how thick the wrist stays when the hand rolls and bends, fixes what fails, and renders a before and after sheet to look at. Ask "the wrists contort when my character holds the gun, fix the model". Copy that skill into a game project the same way as this one.

## Things worth knowing

- The grip point is given as fractions of the prop's bounding box, in the file's own axes. A handle at one end of a long prop is about `0.25` along its longest axis and `0.5` on the other two. If you know which end the handle is, say so.
- `--size` is the prop's length in hand lengths. A torch is about 3.5, a mug 0.6, a rifle 5 to 6. Leave it out when the prop file is already the right size for the character.
- A large prop (150,000 triangles or more) takes a minute or two.
- Animations need a whole character with arm bones. A bare hand gets the grip only.
- The character stays on the spot in every animation. They move the arm and hand; your own locomotion moves the body.
- Nothing is uploaded. The models are read from disk by a browser running on your machine.
