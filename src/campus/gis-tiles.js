// Official CCNU levels run from zoom1 (finest) to zoom4 (coarsest).
// This scene registers original image rectangle (10240,7168)-(18432,12288)
// to its 1024x640 world. Every level therefore shares an exact tile boundary.
const WORLD_WIDTH = 1024;
const WORLD_HEIGHT = 640;
const ORIGINAL_X = 10240;
const ORIGINAL_Y = 7168;
const ORIGINAL_PIXELS_PER_WORLD_UNIT = 8;

export function selectTileLevel(scale, pixelRatio = 1) {
  const density = scale * pixelRatio;
  if (density > 4) return 1;
  if (density > 2) return 2;
  return 3;
}

/** Return only tiles intersecting the viewport plus a screen-pixel margin. */
export function visibleGisTiles({ level = 3, width, height, scale, translateX, translateY, overscan = 128 }) {
  if (![width, height, scale, translateX, translateY, overscan].every(Number.isFinite)
      || width <= 0 || height <= 0 || scale <= 0 || ![1, 2, 3].includes(level)) return [];
  const originalTileSize = 256 * 2 ** (level - 1);
  const size = originalTileSize / ORIGINAL_PIXELS_PER_WORLD_UNIT;
  const left = Math.max(0, (-Math.max(0, overscan) - translateX) / scale);
  const top = Math.max(0, (-Math.max(0, overscan) - translateY) / scale);
  const right = Math.min(WORLD_WIDTH, (width + Math.max(0, overscan) - translateX) / scale);
  const bottom = Math.min(WORLD_HEIGHT, (height + Math.max(0, overscan) - translateY) / scale);
  if (right <= left || bottom <= top) return [];
  const tiles = [];
  for (let y = Math.floor(top / size); y < Math.ceil(bottom / size); y++) {
    for (let x = Math.floor(left / size); x < Math.ceil(right / size); x++) {
      const col = ORIGINAL_X / originalTileSize + x;
      const row = ORIGINAL_Y / originalTileSize + y;
      tiles.push({ key: `${level}/${col}_${row}`, level, col, row, x: x * size, y: y * size, size });
    }
  }
  return tiles;
}

const overlaps = (a, b) => a.x < b.x + b.size && a.x + a.size > b.x && a.y < b.y + b.size && a.y + a.size > b.y;

/** Assess current on-screen tiles; off-screen failures never raise a notice. */
export function gisTileAvailability(baseTiles, detailTiles, failed, loaded) {
  const unavailable = baseTiles.filter(base => {
    if (!failed.has(base.key)) return false;
    const covering = detailTiles.filter(detail => overlaps(base, detail));
    return covering.length === 0 || covering.some(detail => !loaded.has(detail.key));
  });
  const fallback = detailTiles.filter(detail => failed.has(detail.key)
    && baseTiles.some(base => overlaps(base, detail) && loaded.has(base.key)));
  return { unavailable: unavailable.length, fallback: fallback.length };
}
