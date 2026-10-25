import { describe, expect, test } from 'vitest';
import { nativeCanopyCrop } from '../../src/campus/campus-tree-masks.js';

const mask = { left: 128, top: 256, width: 128, height: 128, heightProxy: 5.5,
  canvas: { width: 256, height: 256 } };
describe('native canopy painter depth', () => {
  test('a behind actor and ground shadows see the entire unchanged crown alpha', () => {
    expect(nativeCanopyCrop(mask)).toEqual({ top: 256, height: 128, sourceTop: 0, sourceHeight: 256 });
    expect(nativeCanopyCrop(mask, 250)).toEqual(nativeCanopyCrop(mask));
  });
  test('foreground actors are never erased by a crown behind their feet', () => {
    expect(nativeCanopyCrop(mask, 390)).toBeNull();
    expect(nativeCanopyCrop(mask, 389.5)).toBeNull();
  });
  test('crossing a crown depth crops source rows without stretching or changing alpha', () => {
    expect(nativeCanopyCrop(mask, 300)).toEqual({ top: 294.5, height: 89.5, sourceTop: 77, sourceHeight: 179 });
  });
});
