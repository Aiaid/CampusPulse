/**
 * Public CCNU GIS snapshot, captured 2026-10-15. This is a pixel-coordinate
 * scene, not a latitude/longitude survey. Anchors are copied from gadget-labels.
 * Activity and waits are illustrative scenarios: no observation or prediction.
 */
export const sceneAttribution = {
  name: '华中师范大学校园 GIS',
  url: 'https://gis.ccnu.edu.cn/',
  snapshot: '2026-10-15',
  anchors: 'data/gis/ccnu-20261015/derived/gadget-labels.json',
  scenarios: 'data/gis/ccnu-20261015/mock/density-scenarios.json',
  coordinateSystem: 'ccnu_gis_zoom1_pixels',
  extent: { minX: 10240, minY: 7168, maxX: 18432, maxY: 12288 },
  notice: '活动为区域合成示意，非个体定位；候梯为模拟数据，未核实楼栋电梯。',
};

export const MAP_WIDTH = 1024;
export const MAP_HEIGHT = 640;
const anchor = (id, name, sourceId, worldX, worldY, subtitle) => ({
  id, name, sourceId, worldX, worldY, subtitle,
  x: (worldX - 10240) / 8,
  y: (worldY - 7168) / 8,
});

export const places = [
  anchor('library', '图书馆', '430', 15602, 8970, '阅读与学习 · 图书馆片区'),
  anchor('teaching-8', '八号教学楼', '459', 14404, 8492, '教学空间 · 桂北片区'),
  anchor('boya', '博雅园餐厅', '605', 12170, 8954, '校园生活 · 西区'),
  anchor('literature', '文学院', '441', 14266, 9866, '二号教学楼 · 人文片区'),
  anchor('tianjiabing', '田家炳楼', '445', 15360, 9656, '教学与研究 · 中心片区'),
  anchor('yundaiying', '恽代英广场', '559', 14571, 10681, '开放空间 · 校园中心'),
  anchor('teaching-9', '九号教学楼', '491', 17036, 10752, '教学空间 · 东区'),
  anchor('gym', '佑铭体育馆', '453', 11420, 11474, '运动与休闲 · 西南片区'),
];

// Morning / class-break / evening values for four places reuse the stored
// synthetic scenario. All remaining values are new deterministic mock values.
const profiles = {
  library: { people: [64, 72, 95], bikes: [38, 61, 52], wait: 3 },
  'teaching-8': { people: [70, 91, 36], bikes: [33, 64, 24], wait: 2 },
  boya: { people: [42, 84, 78], bikes: [30, 60, 54], wait: null },
  literature: { people: [61, 85, 40], bikes: [26, 50, 30], wait: 2 },
  tianjiabing: { people: [52, 74, 48], bikes: [31, 62, 36], wait: 1 },
  yundaiying: { people: [31, 88, 60], bikes: [20, 48, 42], wait: null },
  'teaching-9': { people: [83, 96, 38], bikes: [55, 81, 40], wait: 3 },
  gym: { people: [30, 47, 81], bikes: [24, 35, 57], wait: null },
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function interpolate(values, minute) {
  const times = [420, 570, 750, 930, 1200, 1320];
  const levels = [values[0] * .55, values[0], values[1], values[0] * .8, values[2], values[2] * .66];
  const time = clamp(Number.isFinite(minute) ? minute : 1200, 420, 1320);
  let i = 0;
  while (i < times.length - 2 && time > times[i + 1]) i += 1;
  const t = (time - times[i]) / (times[i + 1] - times[i]);
  return levels[i] + (levels[i + 1] - levels[i]) * t;
}
const trend = (difference) => difference > 1 ? 'up' : difference < -1 ? 'down' : 'flat';

export function getMetrics(placeId, minute = 1200) {
  const profile = profiles[placeId] ?? profiles.library;
  const phase = places.findIndex((place) => place.id === placeId) * .8;
  const sample = (values, time) => clamp(Math.round(interpolate(values, time) + Math.sin(time / 32 + phase) * 4), 0, 100);
  const people = sample(profile.people, minute);
  const bikes = sample(profile.bikes, minute);
  return {
    people,
    bikes,
    wait: profile.wait === null ? null : clamp(Math.round(profile.wait + (people - 55) / 24), 1, 6),
    peopleTrend: trend(people - sample(profile.people, minute - 15)),
    bikesTrend: trend(bikes - sample(profile.bikes, minute - 15)),
  };
}

// Artistically spaced objects near captured campus paths. These points are
// deliberately schematic, never individual tracking positions or surveyed POIs.
export const activityOffsets = {
  library: [[-85, -12], [-73, 7], [-57, 31], [-31, 50], [-8, 68], [19, 72], [48, 65], [68, 40]],
  'teaching-8': [[-63, 10], [-48, 25], [-28, 39], [-8, 44], [17, 49], [43, 40]],
  boya: [[-27, -16], [-19, 2], [-9, 21], [10, 36], [30, 43]],
  literature: [[-73, 12], [-53, 23], [-29, 39], [2, 53], [27, 64]],
  tianjiabing: [[-41, 13], [-20, 30], [4, 40], [28, 48], [49, 31]],
  yundaiying: [[-30, -25], [-11, -9], [14, 5], [38, 25], [59, 39]],
  'teaching-9': [[-55, -17], [-42, 2], [-27, 24], [-8, 43], [18, 54], [41, 66]],
  gym: [[-54, -33], [-32, -19], [-10, -5], [14, 7], [38, 22], [62, 37]],
};
