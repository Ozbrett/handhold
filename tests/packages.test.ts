import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, gzip, stableId, tar, textFile, zip } from '../src/app/archive';
import { blenderPackage, godotPackage, unityPackage } from '../src/app/packages';

const decoder = new TextDecoder();

/** Reads a TAR back into names and contents. */
function untar(data: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (let at = 0; at + 512 <= data.length; ) {
    const head = data.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const name = decoder.decode(head.subarray(0, 100)).replace(/\0.*$/, '');
    const size = parseInt(decoder.decode(head.subarray(124, 135)), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : head[i];
    expect(parseInt(decoder.decode(head.subarray(148, 154)), 8)).toBe(sum);
    out.set(name, data.slice(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Reads a stored ZIP back into names and contents, from its central directory. */
function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = data.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = data.slice(start, start + size);
    expect(crc32(body)).toBe(view.getUint32(at + 16, true));
    out.set(name, body);
    at += 46 + nameLength;
  }
  return out;
}

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const pose = { format: 'handhold-pose', version: 3, handBone: 'Hand', note: "it's '''quoted'''", bones: [] };

describe('archives', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('writes a ZIP that reads back', () => {
    const files = [textFile('a/one.txt', 'hello'), textFile('two.txt', ''), { path: 'bin', data: new Uint8Array([0, 255, 7]) }];
    const back = unzip(zip(files));
    expect([...back.keys()]).toEqual(['a/one.txt', 'two.txt', 'bin']);
    expect(decoder.decode(back.get('a/one.txt'))).toBe('hello');
    expect([...back.get('bin')!]).toEqual([0, 255, 7]);
  });
  it('writes a gzipped TAR that reads back', async () => {
    const files = [textFile('x/asset', 'a'.repeat(700)), textFile('x/pathname', 'Assets/X.cs')];
    const back = untar(gunzipSync(await gzip(tar(files))));
    expect(decoder.decode(back.get('x/pathname'))).toBe('Assets/X.cs');
    expect(back.get('x/asset')!.length).toBe(700);
  });
  it('gives the same id for the same name', () => {
    expect(stableId('Assets/a.json')).toMatch(/^[0-9a-f]{32}$/);
    expect(stableId('Assets/a.json')).toBe(stableId('Assets/a.json'));
    expect(stableId('Assets/a.json')).not.toBe(stableId('Assets/b.json'));
  });
});

describe('engine packages', () => {
  it('builds a Unity package with the scripts, their ids and the pose', async () => {
    const pkg = await unityPackage({ base: 'hero-holding-torch', pose, glb: null });
    expect(pkg.filename).toBe('hero-holding-torch.unitypackage');
    const back = untar(gunzipSync(await bytes(pkg.blob)));
    const paths = [...back].filter(([k]) => k.endsWith('/pathname')).map(([, v]) => decoder.decode(v));
    expect(paths).toEqual(['Assets/Handhold/HandholdGrip.cs', 'Assets/Handhold/Editor/HandholdMenu.cs', 'Assets/Handhold/hero-holding-torch.pose.json']);
    for (const [name, body] of back) {
      if (!name.endsWith('/asset.meta')) continue;
      expect(decoder.decode(body)).toContain(`guid: ${name.split('/')[0]}`);
    }
    const script = [...back].find(([, v]) => decoder.decode(v).includes('class HandholdGrip'));
    expect(script).toBeTruthy();
  });
  it('builds a Godot zip with the script, the pose and the model', async () => {
    const pkg = godotPackage({ base: 'hero-holding-torch', pose, glb: new Uint8Array([1, 2, 3]) });
    const back = unzip(await bytes(pkg.blob));
    expect([...back.keys()].sort()).toEqual(
      ['handhold/README.txt', 'handhold/handhold_grip.gd', 'handhold/hero-holding-torch.glb', 'handhold/hero-holding-torch.pose.json'].sort(),
    );
    expect(JSON.parse(decoder.decode(back.get('handhold/hero-holding-torch.pose.json')))).toEqual(pose);
    expect(decoder.decode(back.get('handhold/handhold_grip.gd'))).toContain('extends SkeletonModifier3D');
  });
  it('builds a Blender zip whose script carries the pose', async () => {
    const pkg = blenderPackage({ base: 'hero-holding-torch', pose, glb: new Uint8Array([1, 2, 3]) });
    const back = unzip(await bytes(pkg.blob));
    const script = decoder.decode(back.get('apply_hero_holding_torch.py'));
    expect(script).not.toContain('__POSE_JSON__');
    // the pose sits in a raw triple-quoted string: nothing in it may end that string early
    const inner = script.slice(script.indexOf("r'''") + 4, script.indexOf("''')"));
    expect(JSON.parse(inner)).toEqual(pose);
    expect(back.has('hero-holding-torch.glb')).toBe(true);
  });
});
