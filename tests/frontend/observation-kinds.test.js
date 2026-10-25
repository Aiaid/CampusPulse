import { describe, expect, test } from 'vitest';
import { formatObservationKinds, observationKinds, observationKindLabels } from '../../src/shared/observation-kinds.js';

describe('shared place observation purposes', () => {
  test('uses the explicit set ahead of the legacy primary and preserves its order', () => {
    const place = Object.freeze({ kind: 'activity', observation_kinds: Object.freeze(['elevator', 'parking', 'elevator', 'unknown']) });
    expect(observationKinds(place)).toEqual(['elevator', 'parking']);
    expect(formatObservationKinds(place)).toBe('电梯观测 · 电动车监控');
    expect(formatObservationKinds(['activity', 'parking', 'elevator'])).toBe('活动监测 · 电动车监控 · 电梯观测');
  });
  test('supports legacy places and empty data without inventing a purpose', () => {
    expect(observationKinds({ kind: 'parking' })).toEqual(['parking']);
    expect(observationKinds({ kind: 'elevator', observation_kinds: [] })).toEqual(['elevator']);
    expect(observationKinds({ kind: 'activity', observation_kinds: ['invalid'] })).toEqual(['activity']);
    expect(observationKinds({})).toEqual([]);
    expect(observationKinds(null)).toEqual([]);
    expect(formatObservationKinds(null)).toBe('');
    expect(Object.keys(observationKindLabels)).toEqual(['activity', 'parking', 'elevator']);
  });
});
