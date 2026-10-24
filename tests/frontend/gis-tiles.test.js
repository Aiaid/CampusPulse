import { describe, expect, test } from 'vitest';
import { gisTileAvailability, selectTileLevel, visibleGisTiles } from '../../src/campus/gis-tiles.js';
import { GIS_IMAGE_WIDTH, GIS_IMAGE_HEIGHT, GIS_SCENE_BOUNDS as grid } from '../../src/campus/gis-geometry.js';

const overview = { width: 1024, height: 640, scale: 1, translateX: 0, translateY: 0, overscan: 0 };

describe('official GIS tile detail selection', () => {
  test('matches original pixel density to displayed size and device pixel ratio', () => {
    expect(selectTileLevel(1, 1)).toBe(4);
    expect(selectTileLevel(0.5, 2)).toBe(4);
    expect(selectTileLevel(1.01, 1)).toBe(3);
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

  test('avoids extra boundary tiles and never requests beyond the complete raster grid', () => {
    expect(visibleGisTiles({ ...overview, width: 128, height: 128 })).toHaveLength(1);
    for (const level of [1, 2, 3, 4]) {
      const tiles = visibleGisTiles({ ...overview, level, overscan: 10000 });
      const originalTileSize = 256 * 2 ** (level - 1);
      expect(tiles.every(tile => tile.col >= 0 && tile.row >= 0
        && tile.col < GIS_IMAGE_WIDTH / originalTileSize && tile.row < GIS_IMAGE_HEIGHT / originalTileSize)).toBe(true);
      expect(tiles).toHaveLength((GIS_IMAGE_WIDTH / originalTileSize) * (GIS_IMAGE_HEIGHT / originalTileSize));
    }
    expect(visibleGisTiles({ ...overview, translateX: 4000, overscan: 0 })).toEqual([]);
    expect(visibleGisTiles({ ...overview, scale: 0 })).toEqual([]);
  });

  test('selects real tiles beyond every side of the formerly cropped scene', () => {
    for (const level of [1, 2, 3, 4]) {
      for (const [x, y] of [[-600, 100], [1400, 100], [200, -400], [200, 1000]]) {
        const tiles = visibleGisTiles({ level, width: 128, height: 128, scale: 4,
          translateX: -x * 4, translateY: -y * 4, overscan: 0 });
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.length).toBeLessThanOrEqual(4);
        expect(tiles.some(tile => tile.x <= x && tile.x + tile.size > x && tile.y <= y && tile.y + tile.size > y)).toBe(true);
      }
    }
  });

  test('registers the coarsest tiles despite the crop origin falling inside a tile', () => {
    const tiles = visibleGisTiles({ ...overview, level: 4 });
    expect(tiles).toHaveLength(12);
    expect(tiles[0]).toMatchObject({ key: '4/5_3', x: 0, y: -128, size: 256 });
    expect(tiles.at(-1)).toMatchObject({ key: '4/8_5', x: 768, y: 384, size: 256 });
  });

  test('exposes the complete level grids without duplicating or shifting authored tiles', () => {
    for (const level of [1, 2, 3, 4]) {
      const originalTileSize = 256 * 2 ** (level - 1);
      const columns = GIS_IMAGE_WIDTH / originalTileSize, rows = GIS_IMAGE_HEIGHT / originalTileSize;
      const tiles = visibleGisTiles({ level, width: grid.width, height: grid.height, scale: 1,
        translateX: -grid.left, translateY: -grid.top, overscan: 0 });
      expect(tiles).toHaveLength(columns * rows);
      expect(new Set(tiles.map(tile => tile.key)).size).toBe(columns * rows);
      expect(tiles[0]).toMatchObject({ col: 0, row: 0, x: grid.left, y: grid.top });
      expect(tiles.at(-1)).toMatchObject({ col: columns - 1, row: rows - 1 });
      expect(tiles.at(-1).x + tiles.at(-1).size).toBe(grid.right);
      expect(tiles.at(-1).y + tiles.at(-1).size).toBe(grid.bottom);
    }
  });

  test('keeps normal zoom views bounded instead of loading the whole grid', () => {
    const tiles = visibleGisTiles({ ...overview, level: selectTileLevel(1), overscan: 128 });
    expect(tiles.length).toBeLessThan(30);
    expect(visibleGisTiles({ ...overview, level: 1, scale: 12 }).length).toBeLessThan(25);
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

  const fullBaseView = { ...overview, width: 256, height: 256, translateX: -grid.left, translateY: -grid.top };
  const coarsest = visibleGisTiles({ ...fullBaseView, level: 4 });
  const standard = visibleGisTiles({ ...fullBaseView, level: 3 });
  const fine = visibleGisTiles({ ...fullBaseView, level: 2 });
  const keys = tiles => new Set(tiles.map(tile => tile.key));

  test('accepts complete standard coverage of a failed coarsest tile while finer tiles are pending', () => {
    expect(coarsest).toHaveLength(1);
    expect(standard).toHaveLength(4);
    expect(gisTileAvailability(coarsest, [...standard, ...fine], keys(coarsest), keys(standard)))
      .toEqual({ unavailable: 0, fallback: 0 });
  });

  test('keeps a failed base unavailable when one replacement quadrant is incomplete', () => {
    expect(gisTileAvailability(coarsest, [...standard, ...fine], keys(coarsest), keys(standard.slice(1))))
      .toEqual({ unavailable: 1, fallback: 0 });
  });

  test('counts a failed fine tile falling back to loaded standard detail even if the coarsest tile failed', () => {
    const failures = new Set([...keys(coarsest), fine[0].key]);
    expect(gisTileAvailability(coarsest, [...standard, ...fine], failures, keys(standard)))
      .toEqual({ unavailable: 0, fallback: 1 });
  });

  test('combines standard and fine coverage without requiring a failed or pending standard quadrant', () => {
    const quadrant = standard[0];
    const replacement = fine.filter(tile => tile.x >= quadrant.x && tile.y >= quadrant.y
      && tile.x + tile.size <= quadrant.x + quadrant.size && tile.y + tile.size <= quadrant.y + quadrant.size);
    expect(replacement).toHaveLength(4);
    const loaded = keys([...standard.slice(1), ...replacement]);
    expect(gisTileAvailability(coarsest, [...standard, ...fine], keys(coarsest), loaded).unavailable).toBe(0);
    loaded.delete(replacement[0].key);
    expect(gisTileAvailability(coarsest, [...standard, ...fine], keys(coarsest), loaded).unavailable).toBe(1);
  });

  test('requires replacement coverage only inside a provided viewport', () => {
    const viewport = { ...fullBaseView, width: 128 };
    const visibleHalf = standard.filter(tile => tile.x < grid.left + 128);
    expect(visibleHalf).toHaveLength(2);
    expect(gisTileAvailability(coarsest, visibleHalf, keys(coarsest), keys(visibleHalf), viewport).unavailable).toBe(0);
    expect(gisTileAvailability(coarsest, visibleHalf, keys(coarsest), keys(visibleHalf)).unavailable).toBe(1);
  });

  test('reports holes in a clipped visible area without requiring off-screen quadrants', () => {
    const viewport = { ...fullBaseView, width: 100, height: 200 };
    const visibleHalf = standard.filter(tile => tile.x < grid.left + 128);
    expect(gisTileAvailability(coarsest, visibleHalf, keys(coarsest), keys(visibleHalf), viewport).unavailable).toBe(0);
    expect(gisTileAvailability(coarsest, visibleHalf, keys(coarsest), keys(visibleHalf.slice(1)), viewport).unavailable).toBe(1);
  });
});
