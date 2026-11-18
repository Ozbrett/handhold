# The motion file: a game's own animation, checked by Handhold

A game that animates its character holding things (a reload, a draw, an idle sway) can hand each animation to Handhold to be checked frame by frame: every joint inside a human range, no skin torn or pinched, nothing inside anything, the item the right way up, and every hand that should stay on a part staying on it. `scripts/motion-check.mjs` reads the file, writes a contact sheet per clip and a `review.json`, and exits non-zero on any failure ([command-line.md](command-line.md)).

```bash
node scripts/motion-check.mjs --motion <folder>/motion.json --out <folder>/checked
```

## The file

One JSON file, `motion.json`, next to the item OBJs it names. Paths are relative to the JSON file unless absolute.

```json
{
  "format": "handhold-motion",
  "version": 1,
  "character": "D:/Game/Assets/Models/Crew_Strelok.fbx",
  "axes": "unity",
  "bones": ["root", "pelvis", "spine_01", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "index_01_r", "..."],
  "rest": [[px, py, pz, qx, qy, qz, qw], "... one per bone"],
  "items": [
    { "name": "akm", "file": "akm.obj", "style": "gun", "forward": [0, 0, 1], "up": [0, 1, 0] },
    { "name": "akm_mag", "file": "akm_mag.obj", "style": "part", "mates": "akm" }
  ],
  "clips": [
    {
      "name": "reload",
      "fps": 30,
      "view": "first",
      "loops": false,
      "contacts": [
        { "hand": "right", "item": "akm", "from": 0, "to": 2.4, "maxSlipMm": 1 },
        { "hand": "left", "item": "akm_mag", "from": 0.6, "to": 1.8, "maxSlipMm": 1 }
      ],
      "frames": [
        {
          "t": 0,
          "bones": [[px, py, pz, qx, qy, qz, qw], "... one per bone, in the order of the top-level bones"],
          "items": [[px, py, pz, qx, qy, qz, qw], "... one per item, in the order of the top-level items"],
          "camera": [px, py, pz, qx, qy, qz, qw]
        }
      ]
    }
  ]
}
```

### Top level

| Field | Meaning |
|---|---|
| `format`, `version` | `"handhold-motion"` and `1` |
| `character` | The character's model file (FBX, GLB). Read only; Handhold skins it itself to see where the drawn skin is |
| `axes` | `"unity"`: left-handed, Y up, metres, quaternions `[x, y, z, w]` as Unity writes them. Handhold mirrors X on the way in, as `game-holds.mjs` does: a position `(x, y, z)` becomes `(-x, y, z)` and a turn `(qx, qy, qz, qw)` becomes `(qx, -qy, -qz, qw)`. `"gltf"`: already right-handed, Y up, metres; nothing is mirrored |
| `bones` | The bone names written, as the character file spells them (Handhold matches on letters and digits only, so `mixamorig:RightHand` and `mixamorig_RightHand` are one bone). Write every bone that moves the drawn skin of the arms, hands, torso and head; bones left out stay at rest |
| `rest` | Each bone's world position and turn in the pose the skin was bound in (in Unity: `smr.bones[i]` world transform with the character in its bind pose, or `bindposes[i].inverse` taken to world), same space and axes as the frames. Handhold lines its own copy of the character up on these (a best-fit turn, scale and move), so it never depends on how either program imported the file |
| `items` | Every held thing. `file` is an OBJ of the thing in its **own** local space, metres, scale already applied. With `"axes": "unity"` the OBJ is in Unity axes too, unless the item says `"mirrored": true` (the OBJ is already flipped in X, as `HandholdExport` writes the `handhold/in` guns) |

### An item

| Field | Meaning |
|---|---|
| `name`, `file` | As above. A part that moves on its own during a clip (a magazine drawn out, a bolt, a pump, a lever) is its **own item** with its own OBJ and its own transform per frame |
| `style` | `"gun"`, `"tool"`, `"thing"` or `"part"`. A gun must be right way up with its muzzle away from the body; a tool's head must be at the far end from the hand; a thing and a part have no way up |
| `forward`, `up` | The item's own axes, in its own space: for a gun the way the muzzle points and the way its top faces; for a tool from the handle to the head. Default `[0, 0, 1]` and `[0, 1, 0]` (Unity's forward and up) |
| `mates` | Names of items this one is meant to sit in (a magazine in its gun): they are not checked against each other for overlap |

### A clip

| Field | Meaning |
|---|---|
| `name`, `fps` | The clip's name and how many frames a second were sampled. Sample at the game's own rate or faster; joint speed is measured between frames |
| `view` | `"first"`: the player's own view is checked and shown (the head camera, or `camera` per frame when given). `"third"`: seen from outside only |
| `loops` | `true` when the end must run straight back into the start (the first and last frames are compared in position and speed). A clip that does not loop is still compared with the hold pose when the clip names `hold` |
| `hold` | Optional: the name of another clip whose first frame is the hold this clip leaves from and returns to; the first and last frames must match it |
| `contacts` | Each span of time in which a hand must stay on an item. `hand` is `"right"` or `"left"`, `item` an item's name, `from` and `to` in seconds. Throughout the span the hand's skin, measured in the item's own space, must not move more than `maxSlipMm` (default 1) from where it was at `from`. That catches a hand that slides, lets go, or whose fingers open |
| `frames` | One per sampled moment: `t` in seconds, `bones` (world space, one per top-level bone, `[px, py, pz, qx, qy, qz, qw]`), `items` (world space, one per top-level item; an item not shown in a frame may be `null`), and optionally `camera` (the eye's world transform, looking down its own forward axis) |

## What is checked, per frame

The same whole-pose checks Handhold runs on its own poses ([how-it-works.md](how-it-works.md#checking-a-whole-pose)): joint ranges of the arms and fingers, the skin at wrist, elbow and shoulder, items against the drawn body and against each other, hand against hand, arms against the torso and head, the elbow out from the body, and each item's way up. Across frames: slip on each contact, the speed of every joint (a pop is a joint turning faster than a person can), and the start and end against each other or against the hold.

## What comes out

`<out>/<clip>/sheet.png` (about eight moments of the clip, each seen from the front, both sides, above and, for a first-person clip, the player's eye) and `<out>/review.json`:

```json
{
  "format": "handhold-review",
  "items": [
    {
      "name": "reload",
      "kind": "motion",
      "sheet": "reload/sheet.png",
      "pass": false,
      "checks": [{ "id": "contact", "about": "left on akm_mag", "pass": false, "value": 14.2, "unit": "mm", "limit": 1, "frame": 31, "note": "..." }],
      "verdict": "pending",
      "note": ""
    }
  ]
}
```

`node scripts/review.mjs approve|reject <name> --note "..." --dir <out>` records the verdict after the sheet has been looked at ([with-claude.md](with-claude.md)).
