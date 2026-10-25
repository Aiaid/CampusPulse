import { describe, expect, it } from 'vitest';
import { initialDataMode } from '../../src/campus/data-mode';

describe('delivery data mode links', () => {
  it('keeps explicit source selection ahead of site defaults', () => {
    expect(initialDataMode('?mode=field', 'demo')).toBe('field');
    expect(initialDataMode('?mode=replay&place=library', 'demo')).toBe('replay');
    expect(initialDataMode('?mode=demo', 'field')).toBe('demo');
  });
  it('uses field for place links and unavailable or invalid defaults', () => {
    expect(initialDataMode('?place=library', 'demo')).toBe('field');
    expect(initialDataMode('?mode=unknown')).toBe('field');
    expect(initialDataMode('', 'invalid')).toBe('field');
    expect(initialDataMode('', 'demo')).toBe('demo');
  });
});
