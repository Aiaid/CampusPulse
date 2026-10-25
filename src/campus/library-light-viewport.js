/** Keep the original viewport's device-pixel grid while allocating only the
 * visible atlas rectangle. The one-device-pixel guard preserves filtered edge
 * coverage at fractional pan/zoom positions; it never grows beyond the viewport.
 */
export function libraryLightViewport(bounds, origin, scale, viewWidth, viewHeight, ratio) {
  if (![origin.left, origin.top, scale, viewWidth, viewHeight, ratio].every(Number.isFinite)
    || scale <= 0 || ratio <= 0 || viewWidth <= 0 || viewHeight <= 0) return null;
  const destination = {
    left: origin.left + bounds.left * scale,
    top: origin.top + bounds.top * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
  const left = Math.max(0, destination.left), top = Math.max(0, destination.top);
  const right = Math.min(viewWidth, destination.left + destination.width);
  const bottom = Math.min(viewHeight, destination.top + destination.height);
  if (right <= left || bottom <= top) return null;
  const pixelLeft = Math.max(0, Math.floor(left * ratio) - 1);
  const pixelTop = Math.max(0, Math.floor(top * ratio) - 1);
  const pixelRight = Math.min(Math.ceil(viewWidth * ratio), Math.ceil(right * ratio) + 1);
  const pixelBottom = Math.min(Math.ceil(viewHeight * ratio), Math.ceil(bottom * ratio) + 1);
  const pixelWidth = pixelRight - pixelLeft, pixelHeight = pixelBottom - pixelTop;
  return { left: pixelLeft / ratio, top: pixelTop / ratio,
    width: pixelWidth / ratio, height: pixelHeight / ratio, pixelWidth, pixelHeight, destination };
}
