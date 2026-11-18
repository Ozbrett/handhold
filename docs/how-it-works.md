# How Handhold works, and where it stops

## The steps

### Rigging the hand

Handhold finds the fingertips, traces each finger back to the palm and places the joints. It then inflates spheres from the bones until they touch the skin, so it knows how thick every finger is. It works out left or right, and which side is the palm. The mesh can be in any orientation and any unit.

Give it a whole character instead and it finds the hands, shows a pin on each, and uses the one you pick. If the character has its own bones (a Mixamo character, a rigged VR hand), the grip is applied to those: its finger bones are turned to match by position, not by name, and the prop is attached under its hand bone. The export is then your whole model with its original bone names.

"Edit bones" shows the hand on its own with its joints as dots. Drag one to move it and the skin is fitted again. A curl-test slider bends every finger so you can see how the mesh deforms, a Weights view paints the hand by which bone each part of the skin follows, and a slider turns the thumb's bending direction if it curls the wrong way.

### Taking the object

Any mesh works. One that is far too big or small next to the hand is assumed to be in different units and is resized; a slider lets you correct that.

### Searching for grips

Around the point you click, Handhold tries the hand at many angles and wraps each finger onto the surface. The joints close one at a time from the knuckle outwards, each stopping when the finger meets the object, so a finger lies along the object with as much of its length touching as the shape allows instead of landing on its tip. Each grip says how much of the fingers is touching ("along 13 of 15 finger segments").

For a trigger or a button, choose a finger and click where its tip should rest. That finger bends to reach it while the rest keep the grip.

### Checking them physically

Each contact can push on the object within its friction cone. A small linear program finds the least total force that balances the object's weight. Grips that support from below or wrap around score well, pinches need a hard squeeze, and some contacts cannot hold at all. Those are marked as slipping. A grip that would need more than twelve times the object's weight in squeeze is reported as slipping too.

### Holding with both hands

On a character with two usable hands, choose "Both hands" and mark a spot for each. Each hand's grips are searched at its own spot, pairs whose hands would overlap are dropped, and each pair is checked as one grip, with both hands sharing the load. The first hand carries the object. The second follows it wherever the arm goes, and the Arm step says if it falls short.

### Placing the arm

On a character with arm bones, drag the item to where it should be held. The hand, wrist and elbow go with it (two-bone inverse kinematics), and a sphere shows how far the arm reaches. Three sliders turn the item on the spot. You can switch the arrows to the hand instead: then the hand moves, and the sliders swing the item about the wrist.

The whole arm is solved, collarbone to hand: the collarbone takes a share of a reach the arm alone cannot make, the elbow swings out of the way of the body (kept out of capsules round the chest and head), and a target out of reach is reported by how far it is short instead of being met by a stretched arm. The wrist, the forearm's twist and, when that is not enough, the elbow's height are worked out inside the range a human wrist turns. If the joints run out of range, the step says how many degrees the item is off. The Character tab sets how far each joint may turn, and how softly it slows near the end of its range.

### Saving poses, animations and looks

The Animations tab keeps a list. Each entry is one of three things:

- a **pose**, a still position of the arm;
- an **animation**, a movement that plays once or loops. Ready-made ones depend on the kind of item: use, show and turn over for everyday things; swing, ready and turn over for tools; fire, aim and reload for weapons; idle, walk and run for all of them;
- a **look**, which stores the arm's position over a grid of directions the player can look in, so the item rises when the player looks up, drops when they look down and swings round to the left and right.

Everything in the list goes into every export under its name.

## Checking a whole pose

A grip that holds is not yet a pose a player should see. `src/check/poseCheck.ts` checks the whole body as drawn (the character's own skin under its own bones), and the same checks run on a hold (`scripts/hold-check.mjs`), on every frame of a motion (`scripts/motion-check.mjs`) and in the tests. Every check has an id, a value, a limit and a sentence saying what it measures.

| Check | Measures | Limit |
|---|---|---|
| `<side>.wrist.*`, `<side>.elbow.*` | How far the wrist bends each way and twists on its forearm, how far the elbow bends or bends backwards | A human range (the wrist limits the arm solver uses) |
| `<side>.finger.flex`, `.extend`, `.side` | Each finger joint curled, bent back or bent sideways past its own range | 0 degrees past it |
| `<side>.skin.<joint>.tear` | The longest skin edge at the wrist, elbow or shoulder against its rest length | 1.8 times |
| `<side>.skin.<joint>.pinch` | The smallest skin triangle there against its rest area; a triangle folded over (turned more than 90 degrees from its neighbour, where at rest they agreed) counts as 0 | Wrist 0.2, elbow 0.1, shoulder 0.05: the inside of an elbow and the front of an armpit squash in every body |
| `<side>.skin.<joint>.collapse` | How near the joint the ring of skin round it has fallen, against rest | 0.7 of its rest distance |
| `body.<a>.in.<b>` | How deep the skin of one part is inside another (hand in hand, forearm in its upper arm, arms in the chest and head), less how deep it was at rest | 2 mm |
| `item.<x>.has.<part>`, `item.<x>.in.<part>` | The skin inside an item, and the item's corners and edges inside the skin | 2 mm for hands, 1 mm otherwise |
| `<side>.elbow.in` | How far the elbow points in at the body, past straight down the side | 15 mm |
| `item.<x>.up`, `item.<x>.away` | A gun's top from up, its muzzle from where the body faces; a tool's head from where the body faces | 90, 100 and 135 degrees |
| `<side>.grip.*` | The palm on the named grip pieces and facing them, the fingertips on them, the named fingers round them, the thumb on the other side | 12 mm, 65 degrees, 10 mm, 150 degrees, 30 degrees |

How the body's volume is measured: each bone of the chest, head and arms carries a rod, an elliptic cylinder cut into four slices along the bone, each slice as wide and deep as the skin around that stretch of bone (60 percent of it, so a rod stays inside the skin). A point's depth is how far inside a slice it is, measured across and along, so a point past the end of a bone is not inside it. An upper arm is measured against the chest without its own collarbone, which the top of the shoulder slides over as the arm swings. The skin that blends two parts (a joint's own skin) is not counted in either.

Its limits: rods simplify the skin, so a bulky coat or vest is measured by the bones inside it, not by its padding, and depth is good to a few millimetres. Items are measured against their closed meshes, so an item made of open sheets is measured poorly. The checks know nothing of clothing that should crumple.

A sheet (`src/check/sheet.ts`) is drawn by a small software rasteriser, no browser: front, left, right, back, above and the eye, with every faulty skin triangle painted red over everything, so a fault hidden inside a vest still shows.

### Animations with attachments

A motion is built from what each hand is on (`src/check/attach.ts`): a span says this hand is on this part (or the item) from here to there, at this place on it, with these finger turns. A hand on a part goes wherever the part goes, so it cannot slip; between spans it blends from where it let go to where it takes hold next. Parts are keyed in the item's own space, and every key, span and blend eases with a quintic (no jump in position, speed or acceleration), so a clip that starts and ends on its hold leaves and lands on it from still. Each frame is posed by the whole-arm solver. The reload (`src/check/reload.ts`) is built this way.

## What works

- A single hand, cut anywhere from the wrist to the elbow, with the fingers apart. Three to five fingers.
- A whole character or a file with two hands, as long as the hands have separate fingers.
- Hollow gloves and double-walled meshes, and hands with loose pieces such as nails or seams. The inner wall and the loose pieces copy the skin beside them, so they do not poke through when the hand bends.
- Low-poly and high-poly meshes, from about a thousand vertices to a few hundred thousand. The tests auto-rig a real 1,360-vertex hand and land the finger joints within about 1 cm of its original skeleton.
- GLB, FBX, OBJ, STL and PLY files, for both the hand and the object.

## What does not work yet

- Fists, mittens, and hands whose fingers are fused together or touching along their length. On a character, such hands are reported as having no usable hand.
- Hands already posed as a fist or wrapped around something. The fingers have to be open enough to tell apart.
- Objects made of flat single-sided sheets.
- Precision pinches such as holding a pen. The search is built around the palm.
- A `.gltf` with separate `.bin` or texture files. Export a single `.glb` instead.
- Rigs with extra bones between the upper arm, forearm and hand.

## Things to know

- Joints are placed from typical human proportions, so stylised hands may need their bones nudged in "Edit bones".
- Finger collision uses the fitted spheres, not the exact skin, so fingertips can sit a millimetre or two off the surface.
- On a whole character the hand is solved with its joints on the character's own finger pivots and drawn with the character's own weights, and only bone rotations are exported. What is drawn, measured and exported is the same skin: the tests read an exported pose file back onto a fresh copy of the character and find the fingers within a millimetre of where the app drew them.
- The wrist and forearm limits are typical human ones, since model files do not carry them. You can change them on the Character tab.
- Rigs without forearm twist bones (Mixamo) put half the forearm twist on the forearm bone and half on the hand bone, so a large twist can pinch the skin at the wrist or elbow.
- In a two-handed grip the second arm reaches with plain two-bone inverse kinematics in the engines: the wrist limits apply in the app, not in the engine scripts. A pair is not checked for the forearms crossing each other.
- A fingertip placed on a spot is not checked for passing through the object on its way there.
- Objects with hundreds of thousands of triangles work, but the grip search takes 5 to 15 seconds instead of 2.
- The Godot script has not been run inside Godot yet. The Unity and Blender exports are checked bone by bone ([development.md](development.md)).
