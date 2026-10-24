import { compileCampusChunk } from './campus-light-compiler.js';
import { compileLibraryLightAtlas } from './library-light-compiler.js';
import { installLightingMaterialSnapshot } from './lighting-material-snapshot.js';

self.onmessage = async ({ data: { id, kind, payload, assets } }) => {
  try {
    if (assets) installLightingMaterialSnapshot(assets);
    // Workers are cancelled by termination, including during module import.
    // Only the main-thread fallback needs timed yields; timers here would add
    // needless latency to already isolated CPU work.
    const value = kind === 'campus' ? await compileCampusChunk(payload, { budgetMs: Infinity })
      : await compileLibraryLightAtlas({ ...payload, budgetMs: Infinity });
    const transfer = [];
    if (kind === 'campus') {
      for (const pixels of Object.values(value.pixels)) transfer.push(pixels.buffer);
      transfer.push(value.buildingIds.buffer);
      if (value.nativePixels) transfer.push(value.nativePixels.buffer);
    } else {
      for (const [key, canvas] of Object.entries(value)) {
        if (canvas instanceof OffscreenCanvas) {
          value[key] = canvas.transferToImageBitmap(); transfer.push(value[key]);
        }
      }
    }
    self.postMessage({ id, value }, transfer);
  } catch (error) { self.postMessage({ id, error: { name: error.name, message: error.message } }); }
};
