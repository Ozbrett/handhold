# Rig Doctor: fixing a character's skin at the wrists

A hand can only hold something well if the arm it is on bends cleanly. Generated and auto-rigged characters often don't: the sleeve
reaches over the back of the hand, the cuff is weighted to the hand (so it twists and folds every time the wrist turns), loose
scraps of jacket float near the arm, and the glove turns at one ring of vertices, so the wrist pinches thin when it rolls.
None of that shows in a T-pose. All of it shows the moment a hand grips a gun.

Rig Doctor finds these faults, measures them, and fixes them. It runs headless in Blender (no window opens), so Claude can check a
character, fix it and prove the fix without anyone clicking.

```bash
node scripts/rig-doctor.mjs check <model> [--shots <prefix>] [--report <file.json>]
```

```bash
node scripts/rig-doctor.mjs fix <model> --save <fixed.blend> [--export <fixed.fbx>] [--shots <prefix>]
```

`<model>` is a `.blend`, `.fbx`, `.glb` or `.gltf`. Fix a `.blend` when you have one: its animations are kept, and you export from
it the way you already do. Blender is found at `$BLENDER`, or the newest one in the usual install folder.

Exit code 0 means every arm passes, 3 means something is left to fix (the findings say what), 1 is an error.

## What it checks

For each arm it finds the hand, the forearm and the upper arm by name (Mixamo, Unreal, Unity and plain `hand_l` styles all work),
and the hand meshes (any mesh mostly weighted to hand and finger bones, or `--hand-meshes a,b`). Then:

| Check | What it means | Passes when |
|---|---|---|
| over the hand | sleeve vertices more than 5 mm past the wrist line, over the hand | none |
| cuff | sleeve vertices weighted to a finger, or to the hand more than a cuff's rim should be | none |
| scraps | small loose pieces of a mesh near the arm (pieces joined only at UV seams count as one) | none |
| wrist | the hand rolled ±90°, bent ±60° and ±35°: how thick the ring of skin at the wrist stays | 75% or more every way |
| seams | points that sit together but have different weights, so the skin can open there | reported, not failed |
| influences | vertices that follow more than 4 bones (a game keeps 4 and drops the rest) | none |

## What it fixes

With no step named, `fix` runs all of them.

| Step | What it does |
|---|---|
| `--trim` | cuts sleeve geometry that reaches past the wrist (`--trim-past`, 0.005 m, is what it keeps) |
| `--scraps` | deletes loose scraps near the arms (`--scrap-max`: the largest share of a mesh one may be, 0.03) |
| `--cuff` | takes the sleeve's weights off the fingers; near the wrist the hand's share fades from `--cuff-follow` (0.2) at the rim to nothing `--cuff-band` (0.08 m) up the forearm |
| `--blend` | the part of the hand mesh inside the sleeve blends from forearm to hand over `--blend-len` (0.06 m), so a turn spreads along the wrist instead of folding at one ring |
| `--seams` | points that sit together (UV splits, the sleeve's rim on the glove) get one shared set of weights |

Whatever steps run, the fix ends by keeping every vertex to its 4 strongest bones, because the steps above mix weights and
Unity, three.js and glTF all skin with 4.

`--save x.blend` keeps the whole fixed scene, animations too. `--export x.fbx|x.glb` also exports it (FBX with its actions and
no leaf bones).

## The pictures

`--shots <prefix>` renders `<prefix>_sheet.png`: each wrist from above and from the side, at rest, rolled 90°, bent 60° to the
palm and bent 60° back, once coloured by mesh and once by how much each point follows the hand (red follows it, blue stays with
the forearm). Look at the sheet before and after a fix: a good wrist has the sleeve ending at the wrist, the glove turning inside
it without poking through, and the red fading up the forearm rather than stopping dead at one line.

## A real case

The Deep Shift crew body (Strelok, image-to-3D, rigged on Mixamo's skeleton) failed every check: up to 11.5 cm of sleeve over each
hand, 176 and 148 cuff vertices on the hand and fingers, and the wrist keeping 79% of its thickness at worst.

```bash
node scripts/rig-doctor.mjs fix strelok_live3.blend --save strelok_live4.blend --shots out/strelok_fixed
```

Cut 70 sleeve vertices, eased 672 cuff weights, blended 40 glove vertices, welded 7041 seam points, kept 229 vertices to
4 bones. Every arm passes, and the wrist keeps 83% at worst.

## In the app

Load the fixed character in Handhold, find a grip, then turn on **On my model** and **Weights**: the whole character is coloured
the same way as the sheet (red follows the hand, blue the forearm). **Wrist test** adds Roll and Bend sliders that turn the hand on
its forearm, so you can watch the cuff and glove while the weights do their work.

## With Claude

The skill in `.claude/skills/rig-doctor` tells Claude when and how to run it: when a hand, wrist or sleeve looks wrong in a game,
when a new character comes out of an auto-rigger, or before solving holds with Handhold. Copy it into a game project the same
way as the Handhold skill (see [with-claude.md](with-claude.md)).
