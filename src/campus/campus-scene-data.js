/**
 * Full visible-campus painter chart, reviewed against the 1024 × 640 official
 * GIS view on 2026-10-24. Coordinates are independently authored visual proxies;
 * they contain no raster pixels, surveyed heights, real fixtures or observations.
 * Source texture is retained at runtime. Unnamed groups receive positional IDs,
 * never guessed school names. The accepted library model owns its original ROI.
 */
import { buildings, lampPoints, parkingAreas, pointInPolygon, routes } from './spatial-scene.js';
import { facadeSurfaces } from './facade-surfaces.js';
import { campusLightLamps, campusLightReceivers } from './campus-lighting-layout.js';
import { libraryDetailFrame } from './map-framing.js';

const provenance = Object.freeze({
  kind: 'manual-illustrative-campus-painter-chart',
  coordinateSystem: 'campuspulse_map_pixels_1024x640',
  basis: 'visible-roof-wall-paving-vegetation-review', reviewed: '2026-10-24',
  accuracy: 'approximate-visual-registration-not-surveyed', surveyed: false,
  illumination: 'synthetic-illustration-not-live-observation',
});
const libraryROI = { left: 548, top: 188, width: 191, height: 147 };
const inLibrary = (x, y, margin = 0) => x >= libraryROI.left - margin && x <= libraryROI.left + libraryROI.width + margin
  && y >= libraryROI.top - margin && y <= libraryROI.top + libraryROI.height + margin;

// Visible roof planes only, not whole projected silhouettes or ground footprints.
// Heights are artist's shading proxies in map units. Separate wings preserve
// courtyards, sports grounds and foreground roofs instead of filling their hull.
const roofChart = [
  ['northwest-edge-01', 14, [[251,0],[282,0],[326,16],[313,30],[250,9]]],
  ['northwest-edge-02', 15, [[262,26],[282,13],[332,31],[320,48],[265,30]]],
  ['northwest-edge-03', 15, [[249,47],[266,32],[317,50],[303,67],[251,50]]],
  ['northwest-housing-01', 14, [[313,54],[332,38],[387,58],[372,74],[324,58]]],
  ['northwest-housing-02', 14, [[330,75],[345,61],[397,81],[382,96],[340,80]]],
  ['northwest-housing-03', 14, [[306,93],[324,78],[371,96],[356,112],[316,98]]],
  ['northwest-housing-04', 14, [[291,115],[308,101],[352,118],[339,133],[301,119]]],
  ['northwest-housing-05', 16, [[274,139],[290,124],[330,140],[318,155],[284,144]]],
  ['northwest-housing-06', 16, [[260,157],[274,145],[302,156],[290,170],[269,161]]],
  ['north-courtyard-west', 20, [[357,0],[378,0],[413,12],[400,27],[358,11]]],
  ['north-courtyard-south', 20, [[363,25],[377,14],[429,33],[417,48],[365,29]]],
  ['north-courtyard-east', 23, [[433,0],[456,0],[467,10],[446,32],[431,28],[448,8]]],
  ['humanities-research-roof', 56, [[482,0],[542,0],[567,9],[541,27],[484,5]], 'humanities-research-source'],
  ['north-office-roof', 28, [[543,59],[565,40],[590,50],[578,69],[559,72]]],
  ['north-office-front', 27, [[531,91],[547,78],[574,88],[562,104],[533,95]]],
  ['north-center-housing-01', 17, [[601,9],[614,0],[649,10],[637,25],[607,14]]],
  ['north-center-housing-02', 18, [[607,34],[623,20],[652,31],[639,46],[612,37]]],
  ['north-center-housing-03', 18, [[618,0],[649,0],[675,8],[665,21],[648,16],[649,10]]],
  ['north-center-housing-04', 18, [[642,16],[656,5],[684,15],[672,28],[646,19]]],
  ['north-sports-west-wing', 15, [[641,78],[651,64],[677,75],[666,91]]],
  ['north-sports-east-wing', 17, [[695,32],[708,20],[769,43],[757,56]]],
  ['north-sports-north-wing', 17, [[657,61],[670,47],[703,22],[714,28],[679,61],[684,69],[676,77]]],
  ['north-sports-south-wing', 17, [[650,85],[664,82],[682,92],[681,105],[666,101]]],
  ['north-sports-annex', 8, [[774,106],[792,99],[820,110],[808,120]]],
  ['northeast-housing-01', 18, [[715,7],[726,0],[766,11],[754,27],[723,15]]],
  ['northeast-housing-02', 18, [[743,24],[758,11],[792,24],[780,40],[753,30]]],
  ['northeast-housing-03', 19, [[772,40],[787,27],[823,40],[809,57],[781,47]]],
  ['northeast-housing-04', 19, [[793,59],[808,47],[842,59],[830,75],[801,65]]],
  ['northeast-housing-05', 18, [[821,21],[837,8],[872,22],[857,38],[830,27]]],
  ['northeast-housing-06', 18, [[839,0],[869,0],[890,8],[877,23],[848,12]]],
  ['northeast-housing-07', 18, [[870,0],[898,0],[920,8],[906,20],[890,13]]],
  ['northeast-outer-tower', 44, [[976,0],[1016,0],[1024,9],[1003,24],[978,14]]],
  ['northeast-outer-annex', 9, [[938,50],[949,41],[963,47],[954,58]]],
  ['north-terrace-row-01', 14, [[619,89],[631,78],[655,87],[644,100]]],
  ['north-terrace-row-02', 14, [[609,112],[622,101],[646,110],[635,123]]],
  ['north-terrace-row-03', 14, [[598,136],[610,124],[634,134],[622,147]]],
  ['north-terrace-row-04', 14, [[590,153],[602,143],[622,151],[611,163]]],
  ['north-circular-hall', 18, [[650,150],[659,136],[670,140],[679,150],[700,158],[694,171],[675,166],[661,157]]],
  ['museum-roof', 21, [[446,81],[478,55],[519,74],[494,103]], 'museum-source'],
  ['north-central-roof', 30, [[506,123],[529,103],[561,115],[549,132],[570,140],[559,156],[507,137]]],
  ['teaching-8-roof', 34, [[458,162],[480,140],[507,150],[513,147],[552,161],[550,168],[585,180],[560,205],[485,177],[480,181]], 'teaching-8-source'],
  ['western-tall-roof', 37, [[196,156],[216,147],[246,160],[250,171],[220,182],[206,176]], 'manjianghong-source'],
  ['western-housing-01', 17, [[156,205],[170,195],[188,203],[176,217]]],
  ['western-housing-02', 16, [[119,231],[133,219],[151,227],[139,241]]],
  ['western-housing-03', 17, [[84,254],[99,242],[117,250],[104,264]]],
  ['western-housing-04', 16, [[48,275],[64,263],[82,270],[68,284]]],
  ['western-housing-05', 16, [[29,298],[44,286],[58,292],[44,307]]],
  ['western-edge-housing-01', 16, [[0,310],[15,300],[30,307],[16,320],[0,314]]],
  ['western-edge-housing-02', 16, [[0,344],[10,336],[23,341],[13,352],[0,348]]],
  ['western-edge-housing-03', 16, [[0,373],[8,369],[17,374],[9,384],[0,380]]],
  ['west-central-roof', 26, [[143,281],[168,251],[198,262],[201,255],[219,265],[205,285],[209,291],[194,307],[146,289]]],
  ['west-small-roof-01', 11, [[101,320],[111,313],[127,319],[117,328]]],
  ['west-small-roof-02', 11, [[125,333],[135,325],[151,333],[140,341]]],
  ['west-small-roof-03', 11, [[92,341],[102,334],[116,341],[107,349]]],
  ['west-small-roof-04', 11, [[114,351],[125,341],[140,347],[131,357]]],
  ['west-pavilion-roof', 7, [[137,373],[155,357],[183,366],[168,381]]],
  ['west-low-housing-roof', 18, [[70,357],[86,346],[143,369],[130,384]]],
  ['west-front-housing-roof', 18, [[52,397],[67,385],[116,404],[104,420]]],
  ['western-service-roof', 8, [[109,462],[119,454],[137,462],[128,473]]],
  ['central-north-courtyard-west', 16, [[411,208],[426,200],[472,218],[459,233],[412,215]], 'foreign-languages-source'],
  ['central-north-courtyard-east', 16, [[473,224],[489,214],[534,231],[522,246],[478,230]], 'foreign-languages-source'],
  ['central-north-courtyard-front', 11, [[407,234],[418,226],[446,237],[439,247],[483,263],[477,271],[435,254],[428,255],[408,247]], 'foreign-languages-source'],
  ['central-north-courtyard-end', 11, [[491,258],[501,247],[536,259],[524,273],[504,265],[500,270]], 'foreign-languages-source'],
  ['west-garden-hall-roof', 9, [[294,251],[313,236],[366,257],[351,273],[370,280],[359,292],[325,279],[320,279],[296,269]]],
  ['west-central-row-01', 15, [[278,319],[290,309],[350,334],[337,346]]],
  ['west-central-row-02', 15, [[254,345],[267,333],[329,359],[316,371]]],
  ['west-central-row-03', 15, [[234,370],[248,357],[310,383],[298,395]]],
  ['literature-roof-west', 10, [[470,327],[481,315],[516,330],[503,343]], 'literature-source'],
  ['literature-roof-east', 10, [[507,340],[521,326],[553,340],[538,354]], 'literature-source'],
  ['central-front-roof-west', 19, [[560,355],[571,346],[609,360],[598,373]], 'central-front-building-manual'],
  ['central-front-roof-center', 20, [[599,369],[616,353],[640,361],[624,381]], 'central-front-building-manual'],
  ['central-front-roof-east', 19, [[626,382],[640,367],[672,379],[658,395]], 'central-front-building-manual'],
  ['central-row-north', 13, [[400,364],[414,352],[482,379],[471,394]], 'teaching-2-south-source'],
  ['central-row-middle', 13, [[379,393],[393,381],[453,406],[440,419]]],
  ['central-row-south', 13, [[360,423],[371,410],[425,431],[413,445]]],
  ['courts-east-hall', 17, [[316,447],[330,433],[414,465],[400,483]]],
  ['gym-main-roof', 27, [[69,553],[116,508],[164,518],[211,545],[176,586],[121,574]], 'gym-source'],
  ['gym-south-roof', 16, [[52,587],[68,562],[120,581],[146,604],[130,612],[98,600],[89,606]], 'gym-source'],
  ['southwest-edge-roof', 12, [[0,574],[14,562],[34,571],[22,587],[0,580]]],
  ['south-center-pavilion', 10, [[409,549],[432,530],[473,523],[480,536],[444,542],[433,555],[443,561],[433,574],[409,564]]],
  ['south-center-hall-west', 18, [[536,555],[552,541],[594,557],[580,574]]],
  ['south-center-hall-front', 18, [[536,570],[551,558],[600,577],[586,593]]],
  ['south-center-hall-east', 18, [[587,578],[603,561],[625,570],[612,588]]],
  ['south-center-small-hall', 12, [[563,521],[576,508],[625,528],[613,542]]],
  ['south-center-east-wing', 12, [[630,525],[642,514],[668,525],[654,539]]],
  ['south-center-east-return', 12, [[655,542],[667,529],[674,534],[670,558],[660,570],[654,560]]],
  ['southeast-red-row-west', 13, [[599,465],[610,455],[628,462],[619,473]]],
  ['southeast-red-row-center', 13, [[628,476],[643,462],[658,468],[651,483]]],
  ['southeast-red-row-east', 13, [[658,489],[668,478],[700,492],[689,506]]],
  ['east-low-hall-01', 12, [[781,341],[790,334],[826,350],[816,363]]],
  ['east-low-hall-02', 12, [[789,375],[800,362],[843,380],[833,393]]],
  ['east-low-hall-03', 12, [[790,405],[805,391],[849,408],[837,422]]],
  ['teaching-9-roof-west', 54, [[788,433],[805,417],[852,434],[838,450],[821,444],[817,449]], 'teaching-9-source'],
  ['teaching-9-roof-center', 54, [[837,449],[853,433],[884,445],[870,462]], 'teaching-9-source'],
  ['teaching-9-roof-east', 49, [[872,471],[886,456],[915,468],[905,481],[925,488],[916,499],[893,489]], 'teaching-9-source'],
  ['southeast-campus-front', 15, [[710,575],[725,563],[802,593],[789,609],[752,594],[745,598]]],
  ['southeast-campus-return', 15, [[687,585],[697,577],[717,585],[707,597]]],
  ['southeast-red-perimeter-west', 14, [[877,601],[894,581],[907,586],[894,602],[908,607],[902,618]]],
  ['southeast-red-perimeter-north', 14, [[904,580],[916,568],[949,581],[938,595],[921,589],[916,595]]],
  ['southeast-red-perimeter-east', 14, [[944,598],[959,584],[977,591],[966,604],[982,610],[973,622],[951,614]]],
  ['southeast-edge-01', 20, [[981,554],[994,542],[1024,554],[1024,574],[995,562]]],
  ['southeast-edge-02', 13, [[994,610],[1007,597],[1024,603],[1024,621],[1008,616]]],
  ['south-edge-roof', 12, [[293,640],[309,623],[343,637],[340,640]]],
];
const roofs = roofChart.map(([id, height, polygon, buildingId]) => ({
  id: `campus-roof-${id}`, kind: 'roof', polygon, height, buildingId: buildingId ?? `visual-group-${id}`,
  material: 'roof', provenance,
}));
const walls = facadeSurfaces.filter(surface => surface.buildingId !== 'library-main').map(surface => ({
  ...surface, kind: 'wall', material: 'wall', sourceMaterial: surface.material,
  height: Math.max(7, ((surface.polygon[3]?.[1] ?? 0) - surface.polygon[0][1]) + 4),
  provenance: { ...provenance, priorMask: surface.provenance },
}));

// Centerline ribbons are lighting receivers; routes retain their separate actor
// contract. Roof/wall silhouettes take precedence over ALL ground masks.
function ribbon(points, halfWidth) {
  const sides = points.map(([x, y], i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / length * halfWidth, ny = (b[0] - a[0]) / length * halfWidth;
    return [[x + nx, y + ny], [x - nx, y - ny]];
  });
  return [...sides.map(pair => pair[0]), ...sides.map(pair => pair[1]).reverse()];
}
// Only places without an existing actor route get additional paths. Every chain
// follows reviewed visible paving; the chains do not claim official routing.
export const campusDemoRoutes = [
  { id: 'campus-teaching-8-west-entry-walk', kind: 'walk', placeId: 'teaching-8', width: 3,
    points: [[443,161],[430,177],[415,192]] },
  { id: 'campus-teaching-8-west-ride', kind: 'ride', placeId: 'teaching-8', width: 4,
    points: [[400,151],[418,128],[438,104]] },
  { id: 'campus-boya-west-walk', kind: 'walk', placeId: 'boya', width: 3,
    points: [[99,318],[118,302],[139,286]] },
  { id: 'campus-boya-east-ride', kind: 'ride', placeId: 'boya', width: 4,
    points: [[219,361],[236,338],[252,318],[270,294]] },
  { id: 'campus-literature-south-walk', kind: 'walk', placeId: 'literature', width: 3,
    points: [[477,369],[496,377],[517,385],[541,394]] },
  { id: 'campus-literature-west-ride', kind: 'ride', placeId: 'literature', width: 4,
    points: [[400,351],[410,336],[423,319]] },
  { id: 'campus-teaching-9-south-walk', kind: 'walk', placeId: 'teaching-9', width: 3,
    points: [[792,518],[823,529],[854,539],[888,551]] },
  { id: 'campus-teaching-9-south-ride', kind: 'ride', placeId: 'teaching-9', width: 4,
    points: [[803,518],[838,530],[873,542],[913,556]] },
  { id: 'campus-gym-north-walk', kind: 'walk', placeId: 'gym', width: 3,
    points: [[113,494],[135,502],[151,508]] },
  { id: 'campus-gym-west-ride', kind: 'ride', placeId: 'gym', width: 4,
    points: [[39,474],[61,486],[86,496],[108,504]] },
].map(route => ({ ...route, sourceId: null, provenance: { ...provenance,
  geometryRole: 'synthetic-activity-on-reviewed-visible-paving', } }));


const grounds = [
  ...campusLightReceivers.map(receiver => ({ ...receiver, material: 'paving' })),
  ...[...routes, ...campusDemoRoutes].map(route => ({ id: `campus-ground-route-${route.id}`, polygon: ribbon(route.points, route.width / 2 + 1), material: 'paving' })),
  ...parkingAreas.map(area => ({ id: `campus-ground-${area.id}`, polygon: area.polygon, material: 'paving' })),
  { id: 'campus-ground-north-sports', material: 'paving', polygon: [[683,100],[709,76],[787,104],[830,129],[792,171],[743,153]] },
  { id: 'campus-ground-west-courts', material: 'paving', polygon: [[154,464],[203,397],[317,438],[274,507]] },
  { id: 'campus-ground-south-courts', material: 'paving', polygon: [[295,495],[312,478],[396,511],[381,531]] },
  { id: 'campus-ground-gym-forecourt', material: 'paving', polygon: [[111,501],[142,490],[205,516],[223,532],[211,547],[176,525]] },
  { id: 'campus-ground-southeast-garden', material: 'grass', polygon: [[739,517],[771,529],[747,559],[716,548]] },
  { id: 'campus-ground-southeast-garden-east', material: 'grass', polygon: [[785,544],[846,563],[820,597],[773,577]] },
  { id: 'campus-ground-south-sports-grass', material: 'grass', polygon: [[234,556],[288,567],[320,590],[286,640],[177,640]] },
  { id: 'campus-ground-central-plaza', material: 'paving', polygon: [[541,444],[551,434],[568,432],[583,436],[591,447],[584,459],[567,466],[550,457]] },
  { id: 'campus-ground-central-water', material: 'water', polygon: [[555,447],[559,442],[567,441],[574,444],[575,450],[570,455],[562,455]] },
  { id: 'campus-ground-south-garden-water', material: 'water', polygon: [[437,548],[451,543],[464,546],[457,556],[447,564],[437,560]] },
].map(surface => ({ ...surface, kind: 'ground', height: 0, exclusions: 'buildings-and-roofs', provenance }));
export const campusSurfaces = [...grounds, ...roofs, ...walls];

// Individually reviewed vegetation areas (not a map-wide random grid). Their
// inset margin and rejection tests keep crowns away from roofs and paving.
export const campusVegetationZones = [
  [[188,127],[206,127],[202,145],[183,153]],
  [[261,233],[302,210],[337,198],[329,228],[305,243],[282,254]],
  [[315,210],[351,196],[393,207],[396,230],[367,250],[335,239]],
  [[370,239],[401,243],[408,270],[387,291],[368,284]],
  [[212,299],[243,285],[252,305],[230,330],[209,324]],
  [[166,319],[189,311],[211,329],[206,354],[186,359],[169,346]],
  [[177,376],[202,366],[221,377],[209,397],[187,399]],
  [[51,426],[83,432],[114,441],[108,459],[72,454],[45,442]],
  [[335,307],[369,299],[393,315],[384,342],[358,357],[341,342]],
  [[400,276],[430,279],[447,291],[438,313],[415,319],[394,305]],
  [[450,276],[479,279],[484,300],[468,317],[449,310]],
  [[517,275],[543,285],[544,311],[528,326],[508,314],[512,292]],
  [[541,337],[557,335],[557,355],[543,373],[529,366]],
  [[687,174],[711,166],[739,172],[742,192],[722,201],[703,190]],
  [[751,198],[768,190],[763,224],[751,250],[741,238]],
  [[729,277],[744,271],[732,298],[719,316],[716,306]],
  [[669,366],[684,362],[692,381],[689,411],[678,419],[668,402]],
  [[738,350],[754,342],[770,351],[770,377],[751,387],[734,371]],
  [[736,390],[754,383],[767,397],[760,420],[743,432],[730,414]],
  [[739,438],[753,433],[768,448],[756,474],[741,482],[730,464]],
  [[526,414],[538,408],[552,415],[550,429],[537,429]],
  [[487,429],[505,424],[521,440],[511,462],[493,464],[479,450]],
  [[440,448],[456,439],[474,453],[465,481],[445,478],[433,466]],
  [[416,488],[434,479],[447,490],[434,516],[417,517],[405,508]],
  [[463,476],[479,469],[494,481],[489,504],[471,501]],
  [[501,477],[522,471],[543,490],[534,516],[515,516],[498,500]],
  [[550,474],[566,470],[579,483],[569,503],[554,505],[542,491]],
  [[466,542],[485,535],[501,544],[499,565],[480,575],[466,565]],
  [[463,582],[482,574],[503,580],[519,605],[512,633],[485,638],[461,622]],
  [[404,586],[426,578],[449,589],[455,612],[442,636],[413,633],[400,613]],
  [[517,598],[534,591],[551,607],[557,633],[535,638],[518,622]],
  [[641,591],[657,580],[674,587],[670,610],[652,631],[634,629]],
  [[682,561],[696,549],[711,558],[700,575],[687,576]],
  [[716,609],[735,604],[750,618],[741,636],[721,633]],
  [[812,588],[830,585],[851,598],[848,618],[829,625],[813,612]],
  [[938,512],[955,508],[968,524],[961,543],[945,539]],
];
const blocked = (x, y) => inLibrary(x, y, 3)
  || buildings.some(item => pointInPolygon([x, y], item.polygon))
  || roofs.some(item => pointInPolygon([x, y], item.polygon))
  || grounds.some(item => pointInPolygon([x, y], item.polygon));
const trees = [];
// Deterministic low-discrepancy candidates; no network, random state or pixel read.
for (let zoneIndex = 0; zoneIndex < campusVegetationZones.length; zoneIndex++) {
  const zone = campusVegetationZones[zoneIndex];
  const xs = zone.map(p => p[0]), ys = zone.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  let accepted = 0;
  for (let i = 0; i < 96 && accepted < 9; i++) {
    const x = minX + ((i * .61803398875 + zoneIndex * .137) % 1) * (maxX - minX);
    const cy = minY + ((i * .754877666 + zoneIndex * .271) % 1) * (maxY - minY);
    const height = 5.4 + ((i + zoneIndex * 3) % 5) * .55;
    const y = cy + height;
    if (y > 638 || !pointInPolygon([x, cy], zone) || blocked(x, cy) || blocked(x, y)) continue;
    if (trees.some(tree => Math.hypot(tree.x - x, tree.y - y) < 5.5)) continue;
    const rx = 3.2 + ((i + zoneIndex) % 4) * .3, ry = rx * .87, rz = 3.2 + (i % 3) * .35;
    trees.push({ id: `campus-tree-${zoneIndex}-${accepted}`, x, y, height, radii: [rx, ry, rz],
      zoneId: `reviewed-vegetation-${zoneIndex}`, provenance });
    accepted++;
  }
}
export const campusTrees = trees;

const extraLamps = [
  [405,254],[438,267],[489,274],[533,277],[477,239],[586,185],
  [242,276],[210,294],[181,312],[201,364],[331,371],[350,414],
  [563,449],[583,466],[602,493],[645,550],[609,596],[559,610],
  [739,540],[812,570],[884,575],[941,593],[841,401],[789,418],
  [663,126],[706,185],[785,97],[881,70],[905,40],[306,186],
];
export const campusLights = [
  ...lampPoints.map((light, i) => ({ ...light, id: `campus-existing-lamp-${i}` })),
  ...campusLightLamps,
  ...extraLamps.map(([x, y], i) => ({ id: `campus-landscape-lamp-${i}`, x, y, strength: .62 })),
].filter(light => !inLibrary(light.x, light.y, 2)
  && !roofs.some(roof => pointInPolygon([light.x, light.y], roof.polygon))).map(light => ({
  ...light, height: 7, power: light.strength * 3.4, radius: 33, provenance,
}));

const frame = (left, top, width, height, wideBounds) => ({ bounds: { left, top, width, height },
  ...(wideBounds ? { wideBounds } : {}), padding: 12 });
export const campusPlaceFrames = {
  library: libraryDetailFrame,
  'teaching-8': frame(411, 116, 202, 162, { left: 428, top: 145, width: 178, height: 105 }),
  boya: frame(127, 220, 173, 157, { left: 133, top: 254, width: 163, height: 92 }),
  literature: frame(426, 280, 154, 136, { left: 440, top: 307, width: 135, height: 88 }),
  tianjiabing: frame(551, 291, 159, 151, { left: 554, top: 337, width: 148, height: 89 }),
  yundaiying: frame(463, 390, 159, 158, { left: 474, top: 411, width: 143, height: 91 }),
  'teaching-9': frame(764, 393, 187, 171, { left: 773, top: 431, width: 170, height: 113 }),
  gym: frame(33, 478, 211, 155, { left: 41, top: 509, width: 196, height: 109 }),
};


export const campusCoverage = Object.freeze({
  bounds: { left: 0, top: 0, width: 1024, height: 640 }, libraryROI,
  surfaceCount: campusSurfaces.length, roofCount: roofs.length, wallCount: walls.length,
  groundCount: grounds.length, treeCount: campusTrees.length, lightCount: campusLights.length,
  placeIds: Object.keys(campusPlaceFrames), additionalRouteCount: campusDemoRoutes.length,
  reviewedVegetationZoneCount: campusVegetationZones.length,
  fullVisibleCampus: true, approximate: true, painterChart: true,
  includesHousingAndOuterEdges: true, preservesLibraryProfile: true,
  containsRasterPixels: false, surveyed: false, fixturesObserved: false, provenance,
});
