import { getCampusTreesInBounds } from './campus-scene-lighting.js';
import { LIBRARY_BOUNDS } from './library-lighting.js';
import { treeMaterialArtwork } from './tree-material.js';

// Use the same crown projection and alpha artwork as the material sampler.
// Local sprite queries cost a few affine draws, independent of full map area.
export function campusCrownMasks(bounds, groundY = -Infinity) {
  if (!treeMaterialArtwork()) return [];
  return getCampusTreesInBounds(bounds).filter(tree => tree.id.startsWith('campus-tree-') && groundY < tree.base.y);
}

export function drawCampusCrownMasks(context, trees, { scale = 1, offsetX = 0, offsetY = 0 } = {}) {
  const artwork = treeMaterialArtwork();
  if (!artwork || !trees.length) return;
  context.save();
  context.translate(offsetX, offsetY); context.scale(scale, scale);
  // The accepted library owns its complete ROI, including the feather.
  context.beginPath(); context.rect(-2048, -2048, 5120, 5120);
  context.rect(LIBRARY_BOUNDS.left, LIBRARY_BOUNDS.top, LIBRARY_BOUNDS.width, LIBRARY_BOUNDS.height);
  context.clip('evenodd');
  for (const tree of trees) {
    const p = tree.projection, a = Math.sqrt(p.xx), b = p.xy / a, c = Math.sqrt(p.determinant / p.xx);
    const mirror = p.phase > Math.PI ? -1 : 1;
    context.save(); context.transform(a, b, 0, c, p.center.x, p.center.y);
    context.beginPath(); context.arc(0, 0, 1, 0, Math.PI * 2); context.clip();
    context.scale(mirror, 1); context.drawImage(artwork, -1, -1, 2, 2); context.restore();
  }
  context.restore();
}

/** Native crown height is a painter-depth proxy. Crop only rows in front of
 * the actor's ground anchor; foreground actors must remain above the foliage. */
export function nativeCanopyCrop(mask, groundY = -Infinity) {
  const top = Math.max(mask.top, groundY - mask.heightProxy);
  if (top >= mask.top + mask.height) return null;
  return { top, height: mask.top + mask.height - top,
    sourceTop: (top - mask.top) / mask.height * mask.canvas.height,
    sourceHeight: (mask.top + mask.height - top) / mask.height * mask.canvas.height };
}

export function drawNativeCanopyMasks(context, masks,
  { groundY = -Infinity, scale = 1, offsetX = 0, offsetY = 0 } = {}) {
  for (const mask of masks) {
    const crop = nativeCanopyCrop(mask, groundY);
    if (!crop) continue;
    context.drawImage(mask.canvas, 0, crop.sourceTop, mask.canvas.width, crop.sourceHeight,
      offsetX + mask.left * scale, offsetY + crop.top * scale, mask.width * scale, crop.height * scale);
  }
}
