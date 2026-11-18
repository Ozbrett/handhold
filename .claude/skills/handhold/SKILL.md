---
name: handhold
description: Make a hand or a game character hold a prop with Handhold, headlessly, and get the grip, the arm placement, saved poses, ready-made animations (idle, walk, run, swing, aim, fire, reload, use, show, turn over) and looks that follow the player's view back as Unity / Godot / Blender / GLB exports. Use when asked to make a character hold, grip, carry, swing, aim or use an item, to animate a character with an item for a game, to make a held item follow where the player looks, to try a prop in a character's hand (one or two hands), or to produce a .pose.json / posed .glb for a model. Works with the user's own rigged character or the built-in sample player and props.
---

# Handhold from the command line

`scripts/handhold.mjs` runs the Handhold app in a headless browser (no window opens) and writes everything into one folder.

```bash
node scripts/handhold.mjs --hand <hand or character file> --object <prop file> [options]
```

The script is in the Handhold repository. When this skill has been copied into another project, that project's CLAUDE.md says where Handhold is installed: run the script by its full path. Model paths and `--out` are relative to the folder the command is run from.

| Option | Meaning |
|---|---|
| `--hand sample` | Use the built-in player: a rigged 1.79 m mannequin with Mixamo-style bone names (no prefix). `--hand sample-hand` is the bare right hand. |
| `--object sample:<id>` | Use a built-in prop: `stick`, `box`, `ball`, `mug`, `hammer`. |
| `--grip fx,fy,fz` | Where the palm goes, as fractions of the prop's bounding box (0..1 per axis). Default `0.5,0.5,0.5`. |
| `--size n` | Prop length in hand lengths (the app rescales). Leave out to keep the file's size. A torch is about 3.5, a mug 0.6, a rifle 5 to 6. |
| `--pick 0\|1\|left\|right` | Which hand of a whole character. Default `right`. |
| `--second fx,fy,fz` | Hold with both hands; the second hand's spot, same fractions. |
| `--arm none\|hold\|sweep` | Place the arm (characters with arm bones). Default `hold`. |
| `--hold f,u,o` | Wrist position as fractions of the arm's reach: forward, up, outward from the shoulder. Default `0.62,-0.5,-0.05` (low in front). |
| `--sweep-to f,u,o` | With `--arm sweep`: the end of the sweep (aiming high). |
| `--turn t,y,r` | Turn the held object: tilt, turn, roll in degrees. |
| `--mode animation\|hold\|camera` | What the arm does in the game while nothing saved is shown (starting value in the engine scripts). |
| `--style everyday\|tool\|weapon` | The item type, which decides what the animations do. `everyday` (cups, phones, torches, keys): use, show, turn over. `tool` (hammers, axes, swords, bats, rackets): swing, ready, turn over. `weapon` (guns, bows, launchers): fire, aim, reload. Default `everyday`. |
| `--clips a,b,...` | Animations to save: `idle`, `walk`, `run`, `use`, `raise`, `second`. `use` is swing / fire / use, `raise` is ready / aim / show, and `second` is turn over / reload, depending on `--style`. Name one with `kind:Name`, e.g. `use:Attack,raise:Aim`. |
| `--poses A/B/...` | Still poses to save, by name. `Held` is the hold position. `Raised:0.4,0.3,0.1` is one at those fractions of the arm's reach (forward, up, outward); add `@tilt,turn,roll` to turn the wrist. |
| `--look [Name]` | Save a look: the arm follows where the player looks, up, down, left and right. Default name `Look`. |
| `--look-range u,d,l,r` | How far the look follows, in degrees. Default `50,40,45,45`. |
| `--out <folder>` | Default `handhold-out/<hand>-<object>`. |

## How to use it

1. Pick the grip spot. Look at the prop's proportions first: the longest axis of the bounding box is the one to slide along. A handle at one end of a long prop is `0.2..0.3` along that axis and `0.5` on the other two.
2. Run it (one to two minutes on a 150k-triangle prop). Run it in the background when the prop is large.
3. Read `summary.json` in the output folder: `holds`, the `grips` list (`squeeze` is effort, lower is easier; `robust` 0..1), `secondHand`, `wrist`, `saved`, `animations`, `exports`, `problems`.
4. Look at the images in `views` with the Read tool (the chosen grip, the second hand, the arm from in front) before saying it worked.
5. If no grip holds, or the wrist reports it cannot turn that far, move `--grip` / `--hold` or change `--turn` and run again. If the second hand "is ... short of its grip", bring the spots closer together or move `--hold` toward the body's middle.

Exit code 0 means at least one grip holds, every export was written and the page reported no errors.

## Poses, animations and looks

Anything saved goes into every export under its name, and the game shows it by that name. All three need a character with arm bones.

| Kind | What the game does with it | Flag |
|---|---|---|
| Pose | The arm goes there and stays | `--poses` |
| Animation | Plays once, or loops (idle, walk, run) | `--clips` |
| Look | The arm follows the player's view: up, down, left and right | `--look` |

For "make my character use this item" requests, get the grip first, then add what the game needs:

```bash
node scripts/handhold.mjs --hand Hero.fbx --object Axe.glb --grip 0.5,0.15,0.5 --size 4 --style tool --clips idle,walk,run,use:Chop,raise:Ready --poses Held --look
```

1. Choose `--style` from what the item is, not how it looks: anything swung is `tool`, anything aimed and shot is `weapon`, everything else is `everyday`.
2. A two-handed item (rifle, staff, big axe) gets `--second`. Its `second` animation makes the second hand let go and come back (reload, turn over).
3. `--hold` sets where every pose, animation and look starts, so place the arm well first: low in front for tools and everyday items, higher and further forward for weapons (`--hold 0.75,-0.1,-0.25`).
4. A first-person or aiming item gets `--look` and `--mode camera`. Narrow `--look-range` if the pictures show the arm cannot follow that far.
5. In `summary.json`, `saved` lists each pose, animation and look that was saved, and `animations` lists every animation in the posed .glb with its length in seconds: `Grip`, `Sweep` (only with `--arm sweep`), one per pose and animation, and two per look (`<name> Down-Up`, `<name> Left-Right`). Something asked for and missing means the character has no arm bones or no grip was found. Say so; do not report success.
6. Idle, walk and run loop. The character stays on the spot, so animations move the arm and hand only; the user's own locomotion moves the body. They are sampled at 30 fps, so they import into Unity (glTFast), Godot and Blender as ordinary animations.

To try an idea before the user has a model, use `--hand sample` and a `sample:` prop, then hand over the commands to rerun with their files.

For anything the CLI cannot do (moving a saved pose by hand, changing how far the joints turn), the user can open the app (`npm run dev`) and use the Animations tab. Everything in its list is saved with the export.

## Putting the export in the game

When asked to wire it in, use the engine's script from the export. The names are the ones in the `saved` list of `summary.json`.

- **Unity**: import the `.unitypackage` (`Unity -batchmode -nographics -quit -projectPath <project> -importPackage <file>`), add `HandholdGrip` to the character with `poseJson` set to the imported `.pose.json` and `heldObject` to the prop, then call `GetComponent<HandholdGrip>().Show("Chop")` from the game's own script. `Show(null)` hands the arm back, the `Finished` event fires when a one-shot ends, `startWith` shows one from the start, and `aimSource` is the camera a look follows.
- **Godot** (4.3+): unpack the zip into the project, add a `HandholdGrip` node under the character's `Skeleton3D` with `pose` set to the `.pose.json`, then call `show_saved("Chop")`. The signal is `finished`; `start_with` and `aim_source` work as in Unity. This script has not been run inside Godot yet: say so when handing it over.
- **Blender**: run the `.py` from the zip with the armature selected. Saved items become Actions named after the prop, and saved poses are pose assets.

The full guides are in the repository's `docs` folder: `unity.md`, `godot.md`, `blender.md`, `command-line.md` and `pose-format.md`.

## Holds a game already places

When the game already decides where the hand goes, use the batch runner instead:

```bash
node scripts/game-holds.mjs --hand <character file> --in <folder with manifest.json> [--only grip,idle] [--frames 0,4] [--move 0.2] [--turn 15] [--shots] [--compare]
```

If a `local-*.md` file sits beside this one, read it: it has the steps for a particular game on this machine.

When the manifest has `hinges`, the run prints a `HINGES` line: `joints` should be 15 per hand, `rms` near 0, and the fingers within about 15° of Handhold's own axes. Far more than that means the game wrote its axes in the wrong space.

Check the `--shots` close-ups (`<pose>_<frame>_<side>-a/b.png`) against the `--compare` shots of the game's own hold. In the summary, read `segments`, `triggerMiss` (mm) and `moved` (mm).

## Checking a hold or a motion before it is used

A hold or clip is not done until it is checked, looked at, and approved. Three commands, all headless:

```bash
node scripts/hold-check.mjs --character <fbx|glb> --item <obj> --name <name> --out <dir> --hand right=<pose.json>[;grip=<Piece,...>] [--hand left=<pose.json>]
node scripts/motion-check.mjs --motion <motion.json> --out <dir>
node scripts/review.mjs status|approve|reject <dir> [<name> --note "<what the sheet shows>"]
```

Answer these in order, for every item in `<dir>/review.json`. Stop at the first "no": reject it with a note that says what is wrong, and fix the hold, not the check.

1. **Machine checks.** Do the `FAIL` lines say nothing failed? A failing item cannot be approved. For each failure, name the joint, the value and the limit in the reply.
2. **The sheet** (`<dir>/<name>/sheet.png`; downscale it if it is wider than about 2000 px). Look at every view (front, left, right, back, above, eye; for a clip, every moment):
   - Is each hand on the part it should be on: the palm against the grip, the fingers round it, the thumb on its own side, nothing floating, nothing sunk in?
   - Is the item the right way up and pointing where it should (a gun's top up, its muzzle away from the body)?
   - Is anything red? Red is skin inside an item, or skin torn or folded.
   - Do the elbows point out and down, away from the body, never in through the chest?
   - Is any part of the item inside the head, chest or arms?
   - For a clip: does the holding hand stay put on the grip while the other hand works? Do the first and last moments match the hold?
3. **Does the picture agree with the checks?** If the picture shows a fault while the checks pass, the check is wrong: say so and fix the check before anything else. Never approve over it.
4. **Approve** only when 1 to 3 are all yes: `review.mjs approve <dir> <name> --note "<what you saw>"`. The note says what the sheet showed, not that it "looks fine".

`handhold.mjs --review <dir>` exits 3 while anything there is pending, rejected or failing; `--unreviewed` takes the exports without a review. An item whose inputs or checks change goes back to pending by itself.

## Rules

- Never open the app, a browser window, Unity, Blender or Godot on screen. The CLI is headless; the engine checks are in `docs/development.md` under "Checking the exports inside the engines" and run with `-batchmode -nographics` / `-b`.
- Report what the summary and the images show, including warnings, not what was hoped for.
- Fractions are of the prop's bounding box in the file's own axes, not of the screen.
