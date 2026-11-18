# Rig Check: will this model animate without warping?

A model out of an image-to-3D generator and an auto-rigger looks fine standing still. It warps the first time it moves: a joint
sits outside the skin and the arm bends about a point in the air, a patch of forearm is weighted to the thigh and gets dragged
across the body, a hard step in the weights tears the outside of every bend, a wrist rolls on one ring of vertices and collapses
like a sweet wrapper, or a vertex follows six bones and the game engine quietly drops two.

Rig Check finds all of that before anything is animated. It runs headless in Blender (no window opens), on any skeleton, so a
script or Claude can take a model from anywhere, prove it will animate, and fix what can be fixed in its weights.

```bash
node scripts/rig-check.mjs check <model> [--report <file.json>] [--ranges <file.json>] [--kind auto|humanoid|creature] [--quick]
```

```bash
node scripts/rig-check.mjs fix <model> [--unweighted] [--far] [--spikes] [--orphans] [--save <fixed.blend>] [--export <fixed.fbx|.glb>]
```

`<model>` is a `.fbx`, `.glb`, `.gltf` or `.blend`. Blender is found at `$BLENDER`, or the newest one in the usual install folder.
Exit code 0 means nothing fails (warnings are allowed), 3 means something fails (the report says what and how to fix it), 1 is an
error. The JSON report has every number, every joint and every turn.

## Against a default rig

A model whose bone names are a humanoid's (Mixamo `mixamorig:LeftArm`, Unreal `upperarm_l`, Unity, Blender `upper_arm.L`, Rigify
`DEF-upper_arm.L`) is checked against a default humanoid rig. Anything else is a creature, and keeps every check that is not about
a person's shape.

| Check | Fails when |
|---|---|
| roles | a humanoid is missing the hips, spine, neck, head, or an upper arm, forearm, hand, thigh, shin or foot, or a limb bone is not under the one before it |
| lengths | a limb bone is outside a person's range of the height (a warning when left and right differ by more than 4%) |
| mirror | the left joints are more than 5% of the height from the mirrored right ones |
| aim | a bone with one child points more than 30 degrees away from it (IK and twists turn about that line) |
| joints | a joint that bends skin is outside the skin. Off the middle of the limb, or on an open seam between two pieces (a sleeve ending short of a glove), is a warning |

## Every weight

| Check | Fails when |
|---|---|
| unweighted | a vertex follows no bone |
| influences | a vertex follows more than 4 bones (Unity, three.js and glTF skin with 4) |
| far | a vertex is weighted to a bone below its own, or on another branch, that is far from it (a warning when the far bone is above its own: a big body riding its root) |
| spikes | a vertex's weights are nothing like its neighbours' |
| mirror weights | a humanoid's left side is weighted unlike its right, where the mesh itself is mirrored |
| sum, orphans | weights not adding to 1, groups named for no bone (warnings) |

## Every joint turned

Each joint that bends skin is turned one way at a time: bent each way about its X, sideways about its Z and rolled about its
length. It is turned as far as animation turns that joint and no further, because any skin stretches past its joint's range: a
wrist rolls 90 degrees (its twist bone takes half), a knee bends 60 and barely goes sideways, a head turns 40. A creature's joints
are turned 60, 40 and 20. A game that knows its own ranges passes them:

```json
{ "^(Neck|Head)$": [30, 20, 20], "^Tail": [36, 36, 10], "^Leg_": [60, 30, 15] }
```

Each key is a pattern on the bone name, each value the bend, side and roll in degrees; the first pattern that matches a bone wins.
For each turn it measures:

| Measure | Fails when |
|---|---|
| kept | the skin round the joint keeps under 65% of its thickness (the sweet-wrapper collapse) |
| stretch | the 99th percentile of edges near the joint stretch past 2x, or the worst 0.1% past 3x (a step in the weights). A sound 60 degree bend stretches the outside of it 1.45x, as skin does |
| drag | more than 20 vertices far from every turned bone move anyway (weights leaking along the body) |
| left behind | more than 20 vertices out on the turned limb, away from the joint, do not go round with it (weighted to a bone above) |

## What it fixes

With no step named, `fix` runs all of them, then checks everything again and reports before and after.

| Step | What it does |
|---|---|
| `--unweighted` | a vertex that follows no bone follows its nearest bone |
| `--far` | the weights the far check fails are taken off and the rest renormalised |
| `--spikes` | a spike's weights become its neighbours' average (twice) |
| `--orphans` | vertex groups named for no bone are removed |
| always, last | every vertex is kept to its 4 strongest bones and its weights add to 1 |

`--save x.blend` keeps the fixed scene, animations too; `--export x.fbx|x.glb` also exports it (FBX with its actions and no leaf
bones). What cannot be fixed in the weights (a joint outside the skin, a skeleton that is not mirrored, a missing bone) is
reported with how to fix it in Blender.

## Its own test

```bash
npm run test:blender
```

builds a humanoid of tubes with sound weights, which must pass every check, then puts each fault into a copy of it and expects
the check that is for it to catch it (and `fix` to mend it, where it mends that fault): rigid weights tear, unweighted, far and
spiked vertices, five bones on a vertex, an elbow out in the air, a forearm that does not point at its hand, a missing neck, an
arm 12 cm out of mirror, forearm skin on the spine, a wrist on an open seam, the same body under Mixamo, Blender and Rigify names,
and a creature with no names at all.

## With Rig Doctor and Handhold

Rig Check says whether the whole body will animate. [Rig Doctor](rig-doctor.md) goes deeper at the wrists (sleeves over the hand,
cuffs, the glove blend), and Handhold then solves the hand's hold on a body that bends cleanly. Run Rig Check first on anything new.
