/** Shared illustrative scene-linear response for walls, paving, foliage and
 * cached actor pixels. Irradiance already includes model incidence/visibility.
 */
export const SCENE_EXPOSURE = 1.6;
export const SCENE_SKY_STRENGTH = .65;
const SKY_IRRADIANCE = [.10, .16, .26].map(value => value * SCENE_SKY_STRENGTH);
const cameraRay = [.65 / .9275, 1 / .9275, 1];
export const SCENE_VIEW_DIRECTION = Object.freeze(cameraRay.map(value => value / Math.hypot(...cameraRay)));
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const positive = value => Number.isFinite(value) ? Math.max(0, Math.min(1e12, value)) : 0;
const SRGB_LINEAR = Float64Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
});
const linearSrgb = value => value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055;
const NO_SPECULAR = Object.freeze({ specularWeight: 0, diffuseWeight: 1 });
const vector3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Optional dielectric reflection of the field's weighted actual direction.
 * Conceptual reference: Filament's GGX distribution, Smith masking, Schlick
 * Fresnel and diffuse/specular energy separation:
 * https://google.github.io/filament/main/filament.html#materialsystem
 *
 * Independently implemented bounded average-lobe approximation, not Filament's
 * full BRDF or per-light integration. The field already includes incidence and
 * occlusion. A conservative 50% reflected-energy ceiling prevents one averaged
 * point direction from making broad sources into a mirror/wet-ground spike.
 */
export function sceneDielectricResponse(normal, lightDirection, { roughness, dielectricF0 = .04 } = {}) {
  if (!Number.isFinite(roughness) || !vector3(normal) || !vector3(lightDirection)) return NO_SPECULAR;
  const nl = Math.hypot(...normal), ll = Math.hypot(...lightDirection), f0 = clamp01(dielectricF0);
  if (nl < 1e-9 || ll < 1e-9 || f0 <= 0) return NO_SPECULAR;
  const n = normal.map(value => value / nl), l = lightDirection.map(value => value / ll), v = SCENE_VIEW_DIRECTION;
  const noL = dot3(n, l), noV = dot3(n, v);
  if (noL <= 1e-5 || noV <= 1e-5) return NO_SPECULAR;
  const half = [l[0] + v[0], l[1] + v[1], l[2] + v[2]], halfLength = Math.hypot(...half);
  if (halfLength < 1e-9) return NO_SPECULAR;
  const h = half.map(value => value / halfLength);
  const noH = clamp01(dot3(n, h)), voH = clamp01(dot3(v, h));
  const alpha = Math.max(.08, clamp01(roughness)) ** 2, alpha2 = alpha * alpha;
  const denominator = 1 + noH * noH * (alpha2 - 1);
  const distribution = alpha2 / (Math.PI * denominator * denominator);
  const smith = cosine => 2 * cosine / (cosine + Math.sqrt(alpha2 + (1 - alpha2) * cosine * cosine));
  const fresnel = f0 + (1 - f0) * (1 - voH) ** 5;
  // π makes the microfacet lobe relative to the scene's existing Lambertian
  // irradiance convention, which absorbs the diffuse 1/π into its light units.
  const lobe = Math.PI * distribution * smith(noL) * smith(noV) * fresnel / (4 * noL * noV);
  const specularWeight = Math.max(0, Math.min(.5, Number.isFinite(lobe) ? lobe : 0));
  return { specularWeight, diffuseWeight: 1 - specularWeight };
}

/** One shared decode table also supports fractional bilinear texture samples. */
export function decodeSceneColor(rgb) {
  return [0, 1, 2].map(axis => {
    const byte = Math.max(0, Math.min(255, Number.isFinite(rgb?.[axis]) ? rgb[axis] : 0));
    const index = Math.floor(byte), fraction = byte - index;
    return SRGB_LINEAR[index] * (1 - fraction) + SRGB_LINEAR[Math.min(255, index + 1)] * fraction;
  });
}

export function shadeLinearSceneSurface(albedo, normal, light = {}, {
  emissionColorRGB, emissionStrength = 0, emissionNormalization = 1, facing = 1, ambientScale = 1,
  roughness, dielectricF0 = .04,
} = {}) {
  const n = Array.isArray(normal) && normal.length === 3 && normal.every(Number.isFinite) ? normal : [0, 0, 1];
  const normalLength = Math.hypot(...n) || 1;
  const sky = .65 + .35 * clamp01(.5 + .5 * (n[0] * .2 - n[1] * .45 + n[2] * .85) / normalLength);
  const ambient = SKY_IRRADIANCE, directSpectrum = [1, .69, .37];
  const bounceSpectrum = [1, .73, .46], facadeSpectrum = [1, .74, .43];
  const direct = positive(light.directIrradiance), indirect = positive(light.indirectIrradiance), facade = positive(light.facadeIrradiance);
  const materialFacing = clamp01(facing), ambientPower = positive(ambientScale);
  const emission = emissionColorRGB ? decodeSceneColor(emissionColorRGB) : [0, 0, 0];
  const emissionPower = positive(emissionStrength) * positive(emissionNormalization);
  const reflection = sceneDielectricResponse(n, light.surfaceLightDirection, { roughness, dielectricF0 });
  return [0, 1, 2].map(axis => {
    const source = direct * directSpectrum[axis] + indirect * bounceSpectrum[axis] + facade * facadeSpectrum[axis];
    const base = positive(albedo?.[axis]);
    // Dielectric highlights retain the illuminant color independently of dyed
    // fabric/leaf albedo. They replace a bounded share of diffuse reception;
    // neither ambient nor emitted room radiance creates extra specular energy.
    // Capsule facing is diffuse modulation only: the optional GGX lobe already
    // has its own normal/light/view masking and must not receive that factor a
    // second time. The no-spec branch retains the previous arithmetic exactly.
    const surfaceRadiance = reflection.specularWeight > 0
      ? base * ambient[axis] * sky * ambientPower + source
        * (base * materialFacing * reflection.diffuseWeight + reflection.specularWeight)
      : base * (ambient[axis] * sky * ambientPower + materialFacing * source);
    // Interior radiance is ADDITIVE: dark reflective glass cannot extinguish
    // the room behind it. Exposure/tone mapping happens only after this sum.
    const radiance = (surfaceRadiance + emission[axis] * emissionPower) * SCENE_EXPOSURE;
    const mapped = radiance === Infinity ? 1 : radiance / (1 + radiance);
    return Math.round(255 * clamp01(linearSrgb(mapped)));
  });
}

export function shadeSceneSurface(baseColorRGB, normal, light = {}, options = {}) {
  return shadeLinearSceneSurface(decodeSceneColor(baseColorRGB), normal, light, options);
}
