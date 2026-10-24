import { treeMaterialSnapshot, installTreeMaterialSnapshot } from './tree-material.js';
import { buildingMaterialSnapshot, installBuildingMaterialSnapshot } from './building-material.js';
import { pavingMaterialSnapshot, installPavingMaterialSnapshot } from './paving-material.js';
import { gisMaterialSnapshot, installGisMaterialSnapshot } from './gis-material.js';

/** The only state crossing the worker boundary is decoded illustrative/source
 * material. Image elements, user observations and application state stay local. */
export function lightingMaterialSnapshot() {
  const tree = treeMaterialSnapshot(), building = buildingMaterialSnapshot();
  const paving = pavingMaterialSnapshot(), gis = gisMaterialSnapshot();
  const revision = [tree, building, paving, gis].map(item => `${item.state.status}:${item.state.revision}`).join('|');
  return { revision, tree, building, paving, gis };
}

export function installLightingMaterialSnapshot(snapshot) {
  installTreeMaterialSnapshot(snapshot.tree); installBuildingMaterialSnapshot(snapshot.building);
  installPavingMaterialSnapshot(snapshot.paving); installGisMaterialSnapshot(snapshot.gis);
}
