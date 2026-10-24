/** Stable illustrative rooms shared by the rendered panes and area emitters.
 * This pattern is authored scene lighting, never measured room occupancy.
 */
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function chooseRoomAppearance(surfaceId, pane, lastRow, entryIntensity = 0) {
  if (pane.lit === false) return { tier: 'unlit', exposure: 0, emission: 0 };
  const [row, column] = pane.id.split('-').slice(-2).map(Number);
  const wallSeed = [...surfaceId].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0, 2166136261);
  let hash = Math.imul(wallSeed ^ (Math.floor(row / 2) + 1), 0x45d9f3b)
    ^ Math.imul(Math.floor(column / 3) + 1, 0x27d4eb2d);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const room = hash % 100;
  let tier = room < 18 ? 'bright' : room < 68 ? 'ordinary' : 'dim';
  const entryBoost = row >= lastRow - 1 ? clamp01(entryIntensity) * .15 : 0;
  if (tier === 'dim' && entryBoost > .065 && hash % 3 === 0) tier = 'ordinary';
  const roomPower = tier === 'bright' ? .83 : tier === 'ordinary' ? .4 : .09;
  const exposure = clamp01((roomPower + entryBoost) * (pane.strength ?? .8));
  return { tier, exposure, emission: tier === 'bright' ? 1.7 + exposure * .9
    : tier === 'ordinary' ? .6 + exposure * .5 : 0 };
}
