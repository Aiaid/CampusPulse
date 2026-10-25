// Official CCNU levels run from zoom1 (finest) to zoom4 (coarsest).
// Tile coordinates remain registered to the original authored scene, including
// negative scene positions in the rest of the full raster grid.
import { GIS_IMAGE_WIDTH, GIS_IMAGE_HEIGHT, GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT, GIS_SCENE_ORIGIN } from './gis-geometry.js';

export function selectTileLevel(scale, pixelRatio = 1) {
  const density = scale * pixelRatio;
  if (density > 4) return 1;
  if (density > 2) return 2;
  if (density > 1) return 3;
  return 4;
}

/** Return only tiles intersecting the viewport plus a screen-pixel margin. */
export function visibleGisTiles({ level = 3, width, height, scale, translateX, translateY, overscan = 128 }) {
  if (![width, height, scale, translateX, translateY, overscan].every(Number.isFinite)
      || width <= 0 || height <= 0 || scale <= 0 || ![1, 2, 3, 4].includes(level)) return [];
  const originalTileSize = 256 * 2 ** (level - 1);
  const size = originalTileSize / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT;
  const margin = Math.max(0, overscan);
  const left = Math.max(0, GIS_SCENE_ORIGIN.x + (-margin - translateX) / scale * GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT);
  const top = Math.max(0, GIS_SCENE_ORIGIN.y + (-margin - translateY) / scale * GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT);
  const right = Math.min(GIS_IMAGE_WIDTH, GIS_SCENE_ORIGIN.x + (width + margin - translateX) / scale * GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT);
  const bottom = Math.min(GIS_IMAGE_HEIGHT, GIS_SCENE_ORIGIN.y + (height + margin - translateY) / scale * GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT);
  if (right <= left || bottom <= top) return [];
  const tiles = [];
  for (let row = Math.floor(top / originalTileSize); row < Math.ceil(bottom / originalTileSize); row++) {
    for (let col = Math.floor(left / originalTileSize); col < Math.ceil(right / originalTileSize); col++) {
      tiles.push({ key: `${level}/${col}_${row}`, level, col, row,
        x: (col * originalTileSize - GIS_SCENE_ORIGIN.x) / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
        y: (row * originalTileSize - GIS_SCENE_ORIGIN.y) / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT, size });
    }
  }
  return tiles;
}

const overlaps = (a, b) => a.x < b.x + b.size && a.x + a.size > b.x && a.y < b.y + b.size && a.y + a.size > b.y;
const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y
  && outer.x + outer.size >= inner.x + inner.size && outer.y + outer.size >= inner.y + inner.size;

// Official levels form an aligned quadtree. A cell may be replaced by one
// loaded tile or a complete combination of finer tiles across its quadrants.
function coveredByLoadedTiles(cell, candidates, visible) {
  if (visible && (cell.x >= visible.right || cell.y >= visible.bottom
    || cell.x + cell.size <= visible.left || cell.y + cell.size <= visible.top)) return true;
  if (candidates.some(tile => contains(tile, cell))) return true;
  const intersecting = candidates.filter(tile => overlaps(tile, cell));
  if (!intersecting.length || cell.size <= Math.min(...intersecting.map(tile => tile.size))) return false;
  const size = cell.size / 2;
  return [[0, 0], [size, 0], [0, size], [size, size]].every(([dx, dy]) =>
    coveredByLoadedTiles({ x: cell.x + dx, y: cell.y + dy, size }, intersecting, visible));
}

/** Assess current on-screen tiles; off-screen failures never raise a notice. */
export function gisTileAvailability(baseTiles, detailTiles, failed, loaded, viewport) {
  const visible = viewport && [viewport.width, viewport.height, viewport.scale, viewport.translateX, viewport.translateY].every(Number.isFinite)
    && viewport.width > 0 && viewport.height > 0 && viewport.scale > 0
    ? { left: -viewport.translateX / viewport.scale, top: -viewport.translateY / viewport.scale,
      right: (viewport.width - viewport.translateX) / viewport.scale, bottom: (viewport.height - viewport.translateY) / viewport.scale }
    : null;
  const loadedTiles = [...baseTiles, ...detailTiles].filter(tile => loaded.has(tile.key) && !failed.has(tile.key));
  const unavailable = baseTiles.filter(base => {
    if (!failed.has(base.key)) return false;
    return !coveredByLoadedTiles(base, loadedTiles, visible);
  });
  const fallback = detailTiles.filter(detail => failed.has(detail.key)
    && loadedTiles.some(tile => tile.size > detail.size && contains(tile, detail)));
  return { unavailable: unavailable.length, fallback: fallback.length };
}
