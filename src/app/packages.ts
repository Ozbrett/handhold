import blenderScript from '../../blender/handhold_apply.py?raw';
import godotScript from '../../godot/handhold_grip.gd?raw';
import unityRuntime from '../../unity/HandholdGrip.cs?raw';
import unityMenu from '../../unity/HandholdMenu.cs?raw';
import { type ArchiveFile, gzip, stableId, tar, textFile, zip } from './archive';

export type Engine = 'unity' | 'godot' | 'blender';

export interface PackageInput {
  /** File-name stem, e.g. "hero-holding-torch". */
  base: string;
  /** The pose data (see exporter.ts). */
  pose: unknown;
  /** The posed model as a GLB, or null to leave it out. */
  glb: Uint8Array | null;
}

export interface EnginePackage {
  blob: Blob;
  filename: string;
  /** Every file inside, for tests and for showing what was written. */
  files: string[];
}

const SCRIPT_META = (guid: string) =>
  `fileFormatVersion: 2\nguid: ${guid}\nMonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
const TEXT_META = (guid: string) =>
  `fileFormatVersion: 2\nguid: ${guid}\nTextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
const DEFAULT_META = (guid: string) =>
  `fileFormatVersion: 2\nguid: ${guid}\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;

// Fixed ids for the two scripts, so importing a second grip replaces them instead of adding copies.
const UNITY_RUNTIME_ID = '7c1f0a52e9b34d0e8a6f3d2b91c4e7a5';
const UNITY_MENU_ID = '2e8d6b4fa1c9407bb35e9f6d0c7a8b13';

/**
 * A .unitypackage: the grip player script, a menu command that sets it up on
 * the selected character, and the pose. Import it and everything lands in
 * Assets/Handhold.
 */
export async function unityPackage(input: PackageInput): Promise<EnginePackage> {
  const json = JSON.stringify(input.pose, null, 2);
  const assets: { path: string; data: Uint8Array; meta: string }[] = [];
  const ids: string[] = [];
  const push = (path: string, data: Uint8Array, meta: (guid: string) => string, guid = stableId(path)) => {
    ids.push(guid);
    assets.push({ path, data, meta: meta(guid) });
  };
  push('Assets/Handhold/HandholdGrip.cs', textFile('', unityRuntime).data, SCRIPT_META, UNITY_RUNTIME_ID);
  push('Assets/Handhold/Editor/HandholdMenu.cs', textFile('', unityMenu).data, SCRIPT_META, UNITY_MENU_ID);
  push(`Assets/Handhold/${input.base}.pose.json`, textFile('', json).data, TEXT_META);
  if (input.glb) push(`Assets/Handhold/${input.base}.glb`, input.glb, DEFAULT_META);
  const entries: ArchiveFile[] = [];
  assets.forEach((a, i) => {
    entries.push({ path: `${ids[i]}/asset`, data: a.data });
    entries.push(textFile(`${ids[i]}/asset.meta`, a.meta));
    entries.push(textFile(`${ids[i]}/pathname`, a.path));
  });
  const packed = await gzip(tar(entries));
  return {
    blob: new Blob([packed as BlobPart], { type: 'application/gzip' }),
    filename: `${input.base}.unitypackage`,
    files: assets.map((a) => a.path),
  };
}

/** The names of everything saved on the Animations tab, as written into the pose: poses, then animations, then looks. */
function savedIn(pose: unknown): string[] {
  type Named = { name: string }[];
  const arm = (pose as { arm?: { poses?: Named; clips?: Named; looks?: Named } | null } | null)?.arm;
  return [...(arm?.poses ?? []), ...(arm?.clips ?? []), ...(arm?.looks ?? [])].map((x) => x.name);
}

/** A ZIP to unpack into a Godot project: the modifier script, the pose, and the posed model. */
export function godotPackage(input: PackageInput): EnginePackage {
  const saved = savedIn(input.pose);
  const files: ArchiveFile[] = [
    textFile('handhold/handhold_grip.gd', godotScript),
    textFile(`handhold/${input.base}.pose.json`, JSON.stringify(input.pose, null, 2)),
    textFile(
      'handhold/README.txt',
      [
        'Handhold grip for Godot 4.3 or newer',
        '',
        '1. Unpack this folder into your project.',
        "2. Open your character's scene and add a HandholdGrip node as a child of its Skeleton3D.",
        `3. Drag ${input.base}.pose.json onto Pose in the Inspector. To put a prop in the hand, set Held Object.`,
        '',
        'Arm Mode chooses how the arm moves: Animation (your walk or idle moves it),',
        'Hold (it stays at the exported position) or Follow Camera.',
        ...(saved.length
          ? [
              '',
              'Saved poses, animations and looks',
              `This file has: ${saved.join(', ')}. Show one by name from your own script:`,
              `    $Skeleton3D/HandholdGrip.show_saved("${saved[0]}")`,
              'A pose stays. An animation plays, then the arm goes back to what it showed before',
              '(the "finished" signal tells you when). A look follows the camera up, down, left and right.',
              'show_saved("") hands the arm back to Arm Mode. Start With in the Inspector shows one from the start.',
            ]
          : []),
        ...(input.glb ? ['', `${input.base}.glb is the model already posed, with every animation in it, if you would rather use that.`] : []),
        '',
      ].join('\n'),
    ),
  ];
  if (input.glb) files.push({ path: `handhold/${input.base}.glb`, data: input.glb });
  return {
    blob: new Blob([zip(files) as BlobPart], { type: 'application/zip' }),
    filename: `${input.base}-godot.zip`,
    files: files.map((f) => f.path),
  };
}

/** A ZIP for Blender: the posed model, and a script that applies the grip to an armature already in a scene. */
export function blenderPackage(input: PackageInput): EnginePackage {
  // the pose travels inside the script, so there is only one file to run
  const json = JSON.stringify(input.pose).replace(/'''/g, "\\u0027\\u0027\\u0027");
  const script = blenderScript.replace('__POSE_JSON__', () => json);
  const name = `apply_${input.base.replace(/-/g, '_')}.py`;
  const saved = savedIn(input.pose);
  const files: ArchiveFile[] = [
    textFile(name, script),
    textFile(
      'README.txt',
      [
        'Handhold grip for Blender',
        '',
        ...(input.glb
          ? [`Quickest: File > Import > glTF 2.0 and choose ${input.base}.glb. The model arrives posed, holding the object,`, 'with every animation in the Action Editor.', '']
          : []),
        'To pose a character that is already in your scene instead:',
        "1. Select its armature (and the prop too, if you want it put in the hand).",
        `2. Scripting tab > Text > Open > ${name}, then Run Script.`,
        'The pose is keyed at the current frame.',
        ...(saved.length
          ? [
              '',
              'Saved poses, animations and looks',
              `The script also adds what you saved as Actions, named after the prop: ${saved.join(', ')}.`,
              'Pick one in Dope Sheet > Action Editor, or push it down to an NLA strip.',
              'Saved poses are pose assets as well, so they are in the Pose Library.',
              'A look is two Actions, Down-Up and Left-Right, with straight ahead in the middle.',
            ]
          : []),
        '',
      ].join('\n'),
    ),
  ];
  if (input.glb) files.push({ path: `${input.base}.glb`, data: input.glb });
  return {
    blob: new Blob([zip(files) as BlobPart], { type: 'application/zip' }),
    filename: `${input.base}-blender.zip`,
    files: files.map((f) => f.path),
  };
}

/** How to use what was saved on the Animations tab in each program; `example` is the name of one saved item. */
export const SAVED_STEP: Record<Engine, (example: string) => string> = {
  unity: (example) => `Show anything you saved by name from your own script: GetComponent<HandholdGrip>().Show("${example}");`,
  godot: (example) => `Show anything you saved by name from your own script: $Skeleton3D/HandholdGrip.show_saved("${example}")`,
  blender: () => 'Everything you saved arrives as Actions in the Action Editor. Saved poses are in the Pose Library as well.',
};

/** What to do with the downloaded file, in as few steps as it takes. */
export const NEXT_STEPS: Record<Engine, { title: string; steps: string[] }> = {
  unity: {
    title: 'In Unity',
    steps: [
      'Drag the .unitypackage into the Project window and press Import.',
      'Select your character in the scene. To put a prop in the hand, Ctrl-click the prop as well.',
      'Tools > Handhold > Add grip to selected character, then press Play.',
    ],
  },
  godot: {
    title: 'In Godot',
    steps: [
      'Unpack the zip into your project folder.',
      "Add a HandholdGrip node under your character's Skeleton3D.",
      'Drag the .pose.json onto Pose in the Inspector.',
    ],
  },
  blender: {
    title: 'In Blender',
    steps: [
      'Unpack the zip.',
      'New model: File > Import > glTF 2.0 and pick the .glb. It arrives posed and holding the object.',
      'A character already in your scene: select its armature, open the .py in the Scripting tab and press Run Script.',
    ],
  },
};
