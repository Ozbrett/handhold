# Working on Handhold

## Run it

You need [Node.js](https://nodejs.org) 22.12 or newer and Git.

```bash
git clone https://github.com/Ozbrett/handhold.git
```

```bash
cd handhold
```

```bash
npm ci
```

```bash
npm run dev
```

Open the address it prints (usually http://localhost:5173/).

`npm run build` type-checks and builds the static site into `dist/`. Any static host can serve it, from any folder. The included GitHub Actions workflow tests, builds and publishes `dist/` to GitHub Pages on every push to `main`; in the repository settings, set Pages to deploy from GitHub Actions.

## How the code is laid out

| Folder | What is in it |
|---|---|
| `src/core/hand` | Hand analysis: fingertip detection, joint placement, palm fitting, skin weights |
| `src/core/grasp` | Grip search, finger closing, the linear program and the stability score |
| `src/core/sample` | The built-in hand, player and props, generated from distance fields |
| `src/app` | The 3D view, file loading, the panel, the arm, saved poses, animations and looks, export, and matching a grip to an existing skeleton |
| `src/check` | Checking a whole pose with no browser: the body and pose-file readers, the whole-pose checks, the software rasteriser and contact sheets, the review file, animations with attachments, the motion file and the reload |
| `unity`, `godot`, `blender` | The scripts that go inside each export |
| `tests` | Unit tests, including a real hand mesh with a known skeleton |
| `scripts` | Headless tools and checks, listed below |
| `.claude/skills/handhold` | The Claude Code skill ([guide](with-claude.md)) |

`src/core` has no browser dependencies and can be used on its own in Node.

## Checks

None of these opens a window. The browser ones use an installed Microsoft Edge in headless mode; set `E2E_CHANNEL=chrome` to use Chrome. They need a build first.

| Command | What it checks |
|---|---|
| `npm test` | Unit tests: the rig, the grip search, the physics, the exports |
| `npm run e2e` | Drives the built site through the grip steps and validates the exported GLB and the three engine downloads |
| `node scripts/ux-check.mjs` | The Character and Animations tabs: poses, animations and looks, moving the item with the hand following, limits, and what the export contains |
| `node scripts/doc-shots.mjs` | Not a check: retakes the pictures in `docs/` |
| `npm run typecheck` | The TypeScript types |

The whole-pose checks have their own tests (`tests/poseCheck.test.ts`, `tests/motion.test.ts`), each watched failing on a broken pose: a hand pushed into a block, an elbow through the chest, a wrist's skin folded back, a hand that lets go of the magazine, a gun upside down.

## Trying your own models

Build once, then:

```bash
node scripts/try-models.mjs myrun path/to/hand.glb "path/to/prop.glb@0.5,0.5,0.5@1.5"
```

The part after the first `@` is where to click the grip point, as fractions of the object's bounding box. The part after the second `@` is the object's size in hand lengths. Screenshots land in `test-output/real/`.

It is driven by environment variables. `scripts/handhold.mjs` wraps the same run with plain flags and is easier to use ([command-line.md](command-line.md)).

| Variable | Meaning |
|---|---|
| `HAND_PICK=left\|right` | Which hand of a whole character |
| `TWO=fx,fy,fz` | Hold with both hands, the second at that spot |
| `ARM=1` or `ARM=hold` | Place the arm and mark a sweep, or one position only |
| `HOLD=f,u,o`, `SWEEP_TO=f,u,o` | Where the wrist goes, as fractions of the arm's reach from the shoulder |
| `TURN=tilt,turn,roll` | Turn the object at the last position |
| `ARMMODE=animation\|hold\|camera` | What the arm does in the game |
| `STYLE`, `CLIPS`, `POSES`, `LOOK`, `LOOK_RANGE` | Saved animations, poses and a look, as the flags of the same names |
| `EXPORT=1` | Also save the GLB, the pose, the three engine downloads and a `-fixture.json` that records where the app put every bone |
| `OUT_DIR=folder` | Where to write |

## Other scripts

| Script | What it does |
|---|---|
| `scripts/handhold.mjs` | The command-line front end: one prop, one folder of exports and a summary |
| `scripts/game-holds.mjs` | Solves every hold a game already places, from a manifest the game writes |
| `scripts/hold-check.mjs` | Checks one hold on a character and draws its sheet ([command-line.md](command-line.md#checking-a-hold-a-motion-and-the-verdict)) |
| `scripts/motion-check.mjs` | Checks a motion file frame by frame ([motion-check.md](motion-check.md)) |
| `scripts/make-reload.mjs` | Builds a reload from attachments as a motion file |
| `scripts/review.mjs` | Records a verdict on a checked hold or motion |
| `scripts/game-view.mjs` | Close-ups of a game's own hands for the same holds, to compare with |
| `scripts/try-fist.mjs` | Curls a hand's fingers and photographs it from three sides, to check a rig at a glance |
| `scripts/view-model.mjs` | Loads any model as the object and photographs it, with close-ups of its ends |
| `scripts/probe-real-hand.ts` | Rigs the real test hand with its skeleton thrown away and compares the result with the skeleton it shipped with (`npx vite-node scripts/probe-real-hand.ts`) |

## Checking the exports inside the engines

Both checks take the files written by an `EXPORT=1` run (or by `handhold.mjs`), apply the export the way a user would, and compare every bone and the prop with the fixture. Each also runs "twisted": on a skeleton that has been turned, rescaled, moved and renamed, which the scripts have to work out for themselves. Saved poses, animations and looks are checked too: a pose must put the hand where the app did, a look must pass through the hold when looking straight ahead and land on the right arc at its ends, and an animation must play and finish.

**Blender**

```bash
blender -b --factory-startup --python-exit-code 1 --python scripts/check-blender.py -- character.glb prop.glb apply_x.py x-fixture.json x.glb
```

**Unity**

Make an empty project and import the package:

```bash
Unity -batchmode -nographics -quit -projectPath P -importPackage x.unitypackage
```

Copy `scripts/check-unity/HandholdCheck.cs` to `Assets/Editor` and the fixture to `Assets/HandholdCheck/fixture.json`, then run the check as a separate step:

```bash
Unity -batchmode -nographics -quit -projectPath P -executeMethod HandholdCheck.Run
```

On the test character both pass with no measurable error, in Blender 5.1 and Unity 6000.6, in all three arm modes, with one hand and with two.

**Unreal**

Unreal takes the `.glb` and the pose file's `unreal` socket, with no script of ours (see [unreal.md](unreal.md)), so the check imports
the `.glb` the way that guide says and compares each animation with the `.glb` bone for bone, and the prop on the socket with the prop
in the `.glb`. It needs a project with the character's skeleton, and the character exported from that project as `.glb` (the
mannequin: right-click `SKM_Manny_Simple`, **Asset Actions > Export**, glTF binary) given to `handhold.mjs --hand`:

```bash
UnrealEditor-Cmd P.uproject -run=pythonscript -script="scripts/check-unreal.py x.glb x.pose.json /Game/Characters/Mannequins/Meshes/SK_Mannequin" -unattended -nullrhi -nosplash -nosound -nopause -stdout -AllowStdOutLogVerbosity
```

It ends with `HH RESULT PASS` or `HH RESULT FAIL`. Unreal cannot export a skeletal mesh as FBX without a renderer, so export the
character as glTF.

**Godot**

There is no check for Godot yet, and `godot/handhold_grip.gd` has not been run inside Godot. It mirrors the Unity component. A headless check like the two above is the most useful thing to add next.

## Loading models from an address

`?hand=<url>&object=<url>` loads both and solves straight away. Optional: `pick=0` (which hand of a character), `size=2.2` (object size in hand lengths), `grip=0.5,0.5,0.5` (grip point inside the object's bounding box) and `arm=1` (open the Arm step). `?demo=hammer` (or `mug`, `stick`, `box`, `ball`) uses the built-in sample hand.

To use files on your own disk with the dev server, list their folders in an untracked `handhold.local.json` (`{ "allowDirs": ["D:/Models"] }`) and use `/@fs/D:/Models/hand.glb` as the address.
