---
name: rig-doctor
description: Check and fix a rigged character's skin at the wrists and hands, headless in Blender: sleeves reaching over the hand, cuffs weighted to the hand or fingers, loose scraps near the arm, a wrist that pinches when it rolls or bends, and seams whose two sides follow different bones. Use when a character's wrists or hands contort, twist, pinch or show the sleeve through the hand in a game, after a character comes out of an auto-rigger (Mixamo, UniRig, AccuRig), before solving holds with Handhold, or when asked to fix a model's bones or skin weights.
---

# Rig Doctor

`scripts/rig-doctor.mjs` (in the Handhold repository) runs `blender/rig_doctor.py` in Blender with no window. When this skill has
been copied into another project, that project's CLAUDE.md says where Handhold is installed: run the script by its full path.

## The loop

1. **Check, with pictures.**

   ```bash
   node scripts/rig-doctor.mjs check <model> --shots <out>/before --report <out>/before.json
   ```

   Read the findings it prints, then look at `<out>/before_sheet.png` with the Read tool. Rows: left arm from above, left from the
   side, right from above, right from the side. Columns in pairs (by mesh, then by follow, red = follows the hand): rest, rolled 90,
   bent 60 to the palm, bent 60 back.

2. **Fix the source, not the export.** If the model came from a `.blend` (it usually did), fix that file and save a new one, so
   its actions are kept and the game's own export script still works:

   ```bash
   node scripts/rig-doctor.mjs fix <model.blend> --save <model_fixed.blend> --shots <out>/after --report <out>/after.json
   ```

   With no step named, every step runs (`--trim --scraps --cuff --blend --seams`). Name steps to run only some.

3. **Prove it.** The fix re-checks by itself and exits 0 when every arm passes. Look at `<out>/after_sheet.png` next to the
   before sheet. Tell the user the numbers before and after (over the hand, cuff, scraps, wrist thickness kept).

4. **Export and look in the game.** Run the project's export with the fixed `.blend`, then check the result where it is used
   (for a game: its own offscreen pictures of the character holding things, from both sides).

## Reading the findings

| Finding | Usual cause | Step |
|---|---|---|
| `N vertices of <mesh> reach up to X cm past the wrist` | the generator's sleeve flares over the hand | `--trim` |
| `N vertices of the sleeve follow the hand more than a cuff should` | auto-weights spread the hand onto the cuff | `--cuff` |
| `a loose scrap of <mesh>` | a floating shard from the image-to-3D mesher | `--scraps` |
| `the wrist keeps N% of its thickness when the hand is ...: it pinches` | the glove turns at one ring | `--blend`, then more `--blend-len` |
| `N seam points have different weights` | UV splits or two meshes meeting | `--seams` |

## Options worth changing

- `--cuff-follow 0.2`: how much the sleeve's rim turns with the hand. 0 keeps the cuff dead still (the glove turns inside it);
  more than 0.3 brings back the cuff folding.
- `--blend-len 0.06`: metres over which the glove goes from forearm to hand. Longer spreads a roll further up the forearm.
- `--trim-past 0.005`: how far past the wrist line a sleeve may reach. Raise it for a deliberately long cuff.
- `--side l|r|both`, `--hand-meshes a,b` when the guess is wrong.

## What it cannot do

It does not add twist bones, so a game that puts a whole forearm roll on the hand bone still wrings the wrist. Share the roll
with the forearm in the game's IK (40% is a good start). It also does not retopologise: a sleeve built as one solid with the hand
needs remeshing first.
