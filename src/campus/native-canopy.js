/** Conservative runtime raster foliage inference, not surveyed tree geometry.
 * Dark green/olive source pixels and local luminance variation identify likely
 * foliage. Authored lawns/courts/buildings are excluded by the caller. Pink/gray textured crowns require an authored vegetation-zone prior; pale
 * ambiguous pixels remain in the underlying source.
 * Only one bounded chunk plus its existing normalization halo is inspected. */
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const inside = (x, y, polygon) => {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
};

export function nativeCanopyExclusion(polygons, bounds) {
  const nearby = polygons.map(polygon => {
    const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
    return { polygon, left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }).filter(box => box.left < bounds.left + bounds.width && box.right > bounds.left
    && box.top < bounds.top + bounds.height && box.bottom > bounds.top);
  return (x, y) => nearby.some(box => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom && inside(x, y, box.polygon));
}

export function prepareNativeCanopyMask(material, { excludedAt = () => false, vegetationAt = () => false } = {}) {
  if (!material?.linear || !material?.alpha || !material?.bounds) return null;
  const { width, height, resolution, linear, alpha, bounds } = material;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || !Number.isFinite(resolution) || resolution <= 0 || linear.length !== width * height * 3 || alpha.length !== width * height) return null;
  const luminance = new Float32Array(width * height), candidate = new Uint8Array(width * height);
  const stride = width + 1, sum = new Float64Array(stride * (height + 1)), squares = new Float64Array(sum.length);
  for (let y = 0; y < height; y++) {
    let row = 0, rowSquares = 0;
    for (let x = 0; x < width; x++) {
      const index = y * width + x, offset = index * 3;
      const r = linear[offset], g = linear[offset + 1], b = linear[offset + 2];
      const value = .2126 * r + .7152 * g + .0722 * b;
      luminance[index] = value;
      if (alpha[index] > .95 && value > .006 && value < .34) {
        const green = g > r * .95 && g > b * 1.25 && g - b > .012 && (g - r > .004 || g > b * 1.7);
        const pinkOrGray = b > r * .35 && b > g * .45 && r < Math.max(.01, g) * 2.8;
        const sx = bounds.left + (x + .5) / resolution, sy = bounds.top + (y + .5) / resolution;
        candidate[index] = green ? 1 : pinkOrGray && vegetationAt(sx, sy) ? 2 : 0;
      }
      row += value; rowSquares += value * value;
      const target = (y + 1) * stride + x + 1;
      sum[target] = sum[target - stride] + row;
      squares[target] = squares[target - stride] + rowSquares;
    }
  }
  const opacity = new Uint8ClampedArray(width * height), radius = Math.max(1, Math.round(2 * resolution));
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!candidate[index]) continue;
    const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
    const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
    const area = (right - left) * (bottom - top);
    const a = top * stride + left, b = top * stride + right, c = bottom * stride + left, d = bottom * stride + right;
    const mean = (sum[d] - sum[b] - sum[c] + sum[a]) / area;
    const variance = Math.max(0, (squares[d] - squares[b] - squares[c] + squares[a]) / area - mean * mean);
    // The dark condition retains crown interiors; the variance condition admits
    // brighter mottled leaves but rejects smooth green painted/source surfaces.
    if (candidate[index] === 2 ? variance < .00016 : luminance[index] > .12 && variance < .0001) continue;
    const sx = bounds.left + (x + .5) / resolution, sy = bounds.top + (y + .5) / resolution;
    if (excludedAt(sx, sy)) continue;
    opacity[index] = 255; count++;
  }
  return { width, height, resolution, bounds, opacity, luminance, count };
}

export function sampleNativeCanopyMask(mask, x, y) {
  if (!mask || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { bounds, resolution, width, height, opacity, luminance } = mask;
  const px = Math.floor((x - bounds.left) * resolution), py = Math.floor((y - bounds.top) * resolution);
  if (px < 0 || py < 0 || px >= width || py >= height || !opacity[py * width + px]) return null;
  const at = (xx, yy) => luminance[clamp(yy, 0, height - 1) * width + clamp(xx, 0, width - 1)];
  const nx = clamp((at(px - 1, py) - at(px + 1, py)) * 2, -.22, .22);
  const ny = clamp((at(px, py - 1) - at(px, py + 1)) * 2 - .18, -.35, .15);
  const length = Math.hypot(nx, ny, 1);
  return { coverage: 1, normal: [nx / length, ny / length, 1 / length] };
}
