import { expect, it } from 'vitest';
import { allWorkPurposes, availableWorkPurposes, sameWorkPurposes, validateWorkPurposes } from '../src/admin/work-purposes.js';

it('offers only target place purposes, with a legacy fallback and all unlocated options', () => {
  expect(availableWorkPurposes({ kind: 'parking' })).toEqual(['parking']);
  expect(availableWorkPurposes({ kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'] })).toEqual(allWorkPurposes);
  expect(availableWorkPurposes(null)).toEqual(allWorkPurposes);
});
it('rejects empty, duplicate, unsupported and outside-place purpose selections', () => {
  for (const kinds of [[], ['parking', 'parking'], ['unknown'], ['parking']]) expect(() => validateWorkPurposes(kinds, ['activity'])).toThrow('至少选择');
  expect(validateWorkPurposes(['parking', 'elevator'], ['activity', 'parking', 'elevator'])).toEqual(['parking', 'elevator']);
});
it('reconciles purpose sets regardless of order without treating absent metadata as equal', () => {
  expect(sameWorkPurposes(['parking', 'activity'], ['activity', 'parking'])).toBe(true);
  expect(sameWorkPurposes(['activity'], ['activity', 'parking'])).toBe(false);
  expect(sameWorkPurposes(undefined, ['activity'])).toBe(false);
});
