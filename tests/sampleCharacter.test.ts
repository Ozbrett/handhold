import { describe, expect, it } from 'vitest';
import { buildArmRig } from '../src/app/armIk';
import { buildCharacterRig } from '../src/app/characterRig';
import { bakeToTriMesh, looksLikeCharacter, subsetBaked } from '../src/app/loaders';
import { sampleCharacter } from '../src/app/samples';
import { analyzeHandMesh } from '../src/core/hand/analyze';
import { locateHands } from '../src/core/hand/locate';

describe('sample player', () => {
  const source = sampleCharacter();
  const full = bakeToTriMesh(source);
  const found = locateHands(full.mesh, { character: looksLikeCharacter(source) });

  it('counts as a character with a left and a right hand', () => {
    expect(looksLikeCharacter(source)).toBe(true);
    expect(found.kind).toBe('character');
    expect(found.hands.map((h) => h.handedness).sort()).toEqual(['left', 'right']);
    for (const h of found.hands) expect(h.fingers).toBe(5);
  });

  it('has finger bones and an arm the grips can drive, on both sides', () => {
    for (const h of found.hands) {
      const baked = subsetBaked(full, h.keep);
      const analysis = analyzeHandMesh(baked.mesh, { flipPalm: h.flip });
      expect(analysis.spec.fingers.length).toBe(5);
      const char = buildCharacterRig(source, full, h.keep, analysis);
      expect(char).not.toBeNull();
      expect(char!.fingerBones).toBeGreaterThanOrEqual(12);
      expect(char!.handBone.name).toBe(h.handedness === 'left' ? 'LeftHand' : 'RightHand');
      const arm = buildArmRig(char!, analysis.model.frame);
      expect(arm).not.toBeNull();
      expect(arm!.upperLength).toBeCloseTo(0.28, 2);
      expect(arm!.foreLength).toBeCloseTo(0.26, 2);
    }
  });
});
