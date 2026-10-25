import { observationKinds, observationKindLabels } from '../shared/observation-kinds.js';

export const allWorkPurposes = Object.keys(observationKindLabels);
export const availableWorkPurposes = place => place ? observationKinds(place) : allWorkPurposes;
export const sameWorkPurposes = (a, b) => Array.isArray(a) && Array.isArray(b) && [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',');
export function validateWorkPurposes(kinds, allowed = allWorkPurposes) {
  if (!Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length || kinds.some(kind => !allowed.includes(kind))) throw new Error('请至少选择一种此地点支持的工作用途。');
  return [...kinds];
}
