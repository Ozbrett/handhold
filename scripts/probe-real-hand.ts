/**
 * Developer probe: auto-rig the real (WebXR generic) hand mesh with its
 * skeleton thrown away, then compare against the skeleton it shipped with.
 * Run with: npx vite-node scripts/probe-real-hand.ts
 */
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { loadGlbHand } from '../tests/helpers/glb';

const side = process.argv[2] ?? 'right';
const hand = loadGlbHand(`node_modules/@webxr-input-profiles/assets/dist/profiles/generic-hand/${side}.glb`);
console.log('vertices', hand.mesh.positions.length / 3, 'triangles', hand.mesh.indices.length / 3);
const a = analyzeHandMesh(hand.mesh);
console.log('handedness', a.model.handedness, 'palm confidence', a.palmConfidence.toFixed(2), 'warnings', a.warnings);
console.log('fingers', a.spec.fingers.map((f) => f.name).join(', '));
const truthNames: Record<string, string[]> = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};
for (const f of a.spec.fingers) {
  const names = truthNames[f.name];
  if (!names) continue;
  const pts = [...f.joints, f.tip];
  const errs = pts.map((p, k) => (p.distanceTo(hand.joints[names[k]]) * 1000).toFixed(1));
  // where the true joints sit along the finger, as fractions of true length from the tip
  const t = names.map((n) => hand.joints[n]);
  const seg = [t[0].distanceTo(t[1]), t[1].distanceTo(t[2]), t[2].distanceTo(t[3])];
  const total = seg[0] + seg[1] + seg[2];
  console.log(
    f.name.padEnd(7),
    'err mm (base..tip):',
    errs.join(' '),
    '| radii mm',
    f.radii.map((r) => (r * 1000).toFixed(1)).join(' '),
    '| true fractions from tip',
    (seg[2] / total).toFixed(2),
    ((seg[2] + seg[1]) / total).toFixed(2),
    '| true len mm',
    (total * 1000).toFixed(0),
    'found',
    ((pts[0].distanceTo(pts[1]) + pts[1].distanceTo(pts[2]) + pts[2].distanceTo(pts[3])) * 1000).toFixed(0),
  );
}
console.log('wrist err mm', (a.spec.wrist.distanceTo(hand.joints['wrist']) * 1000).toFixed(1));
console.log('palm spheres', a.model.spheres.filter((s) => s.finger < 0).length, 'finger spheres', a.model.spheres.filter((s) => s.finger >= 0).length);
console.log('up', a.spec.up.toArray().map((v) => v.toFixed(2)).join(' '), 'normal', a.spec.normal.toArray().map((v) => v.toFixed(2)).join(' '));
console.log('size', a.model.size.toFixed(3), 'palm', a.spec.palmLength.toFixed(3), a.spec.palmWidth.toFixed(3));

// calibration helpers: where do true joints sit in the detected palm frame?
{
  const { wrist, up, side, normal, palmLength, palmWidth } = a.spec;
  const rel = (name: string) => {
    const d = hand.joints[name].clone().sub(wrist);
    return `${name}: up ${(d.dot(up) / palmLength).toFixed(2)} palmLen, side ${(d.dot(side) / palmWidth).toFixed(2)} palmWidth, normal ${(d.dot(normal) * 1000).toFixed(1)}mm`;
  };
  for (const n of ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip', 'index-finger-metacarpal', 'pinky-finger-metacarpal', 'middle-finger-phalanx-proximal']) console.log(rel(n));
  const th = a.spec.fingers[0];
  const t = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'].map((n) => hand.joints[n]);
  console.log('thumb true seg mm', [0, 1, 2].map((i) => (t[i].distanceTo(t[i + 1]) * 1000).toFixed(1)).join(' '), 'apex->true joints mm', t.map((p) => (p.distanceTo(th.tip) * 1000).toFixed(1)).join(' '));
  console.log('thumb found seg mm', [...th.joints, th.tip].slice(1).map((p, i) => (p.distanceTo([...th.joints, th.tip][i]) * 1000).toFixed(1)).join(' '));
  for (const f of a.spec.fingers.slice(1)) {
    const names = truthNames[f.name];
    const tt = names.map((n) => hand.joints[n]);
    console.log(f.name, 'apex->true joints mm (mcp,pip,dip,tip)', tt.map((p) => (p.distanceTo(f.tip) * 1000).toFixed(1)).join(' '), '| found', f.joints.map((p) => (p.distanceTo(f.tip) * 1000).toFixed(1)).join(' '));
  }
}
