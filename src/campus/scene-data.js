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

// Authored frontend-only scenarios. Their labels, curves and parking intensity
// are synthetic illustrations, never observations, capacity or predictions.
export const simulationScenarios = [
  { id: 'weekday', label: '常规教学日', description: '课间通行、午餐高峰与晚间自习的合成示意', minute: 600 },
  { id: 'weekend', label: '周末休闲', description: '教学活动减少，阅读、广场与运动活动增加的合成示意', minute: 900 },
  { id: 'rainy', label: '雨天出行', description: '骑行减少、室内停留与候梯变化的合成示意', minute: 1080 },
];

// Shared representative presets/history samples, spanning 07:00–22:00.
export const simulationTimes = [420, 540, 600, 720, 750, 900, 1080, 1200, 1320];

// Hourly 07:00–22:00 demand, with each place retaining its own daily rhythm.
// Bikes represent synthetic activity intensity; parking is a separate index.
const profiles = new Map(Object.entries({
  library: { kind: 'library', people: [12, 29, 57, 67, 71, 61, 56, 71, 77, 74, 65, 73, 87, 95, 78, 36], bikeScale: .64, wait: 3, parkingBase: 16 },
  'teaching-8': { kind: 'teaching', people: [12, 72, 64, 86, 67, 46, 22, 73, 83, 66, 43, 26, 35, 26, 15, 7], bikeScale: .72, wait: 2, parkingBase: 9 },
  boya: { kind: 'dining', people: [32, 53, 27, 21, 50, 96, 73, 25, 19, 25, 61, 91, 65, 37, 24, 12], bikeScale: .68, wait: null, parkingBase: 8 },
  literature: { kind: 'teaching', people: [9, 53, 59, 76, 64, 37, 23, 62, 77, 58, 39, 31, 38, 30, 19, 8], bikeScale: .57, wait: 2, parkingBase: 12 },
  tianjiabing: { kind: 'teaching', people: [8, 42, 54, 65, 60, 35, 26, 62, 68, 64, 47, 37, 44, 34, 23, 10], bikeScale: .76, wait: 1, parkingBase: 11 },
  yundaiying: { kind: 'plaza', people: [18, 34, 39, 48, 56, 72, 46, 33, 39, 52, 65, 82, 87, 70, 47, 20], bikeScale: .61, wait: null, parkingBase: 5 },
  'teaching-9': { kind: 'teaching', people: [16, 79, 72, 89, 78, 49, 25, 77, 88, 73, 48, 29, 40, 28, 16, 7], bikeScale: .85, wait: 3, parkingBase: 13 },
  gym: { kind: 'gym', people: [26, 40, 31, 28, 35, 30, 26, 33, 45, 57, 73, 83, 94, 87, 62, 24], bikeScale: .69, wait: null, parkingBase: 10 },
}));

const weekendCurves = {
  library: [10, 19, 39, 57, 70, 61, 65, 77, 85, 83, 73, 72, 84, 88, 70, 31],
  teaching: [4, 7, 13, 22, 27, 18, 11, 19, 26, 23, 17, 12, 18, 16, 10, 4],
  dining: [18, 31, 43, 37, 57, 90, 80, 43, 31, 37, 64, 87, 74, 48, 31, 16],
  plaza: [15, 24, 43, 62, 70, 66, 59, 68, 80, 89, 93, 95, 91, 78, 55, 28],
  gym: [21, 35, 49, 64, 72, 56, 50, 65, 79, 87, 92, 94, 96, 90, 68, 30],
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeMinute = minute => clamp(Number.isFinite(minute) ? minute : 1200, 420, 1320);
function interpolate(values, minute) {
  const hour = (normalizeMinute(minute) - 420) / 60;
  const i = Math.min(Math.floor(hour), values.length - 2);
  // Cosine interpolation has no abrupt slopes at authored hourly boundaries.
  const t = (1 - Math.cos((hour - i) * Math.PI)) / 2;
  return values[i] + (values[i + 1] - values[i]) * t;
}
const trend = (difference) => difference > 1 ? 'up' : difference < -1 ? 'down' : 'flat';

function sampleMetrics(profile, minute, scenarioId, phase) {
  const time = normalizeMinute(minute);
  const values = scenarioId === 'weekend' ? weekendCurves[profile.kind] : profile.people;
  const demand = interpolate(values, time);
  const teaching = profile.kind === 'teaching';
  // Brief, smooth class-break pulses enrich weekday teaching-building flow.
  const breaks = teaching && scenarioId !== 'weekend'
    ? [590, 710, 890, 1010].reduce((sum, center) => sum + 7 * Math.exp(-(((time - center) / 14) ** 2)), 0) : 0;
  const ripple = Math.sin(time / 41 + phase) * 1.5;
  const rain = scenarioId === 'rainy';
  const outdoor = profile.kind === 'plaza' || profile.kind === 'gym';
  const people = clamp(Math.round((demand + breaks + ripple) * (rain ? outdoor ? .72 : .96 : 1)), 0, 100);
  const bikeDemand = demand * profile.bikeScale + breaks * 1.3 + Math.sin(time / 53 + phase) * 2;
  const bikes = clamp(Math.round(bikeDemand * (rain ? .48 : 1)), 0, 100);
  // A lagged dwell component makes parking persist after passing flow subsides.
  // This is an occupancy intensity index, with no asserted parking capacity.
  const dwell = interpolate(values, time - 30);
  const parking = clamp(Math.round((profile.parkingBase + dwell * .65 + bikeDemand * .2) * (rain ? .78 : 1)), 0, 100);
  const wait = profile.wait === null ? null : clamp(Math.round(
    profile.wait + people / 24 + (teaching ? breaks / 6 : 0) + (rain ? 1.5 : 0)), 1, 9);
  return { people, bikes, parking, wait };
}

export function getMetrics(placeId, minute = 1200, scenarioId = 'weekday') {
  const profile = profiles.get(placeId);
  // Unknown places are unknown, rather than a disguised library scenario.
  if (!profile) return { people: null, bikes: null, parking: null, wait: null, peopleTrend: 'flat', bikesTrend: 'flat' };
  const time = normalizeMinute(minute);
  const scenario = simulationScenarios.some(item => item.id === scenarioId) ? scenarioId : 'weekday';
  const phase = places.findIndex(place => place.id === placeId) * .8;
  const current = sampleMetrics(profile, time, scenario, phase);
  const previous = sampleMetrics(profile, time - 15, scenario, phase);
  return {
    ...current,
    peopleTrend: trend(current.people - previous.people),
    bikesTrend: trend(current.bikes - previous.bikes),
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
