const profiles = Object.freeze({
  efficient: Object.freeze({ id: 'efficient', pixelRatioLimit: 1, campusResolutionLimit: 1, libraryResolution: 2 }),
  full: Object.freeze({ id: 'full', pixelRatioLimit: 2, campusResolutionLimit: 2, libraryResolution: 3 }),
});

export function lightingQualityProfile(name = 'efficient') {
  return typeof name === 'string' && Object.hasOwn(profiles, name) ? profiles[name] : profiles.efficient;
}

/** Only lighting backing stores are capped; GIS, labels and actors retain their
 * existing native DPR. The full profile preserves the previous ceiling. */
export function lightingPixelRatio(deviceRatio, quality) {
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return Math.min(ratio, lightingQualityProfile(quality).pixelRatioLimit);
}
