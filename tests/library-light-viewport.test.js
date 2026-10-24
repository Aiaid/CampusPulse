import { describe, expect, it } from 'vitest';
import { libraryLightViewport } from '../src/campus/library-light-viewport.js';

const bounds = { left: 548, top: 188, width: 191, height: 147 };
const crop = (origin = { left: 0, top: 0 }, scale = 1, width = 1920, height = 1080, ratio = 2) =>
  libraryLightViewport(bounds, origin, scale, width, height, ratio);

describe('library atlas viewport allocation', () => {
  it('allocates the projected library footprint at full DPR, not the whole display', () => {
    const result = crop();
    expect(result).toMatchObject({ left: 547.5, top: 187.5, pixelWidth: 384, pixelHeight: 296 });
    expect(result.pixelWidth * result.pixelHeight).toBeLessThan(1920 * 1080 * 4 / 70);
    expect(result.destination).toEqual(bounds);
  });

  it.each([
    [{ left: -739, top: 0 }], [{ left: 1372, top: 0 }],
    [{ left: 0, top: -335 }], [{ left: 0, top: 892 }],
  ])('releases a fully offscreen or exactly touching atlas at %o', origin => {
    expect(crop(origin)).toBeNull();
  });

  it('keeps fractional panning and zoom on the original device pixel grid', () => {
    const result = crop({ left: -371.27, top: -57.93 }, 1.317, 800, 600, 2);
    expect(Number.isInteger(result.left * 2)).toBe(true);
    expect(Number.isInteger(result.top * 2)).toBe(true);
    const { destination } = result;
    // Translation back from the local canvas reproduces the global destination.
    expect((destination.left - result.left) * 2 + result.left * 2).toBeCloseTo(destination.left * 2, 10);
    expect((destination.top - result.top) * 2 + result.top * 2).toBeCloseTo(destination.top * 2, 10);
    expect(result.left).toBeLessThan(destination.left);
    expect(result.left + result.width).toBeGreaterThan(destination.left + destination.width);
  });

  it('clips partial visibility without rescaling or truncating source coordinates', () => {
    const result = crop({ left: -600.25, top: -200.75 }, 1, 100, 80, 2);
    expect(result).toMatchObject({ left: 0, top: 0, width: 100, height: 80,
      pixelWidth: 200, pixelHeight: 160,
      destination: { left: -52.25, top: -12.75, width: 191, height: 147 } });
  });

  it('caps extreme zoom at viewport storage, including fractional viewport edges', () => {
    const result = crop({ left: -54800, top: -18800 }, 100, 800.25, 600.75, 2);
    expect(result).toMatchObject({ left: 0, top: 0, pixelWidth: 1601, pixelHeight: 1202 });
    expect(result.destination.width).toBe(19100);
  });

  it.each([[0, 100], [100, 0], [NaN, 100]])('avoids allocations for invalid viewport %s x %s', (width, height) => {
    expect(crop(undefined, 1, width, height)).toBeNull();
  });
});
