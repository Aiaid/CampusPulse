import {
  LIBRARY_BOUNDS, libraryBlend, librarySurfaces, libraryTrees,
  resolveLibrarySurface, sampleLibraryLight, libraryPaneEntryIntensity, libraryCanopyDownlights, worldToScreen,
} from './library-lighting.js';
import { treeMaterialState } from './tree-material.js';
import { buildingMaterialState, sampleBuildingMaterial, facadeUv } from './building-material.js';
import { chooseRoomAppearance } from './room-lighting.js';
import { shadeSceneSurface, shadeLinearSceneSurface } from './surface-lighting.js';
import { pavingMaterialState, samplePavingMaterial } from './paving-material.js';
import { gisMaterialState, sampleGisMaterial } from './gis-material.js';

const RESOLUTION = 3;
const clamp01 = value => Math.max(0, Math.min(1, value));
let cached;

function image(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  return { canvas, context, pixels: context.createImageData(width, height) };
}
function pixel(target, offset, color, alpha) {
  if (alpha <= 0) return;
  target.data[offset] = color[0]; target.data[offset + 1] = color[1]; target.data[offset + 2] = color[2];
  target.data[offset + 3] = Math.round(255 * clamp01(alpha));
}
function trace(context, polygon) {
  context.beginPath();
  polygon.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y));
  context.closePath();
}
function normalColor([nx, ny, nz]) {
  const sx = nx - .65 * ny, sy = .35 * nx + .7 * ny - nz;
  const length = Math.max(1, Math.hypot(sx, sy, nz));
  return [Math.round((.5 + .5 * sx / length) * 255),
    Math.round((.5 + .5 * sy / length) * 255), Math.round((.5 + .5 * nz) * 255)];
}

/** A material exposure, never an extra source: a zero irradiance remains zero.
 * Absorption removes the blue cast of the source raster from directly lit glass
 * and paving before warm diffuse reception. Roofs retain cool indirect depth.
 */
export function libraryMaterialResponse(receiver, light) {
  const roof = receiver.kind === 'roof' || receiver.kind === 'canopy';
  const tree = receiver.kind === 'tree', wall = receiver.kind === 'wall';
  const intensity = clamp01(light.intensity);
  const exposure = tree ? 2 : roof ? .7 : 2.25;
  // Paving keeps a steeper source-to-distance contrast than glass: a high
  // exposure over the whole plaza flattened it into an ochre sheet.
  const reception = receiver.kind === 'ground' ? intensity ** .85 : 1 - (1 - intensity) ** exposure;
  return { reception, diffuse: reception * (tree ? .25 : roof ? .1 : wall ? .39 : .72),
    absorption: reception * (roof ? .08 : wall ? .48 : .32),
    shade: (tree ? .5 : roof ? .44 : .29) * (1 - reception) + (1 - clamp01(light.visibility ?? 1)) * .12,
    warmColor: [255, Math.round(224 - 21 * clamp01(light.warmth ?? .8)), Math.round(166 - 38 * clamp01(light.warmth ?? .8))] };
}

/** Compatibility wrapper around the one shared linear-RGB surface pipeline.
 * Reflected light always uses neutral albedo; room emission is additive and
 * independent of that albedo, with its image luminance normalization explicit.
 */
export function libraryBuildingMaterialColor(baseColor, normal, light,
  { emission = 0, emissionColorRGB = baseColor, emissionNormalization = 1, roughness } = {}) {
  return shadeSceneSurface(baseColor, normal, light, {
    emissionColorRGB, emissionStrength: emission, emissionNormalization, roughness,
  });
}

/** Doors/sills outside the authored window band retain the original GIS detail.
 * A neutral receiving reference turns the SAME scene irradiance into bounded
 * screen reception; no ambient, room emission or opaque door artwork is added.
 * This is a detail-preserving relight approximation, not recovered GIS albedo.
 */
export function libraryPreservedWallReception(normal, light) {
  const color = shadeSceneSurface([255, 255, 255], normal, light, { ambientScale: 0 });
  // Keep at least 60% of the original local contrast even under a saturated
  // source. A stronger white screen layer flattened the whole base into a bar.
  return { color, alpha: color.some(value => value > 0) ? .38 : 0 };
}

function prepareWallRooms() {
  const records = new Map(), roomTiers = { bright: 0, ordinary: 0, dim: 0, unlit: 0 };
  let windowCount = 0;
  for (const surface of librarySurfaces.filter(item => item.kind === 'wall')) {
    const lastRow = Math.max(0, ...(surface.windows ?? []).map(pane => Number(pane.id.split('-').at(-2))));
    const panes = new Map();
    for (const pane of surface.windows ?? []) {
      const row = Number(pane.id.split('-').at(-2));
      const entryIntensity = pane.lit && row >= lastRow - 1 ? libraryPaneEntryIntensity(surface, pane) : 0;
      const appearance = chooseRoomAppearance(surface.id, pane, lastRow, entryIntensity);
      roomTiers[appearance.tier] += 1;
      if (pane.lit) windowCount += 1;
      panes.set(pane.id.split('-').slice(-2).join(':'), { ...pane, ...appearance });
    }
    records.set(surface.id, { surface, panes });
  }
  return { records, roomTiers, windowCount };
}

/** Exact reviewed pane quads take precedence over the generated cell's frame.
 * Structural paint samples only the neutral frame edge. Lower door junctions
 * outside the reviewed window band therefore never acquire invented windows.
 */
function sampleWallAlbedo(record, x, y, facadeState) {
  if (!record) return null;
  const { surface, panes } = record;
  const uv = facadeUv(surface.mapping.windowQuad, x, y);
  // The source window band ends above real doors/sills. Do not replace those
  // raster details or repeat the procedural cell into extra lower floors.
  if (!uv || uv.some(value => value < 0 || value > 1)) return null;
  const u = uv[0] * surface.mapping.columns, v = uv[1] * surface.mapping.rows;
  const pane = panes.get(`${Math.floor(v)}:${Math.floor(u)}`);
  const paneUv = pane && facadeUv(pane.polygon, x, y);
  if (paneUv && paneUv.every(value => value >= 0 && value <= 1)) {
    const sample = sampleBuildingMaterial(paneUv[0], paneUv[1], 'unlit');
    const warm = pane.emission > 0 ? sampleBuildingMaterial(paneUv[0], paneUv[1], 'warm') : null;
    return sample && { ...sample, roughness: .3,
      emission: pane.emission * (warm?.emissionMask ?? 0),
      emissionColorRGB: warm?.baseColor ?? [0, 0, 0],
      emissionNormalization: facadeState.warmEmissionNormalization ?? 1 };
  }
  const sample = sampleBuildingMaterial(.025, v, 'unlit');
  // The actual library has light metal floor bands. The generated graphite
  // panel edge supplies surface variation, not the structural paint color.
  // Preserve that contrast rather than turning the entire facade brown/dark.
  return sample && { ...sample, roughness: .82,
    baseColor: sample.baseColor.map((value, axis) => Math.min(235, value * 1.25 + [82,86,89][axis])),
    emission: 0 };
}

/** Both cameras crop the same 2.5D irradiance/material atlas. All surface
 * masks, normals and ray blockers come from the registered GIS receiver model.
 */
export function libraryLightAtlas() {
  const material = treeMaterialState();
  const facade = buildingMaterialState();
  const paving = pavingMaterialState();
  const gis = gisMaterialState();
  const revision = `${material.revision}:${facade.revision}:${paving.revision}:${gis.revision}`;
  if (cached?.materialRevision === revision) return cached;
  const started = performance.now(), bounds = LIBRARY_BOUNDS;
  const rooms = prepareWallRooms();
  const width = Math.ceil(bounds.width * RESOLUTION), height = Math.ceil(bounds.height * RESOLUTION);
  const shade = image(width, height), buildingShade = image(width, height);
  const tint = image(width, height), buildingTint = image(width, height);
  const diffuse = image(width, height), buildingDiffuse = image(width, height);
  const treeMaterial = image(width, height), buildingMaterial = image(width, height), groundMaterial = image(width, height);
  const normals = image(width, height), emissionMask = image(width, height);
  const buildingFixtureMaterial = image(width, height);
  const counts = { ground: 0, wall: 0, roof: 0, canopy: 0, tree: 0, other: 0 };
  let shadowPixels = 0, indirectPixels = 0, foliageBouncePixels = 0, maxIndirect = 0;
  let facadePixels = 0, foliageFacadePixels = 0, maxFacade = 0;
  let buildingMaterialPixels = 0, baseDoorPreservedPixels = 0, groundMaterialPixels = 0, preservedDoorReceptionPixels = 0;
  const sourceMaterialPixels = { roof: 0, canopy: 0, wall: 0 };
  for (let py = 0; py < height; py += 1) for (let px = 0; px < width; px += 1) {
    const x = bounds.left + (px + .5) / RESOLUTION, y = bounds.top + (py + .5) / RESOLUTION;
    const blend = libraryBlend(x, y);
    if (!blend) continue;
    const receiver = resolveLibrarySurface(x, y);
    if (!receiver) continue;
    const coverage = blend * clamp01(receiver.coverage ?? 1);
    if (!coverage) continue;
    const light = sampleLibraryLight(receiver.position, receiver.normal, {
      excludeId: receiver.id, indirect: true, emissive: true, receiverKind: receiver.kind,
    });
    const response = libraryMaterialResponse(receiver, light);
    const indirect = light.indirectIntensity ?? 0;
    if (indirect > .015) {
      indirectPixels += 1;
      if (receiver.kind === 'tree') foliageBouncePixels += 1;
    }
    maxIndirect = Math.max(maxIndirect, indirect);
    const facadeContribution = light.facadeIntensity ?? 0;
    if (facadeContribution > .015) {
      facadePixels += 1;
      if (receiver.kind === 'tree') foliageFacadePixels += 1;
    }
    maxFacade = Math.max(maxFacade, facadeContribution);
    const tree = receiver.kind === 'tree', building = Boolean(receiver.buildingId) && !tree;
    counts[Object.hasOwn(counts, receiver.kind) ? receiver.kind : 'other'] += 1;
    if ((light.visibility ?? 1) < .8) shadowPixels += 1;
    const offset = (py * width + px) * 4;
    const targetShade = building ? buildingShade.pixels : shade.pixels;
    const targetTint = building ? buildingTint.pixels : tint.pixels;
    const targetDiffuse = building ? buildingDiffuse.pixels : diffuse.pixels;
    const wallAlbedo = facade.ready && receiver.kind === 'wall'
      ? sampleWallAlbedo(rooms.records.get(receiver.id), x, y, facade) : null;
    const wallRecord = receiver.kind === 'wall' ? rooms.records.get(receiver.id) : null;
    const wallUv = wallRecord ? facadeUv(wallRecord.surface.mapping.windowQuad, x, y) : null;
    const preservedDoorBand = wallUv && wallUv[0] >= 0 && wallUv[0] <= 1 && wallUv[1] > 1;
    // Online source RGB is used before the raster's display grade. It keeps
    // real ribs, seams and doors, then receives the same world illumination as
    // authored glass/foliage/paving. No second screen/tint layer is written.
    const sourceAlbedo = gis.ready && building && !wallAlbedo
      ? sampleGisMaterial(x, y, { kind: receiver.kind }) : null;
    const groundAlbedo = paving.ready && receiver.kind === 'ground' ? samplePavingMaterial(x, y) : null;
    if (wallAlbedo) {
      pixel(buildingMaterial.pixels, offset,
        libraryBuildingMaterialColor(wallAlbedo.baseColor, receiver.normal, light, {
          emission: wallAlbedo.emission, emissionColorRGB: wallAlbedo.emissionColorRGB,
          emissionNormalization: wallAlbedo.emissionNormalization,
          roughness: wallAlbedo.roughness,
        }), coverage);
      buildingMaterialPixels += 1;
    } else if (sourceAlbedo) {
      const roughness = receiver.kind === 'roof' ? .82 : receiver.kind === 'canopy' ? .65 : .72;
      pixel(buildingMaterial.pixels, offset,
        shadeLinearSceneSurface(sourceAlbedo.linearAlbedo, receiver.normal, light, { roughness }),
        coverage * sourceAlbedo.alpha);
      if (Object.hasOwn(sourceMaterialPixels, receiver.kind)) sourceMaterialPixels[receiver.kind] += 1;
      if (receiver.kind === 'wall') baseDoorPreservedPixels += 1;
    } else if (groundAlbedo) {
      pixel(groundMaterial.pixels, offset, shadeSceneSurface(groundAlbedo.baseColor, receiver.normal, light, { roughness: .78 }), coverage);
      groundMaterialPixels += 1;
    } else if (tree && receiver.baseColor) {
      pixel(treeMaterial.pixels, offset, shadeSceneSurface(receiver.baseColor, receiver.normal, light, { roughness: .5 }), coverage);
    } else if (preservedDoorBand) {
      // These pixels stay transparent in buildingMaterial. They receive warm
      // light through screen blending, retaining each real door seam and sill.
      const reception = libraryPreservedWallReception(receiver.normal, light);
      pixel(targetDiffuse, offset, reception.color, coverage * reception.alpha);
      if (facade.ready) baseDoorPreservedPixels += 1;
      if (reception.alpha > 0) preservedDoorReceptionPixels += 1;
    } else {
      if (facade.ready && receiver.kind === 'wall') baseDoorPreservedPixels += 1;
      pixel(targetShade, offset, [153, 180, 219], coverage * response.shade);
      pixel(targetTint, offset, [255, 218, 151], coverage * response.absorption);
      pixel(targetDiffuse, offset, response.warmColor, coverage * response.diffuse);
    }
    pixel(normals.pixels, offset, normalColor(receiver.normal), coverage * .88);
    if (building && receiver.kind === 'wall') pixel(emissionMask.pixels, offset, [255, 255, 255], coverage);
  }
  for (const layer of [shade, buildingShade, tint, buildingTint, diffuse, buildingDiffuse, treeMaterial, buildingMaterial, groundMaterial, normals, emissionMask]) {
    layer.context.putImageData(layer.pixels, 0, 0);
  }
  const glazing = image(width, height), emission = image(width, height), glow = image(width, height);
  for (const layer of [glazing, emission]) {
    layer.context.scale(RESOLUTION, RESOLUTION); layer.context.translate(-bounds.left, -bounds.top);
  }
  const { windowCount, roomTiers } = rooms;
  for (const { surface, panes } of rooms.records.values()) {
    const context = glazing.context, shine = emission.context;
    context.save(); trace(context, surface.polygon); context.clip();
    shine.save(); trace(shine, surface.polygon); shine.clip();
    for (const pane of panes.values()) {
      if (pane.tier === 'unlit') continue;
      const { tier, exposure } = pane;
      const ys = pane.polygon.map(point => point[1]), top = Math.min(...ys), bottom = Math.max(...ys);
      if (!facade.ready) {
        const palette = tier === 'bright' ? ['#bc8847', '#ffe0a0', '#f2c078', '#ac7137']
          : tier === 'ordinary' ? ['#80613f', '#d1ae73', '#bd945d', '#725134']
            : ['#3b3934', '#796c52', '#665944', '#36322d'];
        const gradient = context.createLinearGradient(0, top, 0, bottom);
        gradient.addColorStop(0, palette[0]); gradient.addColorStop(.25, palette[1]);
        gradient.addColorStop(.74, palette[2]); gradient.addColorStop(1, palette[3]);
        context.globalAlpha = tier === 'bright' ? .66 + .25 * exposure
          : tier === 'ordinary' ? .43 + .3 * exposure : .34 + .6 * exposure;
        trace(context, pane.polygon); context.fillStyle = gradient; context.fill();
        context.globalAlpha = .38; context.strokeStyle = '#302c27'; context.lineWidth = .15; context.stroke();
      }
      // Ready authored panes carry their emission through the shared shader
      // and interior mask. A second flat screen fill would light metal frames
      // and count that room power twice. Retain it only for the old fallback.
      if (tier !== 'dim' && !facade.ready) {
        shine.globalAlpha = tier === 'bright' ? .1 + .22 * exposure : .025 + .1 * exposure;
        trace(shine, pane.polygon); shine.fillStyle = '#ffca77'; shine.fill();
      }
    }
    context.restore(); shine.restore();
  }
  // Optical scatter is subpixel in world space and remains clipped to the
  // currently visible walls; it cannot spill through roof/tree blockers.
  glow.context.filter = `blur(${.55 * RESOLUTION}px)`;
  glow.context.globalAlpha = .3; glow.context.drawImage(emission.canvas, 0, 0);
  emission.context.setTransform(1, 0, 0, 1, 0, 0); emission.context.globalAlpha = 1;
  emission.context.drawImage(glow.canvas, 0, 0);
  for (const layer of [glazing, emission]) {
    layer.context.setTransform(1, 0, 0, 1, 0, 0); layer.context.globalAlpha = 1;
    layer.context.globalCompositeOperation = 'destination-in'; layer.context.drawImage(emissionMask.canvas, 0, 0);
    layer.context.globalCompositeOperation = 'source-over';
  }
  const sourceSamples = {};
  if (gis.ready) for (const [name, x, y] of [['roof', 640, 212], ['door', 637, 262], ['canopy', 635, 276]]) {
    const receiver = resolveLibrarySurface(x, y);
    const albedo = receiver && sampleGisMaterial(x, y, { kind: receiver.kind });
    if (!albedo) continue;
    const light = sampleLibraryLight(receiver.position, receiver.normal,
      { excludeId: receiver.id, indirect: true, emissive: true, receiverKind: receiver.kind });
    sourceSamples[name] = { albedo: albedo.baseColorRGB,
      shaded: shadeLinearSceneSurface(albedo.linearAlbedo, receiver.normal, light, { roughness: .8 }) };
  }
  const fixtureContext = buildingFixtureMaterial.context;
  fixtureContext.scale(RESOLUTION, RESOLUTION);
  fixtureContext.translate(-bounds.left, -bounds.top);
  for (const source of libraryCanopyDownlights) {
    const point = worldToScreen(source.position);
    const lens = shadeSceneSurface([35, 35, 35], [0, 0, -1], {}, {
      ambientScale: 0, emissionColorRGB: [255, 211, 130], emissionStrength: source.power * 3,
    });
    const casing = shadeSceneSurface([70, 70, 70], [0, 0, -1], {});
    fixtureContext.save();
    fixtureContext.translate(point.x, point.y);
    fixtureContext.rotate(source.screenTangentAngle);
    fixtureContext.fillStyle = `rgb(${casing.join(',')})`;
    fixtureContext.beginPath(); fixtureContext.ellipse(0, 0, 1.05, .38, 0, 0, Math.PI * 2); fixtureContext.fill();
    fixtureContext.fillStyle = `rgb(${lens.join(',')})`;
    fixtureContext.beginPath(); fixtureContext.ellipse(0, .05, .65, .18, 0, 0, Math.PI * 2); fixtureContext.fill();
    fixtureContext.restore();
  }
  cached = { bounds, resolution: RESOLUTION, materialRevision: revision, buildingMaterialRevision: facade.revision,
    groundShade: shade.canvas, buildingShade: buildingShade.canvas,
    groundTint: tint.canvas, buildingTint: buildingTint.canvas,
    groundDiffuse: diffuse.canvas, buildingDiffuse: buildingDiffuse.canvas,
    treeMaterial: treeMaterial.canvas, buildingMaterial: buildingMaterial.canvas, groundMaterial: groundMaterial.canvas,
    buildingFixtureMaterial: buildingFixtureMaterial.canvas, buildingGlazing: glazing.canvas,
    emission: emission.canvas, normals: normals.canvas,
    stats: { model: 'library-registered-2.5d', compileMs: Number((performance.now() - started).toFixed(1)),
      receiverPixels: counts, surfaceCount: librarySurfaces.length, treeCount: libraryTrees.length,
      shadowPixels, indirectPixels, foliageBouncePixels, maxIndirect, facadePixels, foliageFacadePixels, maxFacade,
      windowCount, roomTiers, width, height,
      buildingMaterialPixels, groundMaterialPixels, baseDoorPreservedPixels, preservedDoorReceptionPixels, baseDoorPreserved: true,
      sourceMaterialPixels, sourceSamples, sourceMaterialReady: gis.ready,
      canopyDownlightCount: libraryCanopyDownlights.length,
      sourceMaterial: gis.ready ? 'runtime-official-ungraded-approximate-albedo-shared-light' : 'gis-wash-fallback',
      pavingReady: paving.ready, pavingMaterial: paving.ready ? 'authored-albedo-common-linear-light' : 'gis-wash-fallback',
      commonPipeline: 'linear-rgb-shared-direct-indirect-facade-additive-room-emission',
      registeredPaneCount: [...rooms.records.values()].reduce((count, wall) => count + wall.panes.size, 0),
      buildingMaterial: facade.ready ? 'generated-linear-rgb-shared-light' : 'gis-wash-fallback',
      treeMaterial: material.ready ? 'textured-shared-light' : 'raster-fallback' } };
  return cached;
}
