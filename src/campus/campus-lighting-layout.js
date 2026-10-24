// Lighting artwork traced against the selected official 1024x640 campus image,
// reviewed 2026-10-24. This file contains only independently authored coordinates:
// no raster is bundled or read at runtime. These are visible-paving receivers,
// not surveyed road widths, traffic routes, physical fixtures or observations.
const provenance = {
  kind: 'manual-illustrative-campus-lighting', basis: 'selected-official-gis-visible-paving-review',
  coordinateSystem: 'campuspulse_map_pixels_1024x640', reviewDate: '2026-10-24', surveyed: false,
};

// Centerlines serve lighting masks only. Actor routing remains in spatial-scene.
const corridors = [
  { id: 'west-perimeter', halfWidth: 5.5, points: [[5,463],[57,365],[105,305],[156,270],[228,232],[302,208],[353,177]], lamps: 10 },
  { id: 'northwest-avenue', halfWidth: 5, points: [[353,177],[400,118],[443,66],[490,8]], lamps: 4 },
  { id: 'inner-west-avenue', halfWidth: 4.5, points: [[108,501],[151,447],[201,382],[251,318],[303,253],[350,193]], lamps: 8 },
  { id: 'east-south-avenue', halfWidth: 6, points: [[729,322],[715,348],[708,375],[708,410],[719,449],[738,479]], lamps: 4 },
  { id: 'southeast-avenue', halfWidth: 6, points: [[739,496],[706,535],[669,581],[627,635]], lamps: 4 },
  { id: 'southeast-crossroad', halfWidth: 5.5, points: [[739,496],[797,515],[864,538],[931,560],[1009,584]], lamps: 6 },
  { id: 'garden-west-promenade', halfWidth: 4, points: [[367,604],[404,548],[439,499],[475,449],[510,401]], lamps: 4 },
  { id: 'courts-south-paving', halfWidth: 4, points: [[110,501],[151,509],[185,518],[207,527]], lamps: 2 },
  { id: 'gym-west-paving', halfWidth: 5, points: [[3,484],[29,494],[56,505]], lamps: 1 },
  { id: 'central-garden-paving', halfWidth: 4.5, points: [[503,421],[534,431],[555,431],[582,421],[611,431]], lamps: 3 },
  { id: 'southern-garden-paving', halfWidth: 4, points: [[429,492],[470,506],[509,521],[546,536]], lamps: 3 },
  { id: 'northeast-sports-avenue', halfWidth: 5.5, points: [[794,171],[833,140],[875,105],[916,67],[956,27]], lamps: 5 },
  { id: 'northwest-garden-paving', halfWidth: 3.5, points: [[253,275],[289,289],[327,303],[362,315]], lamps: 3 },
];

// A short mitered strip follows each manually reviewed paving chain. Joins are
// capped at twice the width; masks are finally clipped by building silhouettes.
function receiverPolygon(points, halfWidth) {
  const normals = points.slice(1).map(([x, y], index) => {
    const [ax, ay] = points[index], length = Math.hypot(x - ax, y - ay);
    return [-(y - ay) / length, (x - ax) / length];
  });
  const edges = points.map(([x, y], index) => {
    const a = normals[Math.max(0, index - 1)], b = normals[Math.min(normals.length - 1, index)];
    const nx = a[0] + b[0], ny = a[1] + b[1], length = Math.hypot(nx, ny);
    const ux = nx / length, uy = ny / length;
    const miter = Math.min(halfWidth * 2, halfWidth / Math.max(.5, ux * b[0] + uy * b[1]));
    return [[x + ux * miter, y + uy * miter], [x - ux * miter, y - uy * miter]];
  });
  return [...edges.map(pair => pair[0]), ...edges.map(pair => pair[1]).reverse()];
}

function samplePaving(points, fraction) {
  const lengths = points.slice(1).map(([x, y], index) => Math.hypot(x - points[index][0], y - points[index][1]));
  let distance = lengths.reduce((sum, length) => sum + length, 0) * fraction;
  for (let index = 0; index < lengths.length; index++) {
    if (distance <= lengths[index] || index === lengths.length - 1) {
      const [ax, ay] = points[index], [bx, by] = points[index + 1];
      const t = Math.min(1, distance / lengths[index]), angle = Math.atan2(by - ay, bx - ax);
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, angle };
    }
    distance -= lengths[index];
  }
}

export const campusLightReceivers = corridors.map(corridor => ({
  id: `campus-light-${corridor.id}`, polygon: receiverPolygon(corridor.points, corridor.halfWidth),
  provenance: { ...provenance, geometryRole: 'lighting-receiver-only' },
}));

export const campusLightLamps = corridors.flatMap((corridor, corridorIndex) => Array.from({ length: corridor.lamps }, (_, index) => {
  const sample = samplePaving(corridor.points, (index + .5) / corridor.lamps);
  return {
    id: `campus-lamp-${corridor.id}-${index}`, ...sample,
    strength: .66 + ((index + corridorIndex) % 3) * .045,
    provenance: { ...provenance, geometryRole: 'decorative-fixture-not-observed' },
  };
}));
