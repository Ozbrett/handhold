# Handhold from the command line

`scripts/handhold.mjs` does everything the app does, with no window: it loads the hand or character and the prop, finds grips at a spot, places the arm, saves poses, animations and looks, and writes every export into one folder.

```bash
node scripts/handhold.mjs --hand character.glb --object torch.glb --grip 0.25,0.5,0.5 --size 3.5
```

It needs [Node.js](https://nodejs.org) 22.12 or newer and an installed Microsoft Edge, which it runs headless. Set `E2E_CHANNEL=chrome` to use Chrome. The first run builds the site into `dist/`; add `--build` to build again after changing the source.

It exits with 0 only if a grip holds, every export was written, the page reported no errors, and the holds have been checked and approved: `--review <folder>` names the `review.json` folder that `hold-check.mjs` or `motion-check.mjs` wrote for them, and the run exits 3 while anything there fails, is pending or is rejected. Without `--review` it exits 3 too. `--unreviewed` takes the exports without a review (only a grip that does not hold fails the run).

## Options

### The grip

| Option | Meaning |
|---|---|
| `--hand <file>` | A hand or a whole character: GLB, FBX, OBJ, STL or PLY. `sample` is the built-in player, `sample-hand` the bare right hand |
| `--object <file>` | The prop. `sample:stick`, `sample:box`, `sample:ball`, `sample:mug` and `sample:hammer` are built in |
| `--grip fx,fy,fz` | Where the palm goes, as fractions of the prop's bounding box (0 to 1 on each axis). Default `0.5,0.5,0.5` |
| `--size n` | Prop length in hand lengths. Leave it out to keep the file's size. A torch is about 3.5, a mug 0.6, a rifle 5 to 6 |
| `--pick 0\|1\|left\|right` | Which hand of a whole character. Default `right` |
| `--second fx,fy,fz` | Hold it with both hands. The second hand's spot, as the same fractions |
| `--at x,y,z` | Hold at this point instead, in the prop file's own units and axes |
| `--fingers x,y,z`, `--thumb x,y,z` | With `--at`: which way the fingers point out of the fist, and which way the knuckle line runs from little finger to index |
| `--at2`, `--fingers2`, `--thumb2` | The same for the second hand |
| `--carried` | Something else carries the weight (the other hand, a shoulder). Each hand is judged with the weight at its own spot |

### The arm

These need a character with arm bones.

| Option | Meaning |
|---|---|
| `--arm none\|hold\|sweep` | Place the arm. Default `hold` |
| `--hold f,u,o` | Wrist position as fractions of the arm's reach: forward, up and outward from the shoulder. Default `0.62,-0.5,-0.05`, low in front |
| `--sweep-to f,u,o` | With `--arm sweep`: where the sweep ends |
| `--turn t,y,r` | Turn the held prop: tilt, turn and roll in degrees |
| `--mode animation\|hold\|camera` | What the arm does in the game while nothing saved is shown. It sets the starting value in the engine scripts |

### Poses, animations and looks

These also need a character with arm bones. All of them are written into every export.

| Option | Meaning |
|---|---|
| `--poses A/B/...` | Still poses, by name. `Held` saves the hold position. `Raised:0.4,0.3,0.1` saves one at those fractions of the arm's reach. Add `@tilt,turn,roll` to turn the wrist: `Raised:0.4,0.3,0.1@0,20,0` |
| `--style everyday\|tool\|weapon` | What kind of item it is, which decides what the animations do. Default `everyday` |
| `--clips a,b,...` | Ready-made animations: `idle`, `walk`, `run`, `use`, `raise`, `second`. Rename one with `kind:Name`, as in `use:Chop` |
| `--look [Name]` | The arm follows where the player looks. Default name `Look` |
| `--look-range u,d,l,r` | How far it follows up, down, left and right, in degrees. Default `50,40,45,45` |

What `use`, `raise` and `second` become depends on the style:

| Style | For | `use` | `raise` | `second` |
|---|---|---|---|---|
| `everyday` | Cups, phones, torches, keys | Use | Show | Turn over |
| `tool` | Hammers, axes, swords, bats, rackets | Swing | Ready | Turn over |
| `weapon` | Guns, bows, launchers | Fire | Aim | Reload |

Walk, run and idle loop. With a two-handed grip, `second` makes the second hand let go and come back.

### Output

| Option | Meaning |
|---|---|
| `--out <folder>` | Where to write everything. Default `handhold-out/<hand>-<object>` |
| `--name <name>` | File name prefix. Default `grip` |
| `--review <folder>` | The folder whose `review.json` holds the verdicts on these holds (below) |
| `--unreviewed` | Final without a review |

## What it writes

| File | What it is |
|---|---|
| `summary.json` | The result, described below |
| `<name>-*.png` | The chosen grip close up, the second hand, and the arm from in front |
| `*.unitypackage`, `*-godot.zip`, `*-blender.zip` | The three engine downloads |
| `*.glb` | The posed model with every animation |
| `*.pose.json` | The pose as data ([format](pose-format.md)) |
| `<name>-fixture.json` | Where the app put every bone, for the [engine checks](development.md#checking-the-exports-inside-the-engines) |

`summary.json` holds:

| Field | Meaning |
|---|---|
| `holds` | True if at least one grip holds |
| `grips` | Every grip found. `squeeze` is the effort as a multiple of the prop's weight (lower is easier), `robust` runs from 0 to 1, and `segments` is how many finger segments touch |
| `secondHand` | Whether the second hand reaches its spot |
| `wrist` | What the wrist had to do, and by how much it fell short if the joints ran out of range |
| `saved` | Each saved pose, animation and look, with its length |
| `animations` | Every animation in the GLB, with its length in seconds |
| `exports`, `views` | Paths of the files written |
| `problems` | Anything that went wrong |

## Picking the grip point

Look at the prop's proportions first. The longest axis of its bounding box is the one to slide along: a handle at one end of a long prop is 0.2 to 0.3 along that axis and 0.5 on the other two.

If no grip holds, or the wrist cannot turn far enough, move `--grip` or `--hold`, or change `--turn`, and run it again. If the second hand falls short of its spot, bring the two spots closer together or move `--hold` towards the middle of the body.

## Holds a game already places

When a game already decides where the hand goes, use `scripts/game-holds.mjs` instead. The game writes a `manifest.json` that lists each held mesh (OBJ) and where its own arms put the hand's bones. The script lines the character's hand up on those bones and closes the fingers and thumb on the real mesh.

```bash
node scripts/game-holds.mjs --hand character.fbx --in handhold-in --move 0.2 --turn 15 --shots
```

| Option | Meaning |
|---|---|
| `--in <folder>` | The folder with `manifest.json` |
| `--only a,b` | Only these holds |
| `--frames 0,4` | Only these frames |
| `--move n` | Let the hand shift by up to this share of its length when that holds clearly better |
| `--turn n` | Let it turn by up to this many degrees |
| `--shots` | Save close-ups from both sides |
| `--compare` | Save the same views of the game's own hold |
| `--skin-mm n` | How deep (mm) the drawn skin may sit in the held mesh before a finger is moved out (default 5) |

When the mesh has a part named `Trigger`, the trigger finger reaches it. Fingers named in `relax` (for example the trigger finger in an idle hold) stay straight.

If the game's arms bend each finger joint about a single hinge, the manifest can list them as `"hinges": "bone:ax,ay,az,maxDegrees,px,py,pz;..."`, giving each bone's axis, range and rest position in the game's space. The fingers then bend only about those hinges, so the grip Handhold finds is one the game can show. The run prints how far each hinge is from the axis Handhold would have guessed.

After each solve the script measures how far the hand's drawn skin goes into the whole held mesh (every part of the OBJ, not just the grip), per finger and the palm. The solver keeps its collision spheres clear, but the skin over a thumb's root can stand well past them. A finger deeper than `--skin-mm` (default 5) is taken out of the mesh: its end joints, its knuckle or the whole finger are opened or closed in tenths of their range, measuring the skin each time, and the shallowest is kept. The trigger finger stays where the game put it. Each hold's line, and `summary.json` (`depth`, in metres, and `cleared`), says what moved. A finger still deeper is listed under `problems`, and the script exits with an error.

It writes one pose file per hold, plus a `summary.json` with each hold's grip quality and where the hand ended up (`placeAfter`), so the game can move its hand there too.

## Checking a hold, a motion, and the verdict

These need no browser. Each draws a contact sheet, runs the whole-pose checks ([how-it-works.md](how-it-works.md#checking-a-whole-pose)) and records the result in `<out>/review.json` as pending, for a person or Claude to look at and approve or reject. Exit codes: 0 when every check passes and everything in the review is approved, 3 when anything fails, is pending or is rejected (`--unreviewed`: only failures count), 1 on an error.

**A hold**, as the game shows it: the item aimed from the eye, each hand's pose file put on it, both arms solved, every check run, one sheet (front, left, right, back, above, the eye) with every fault painted red on top.

```bash
node scripts/hold-check.mjs --character Crew.fbx --item gun_1_tt_33.obj --name tt_33 --out checked \
  --hand "right=grip_1_right.pose.json;grip=Grip"
```

| Option | Meaning |
|---|---|
| `--character` | FBX or GLB, or `sample` for the built-in player |
| `--item`, `--name` | The held OBJ (in the character's space; `--unmirrored` when it is still in Unity's axes) and the name it is recorded under |
| `--hand side=<pose.json>[;grip=A,B][;wrap=middle,ring,pinky]` | A hand's pose file, once per hand; `grip` names the pieces the palm must hold, `wrap` the fingers that must close round them |
| `--style`, `--forward`, `--up` | What way up the item must be. Default `gun`, forward `0,0,1`, up `0,1,0` |

**A motion**, frame by frame ([motion-check.md](motion-check.md)): one sheet per clip, eight moments down the page.

```bash
node scripts/motion-check.mjs --motion out/motion.json --out checked [--unreviewed]
```

**A reload to check**, built from attachments ([motion-check.md](motion-check.md#making-a-reload-to-check)):

```bash
node scripts/make-reload.mjs --character Crew.fbx --gun gun_1_tt_33.obj --name tt_33 --out out \
  --grip right=grip_1_right.pose.json --mag reload_1_left.pose.json --mag-pieces Baseplate --mag-slide 60
```

**The verdict**, after looking at the sheet. A note is required; a failing item cannot be approved; an item whose inputs or checks change goes back to pending.

```bash
node scripts/review.mjs status  checked
node scripts/review.mjs approve checked tt_33 --note "grip in the palm, trigger finger on the trigger, elbow down"
node scripts/review.mjs reject  checked tt_33 --note "hand 15 mm inside the grip"
```
