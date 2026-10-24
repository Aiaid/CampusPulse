import { describe, expect, test } from 'vitest';
import { gisTileAvailability, selectTileLevel, visibleGisTiles } from '../../src/campus/gis-tiles.js';

const overview = { width: 1024, height: 640, scale: 1, translateX: 0, translateY: 0, overscan: 0 };

describe('official GIS tile detail selection', () => {
  test('matches original pixel density to displayed size and device pixel ratio', () => {
    expect(selectTileLevel(1, 1)).toBe(3);
    expect(selectTileLevel(1, 2)).toBe(3);
    expect(selectTileLevel(1.1, 2)).toBe(2);
    expect(selectTileLevel(2, 2)).toBe(2);
    expect(selectTileLevel(2.1, 2)).toBe(1);
    expect(selectTileLevel(8, 3)).toBe(1);
  });

  test('keeps the existing 40-tile overview and exact extent at every level', () => {
    for (const [level, count, size, firstCol, firstRow] of [[3, 40, 128, 10, 7], [2, 160, 64, 20, 14], [1, 640, 32, 40, 28]]) {
      const tiles = visibleGisTiles({ ...overview, level });
      expect(tiles).toHaveLength(count);
      expect(tiles[0]).toMatchObject({ x: 0, y: 0, col: firstCol, row: firstRow, size, level });
      const last = tiles.at(-1);
      expect(last.x + last.size).toBe(1024);
      expect(last.y + last.size).toBe(640);
      for (const tile of tiles) {
        expect(tile.col * 256 * 2 ** (level - 1)).toBe(10240 + tile.x * 8);
        expect(tile.row * 256 * 2 ** (level - 1)).toBe(7168 + tile.y * 8);
      }
    }
  });

  test('loads only the close-view extent with bounded screen-pixel overscan', () => {
    const view = { width: 640, height: 360, scale: 4, translateX: -2200, translateY: -700 };
    const exact = visibleGisTiles({ ...view, level: 1, overscan: 0 });
    const padded = visibleGisTiles({ ...view, level: 1 });
    expect(exact.length).toBeLessThan(30);
    expect(padded.length).toBeLessThan(65);
    expect(padded.length).toBeGreaterThan(exact.length);
    for (const tile of padded) {
      expect(tile.x * 4 + view.translateX).toBeLessThan(view.width + 128);
      expect((tile.x + tile.size) * 4 + view.translateX).toBeGreaterThan(-128);
      expect(tile.y * 4 + view.translateY).toBeLessThan(view.height + 128);
      expect((tile.y + tile.size) * 4 + view.translateY).toBeGreaterThan(-128);
    }
  });

  test('avoids extra boundary tiles and never requests beyond the registered extent', () => {
    expect(visibleGisTiles({ ...overview, width: 128, height: 128 })).toHaveLength(1);
    for (const level of [1, 2, 3]) {
      const tiles = visibleGisTiles({ ...overview, level, overscan: 10000 });
      expect(tiles.every(tile => tile.x >= 0 && tile.y >= 0 && tile.x + tile.size <= 1024 && tile.y + tile.size <= 640)).toBe(true);
    }
    expect(visibleGisTiles({ ...overview, translateX: 2000, overscan: 0 })).toEqual([]);
    expect(visibleGisTiles({ ...overview, scale: 0 })).toEqual([]);
  });
});

describe('layered GIS tile availability', () => {
  const view = { ...overview, width: 128, height: 128 };
  const base = visibleGisTiles({ ...view, level: 3 });
  const detail = visibleGisTiles({ ...view, level: 2 });

  test('retains an explicit detail fallback without calling the usable base unavailable', () => {
    expect(gisTileAvailability(base, detail, new Set([detail[0].key]), new Set([base[0].key])))
      .toEqual({ unavailable: 0, fallback: 1 });
  });

  test('reports missing base until all visible replacement detail has loaded', () => {
    const failed = new Set([base[0].key]);
    expect(gisTileAvailability(base, detail, failed, new Set(detail.slice(1).map(tile => tile.key))).unavailable).toBe(1);
    expect(gisTileAvailability(base, detail, failed, new Set(detail.map(tile => tile.key))).unavailable).toBe(0);
    expect(gisTileAvailability(base, [], failed, new Set()).unavailable).toBe(1);
  });

  test('ignores failures outside the visible viewport and distinguishes tile levels', () => {
    const failed = new Set(['3/17_11', '1/40_28']);
    expect(gisTileAvailability(base, detail, failed, new Set())).toEqual({ unavailable: 0, fallback: 0 });
    expect(new Set([...base, ...detail].map(tile => tile.key)).size).toBe(5);
  });
});
