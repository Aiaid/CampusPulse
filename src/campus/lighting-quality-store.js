import { useSyncExternalStore } from 'react';
import { lightingQualityProfile } from './lighting-quality.js';

const STORAGE_KEY = 'campuspulse.lighting-quality';
const listeners = new Set();
const readPreference = () => {
  try { return lightingQualityProfile(globalThis.localStorage?.getItem(STORAGE_KEY)).id; }
  catch { return 'efficient'; }
};
let quality = readPreference();
export const getLightingQuality = () => quality;
const receiveStorage = event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const next = readPreference();
  if (next === quality) return;
  quality = next;
  for (const listener of listeners) listener();
};
const subscribe = listener => {
  if (!listeners.size) globalThis.addEventListener?.('storage', receiveStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) globalThis.removeEventListener?.('storage', receiveStorage);
  };
};
export const subscribeLightingQuality = subscribe;
export function setLightingQuality(value) {
  const next = lightingQualityProfile(value).id;
  if (next === quality) return;
  quality = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, quality); } catch { /* A session choice still works. */ }
  for (const listener of listeners) listener();
}
export const useLightingQuality = () => useSyncExternalStore(subscribe, getLightingQuality, () => 'efficient');
