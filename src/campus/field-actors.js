import { routes } from './spatial-scene.js';
import { campusDemoRoutes } from './campus-scene-data.js';

export const MAX_FIELD_ACTORS = 200;
// Reuse the registered drawing paths, never their demo activity metrics. The
// paths are illustrative positions rather than observed trajectories.
const fieldRoutes = [...routes, ...campusDemoRoutes];
const unusable = value => value?.stale || value?.unverified || value?.last_known || value?.update_failed;
const count = value => Number.isSafeInteger(value) && value >= 0;
function budgetFor(group) {
  // The uploaded metric bounds the original schematic glyph budget. Neither
  // absent metrics nor a positive BLE count establish an actual people count.
  if (!count(group.metric_value) || !count(group.figure_count)) return 0;
  return Math.min(MAX_FIELD_ACTORS, group.metric_value, group.figure_count);
}
function lengthOf(route) {
  return route.points.slice(1).reduce((sum, point, index) => sum
    + Math.hypot(point[0] - route.points[index][0], point[1] - route.points[index][1]), 0);
}

/** Build a bounded place-level observation diagram using existing sprites.
 * Eligibility is projected from verified source quality by fieldIllustration.
 * This function has no demo, wall-clock, scenario or nearest-place fallback.
 * One uploaded group owns one budget shared across its exact place's paths;
 * counts and movement remain schematic, not tracked people or trajectories.
 */
export function makeFieldActors(illustration, fieldPlace, layers = {}) {
  const placeId = fieldPlace?.id;
  if (!illustration) return [];
  // Card source precedence (for example manual parking) must not hide an
  // independent device candidate. An explicit empty actor projection clears it.
  const groups = Object.hasOwn(illustration, 'actor_groups') ? illustration.actor_groups : illustration.groups;
  if (!Array.isArray(groups) || unusable(illustration)
    || typeof placeId !== 'string' || !placeId
    || illustration.place_id !== placeId) return [];
  const result = [];
  for (const group of groups) {
    if (!group || group.actor_eligible !== true || unusable(group)
      || (group.place_id != null && group.place_id !== placeId)) continue;
    // Manual parking and unclassified BLE activity cannot establish a vehicle
    // type. Cars have their own glyph and never enter the riding-bike count.
    const kind = group.kind === 'people' && group.source === 'sensor' ? 'walk'
      : group.kind === 'bikes' && group.source === 'candidate' ? 'ride'
      : group.kind === 'cars' && group.source === 'candidate' ? 'car' : null;
    if (!kind || layers[kind === 'walk' ? 'people' : 'bikes'] === false) continue;
    const paths = fieldRoutes.filter(route => route.placeId === placeId && route.kind === (kind === 'car' ? 'ride' : kind)
      && route.points.length >= 2);
    if (!paths.length) continue;
    const budget = Math.min(budgetFor(group), MAX_FIELD_ACTORS - result.length);
    for (let index = 0; index < budget; index += 1) {
      const route = paths[index % paths.length];
      const routeIndex = Math.floor(index / paths.length);
      result.push({ id: `field-${kind}-${route.id}-${routeIndex}`, placeId, route,
        length: Math.max(lengthOf(route), 1), kind, parked: false,
        phase: (routeIndex * .381966 + paths.indexOf(route) * .173) % 1,
        speed: kind === 'walk' ? .95 + routeIndex * .07 : 2.6 + routeIndex * .18 });
    }
  }
  return result;
}

/** Overview scenes remain independently bound to their exact source place.
 * Reject every duplicate place instead of multiplying an ambiguous source.
 * The total budget applies across the entire map, including all vehicle types.
 */
export function makeFieldSceneActors(scenes, layers = {}) {
  if (!Array.isArray(scenes)) return [];
  const occurrences = new Map();
  for (const scene of scenes) {
    const id = scene?.place?.id;
    if (typeof id === 'string') occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  const result = [];
  for (const scene of scenes) {
    if (!scene || occurrences.get(scene.place?.id) !== 1) continue;
    const actors = makeFieldActors(scene.illustration, scene.place, layers);
    result.push(...actors.slice(0, MAX_FIELD_ACTORS - result.length));
    if (result.length === MAX_FIELD_ACTORS) break;
  }
  return result;
}
