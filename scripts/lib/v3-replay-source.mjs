/** Read aggregate-only replay input; raw identifiers never enter this adapter. */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const check = (ok, message) => { if (!ok) throw new Error(message); };
let validator;
async function windowValidator() {
  if (!validator) {
    const bundle = await build({ stdin: { contents: "export {validateStatisticsV3Window} from './worker/device-v3-statistics-validation';", resolveDir: ROOT, loader: 'ts' },
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
    validator = import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  }
  return (await validator).validateStatisticsV3Window;
}
const integer = n => Number.isSafeInteger(n) && n >= 0;

export async function loadV3Replay(filename) {
  const metadata = await stat(filename);
  check(metadata.isFile() && metadata.size <= 4 * 1024 * 1024, 'Replay must be a bounded aggregate JSON file.');
  const bytes = await readFile(filename);
  check(bytes.length <= 4 * 1024 * 1024, 'Replay exceeds its byte limit.');
  const value = JSON.parse(bytes.toString('utf8'));
  check(value.schema === 'campuspulse-cpraw-replay/1' && [1000, 30000, 60000].includes(value.window_ms) &&
    value.bin_ms === (value.window_ms === 1000 ? 1000 : 5000), 'Unsupported replay schema or cadence.');
  check(Array.isArray(value.windows) && value.windows.length >= 1 && value.windows.length <= 120, 'Replay requires 1–120 windows.');
  const hashes = value.provenance?.source_sha256;
  check(Array.isArray(hashes) && hashes.length >= 1 && hashes.length <= 128 && hashes.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)), 'Replay source digests are required.');
  check(integer(value.provenance.total_reports), 'Replay source count is required.');
  const validate = await windowValidator(), windows = [];
  for (const source of value.windows) {
    check(integer(source.source_start_mono_us) && integer(source.source_end_mono_us) &&
      source.source_end_mono_us - source.source_start_mono_us === value.window_ms * 1000 &&
      (!windows.length || windows.at(-1).source_end_mono_us === source.source_start_mono_us), 'Replay windows must be complete and contiguous.');
    const item = source.item;
    check(item && Object.keys(item).sort().join(',') === 'b,c,d,f,l,r,s,v,x' && item.d === value.window_ms && item.b === value.bin_ms &&
      Number.isInteger(item.f) && item.f >= 0 && item.f <= 63, 'Replay window shape differs from its cadence.');
    validate({ ...item, q: 1, w: 1, t: [item.d, 0, 1, 0], f: item.f & ~2 }, {
      window_ms: value.window_ms, bin_ms: value.bin_ms, max_addresses: 512, max_bins: 12,
      extractor_version: 'cp-v3-stats/1', ruleset_version: 'unclassified-v1',
    });
    windows.push({ source_start_mono_us: source.source_start_mono_us, source_end_mono_us: source.source_end_mono_us, item: structuredClone(item) });
  }
  return { schema: value.schema, window_ms: value.window_ms, bin_ms: value.bin_ms, windows,
    provenance: { source_format: 'CPRAW/1', source_sha256: [...hashes], source_files: hashes.length,
      total_reports: value.provenance.total_reports, replay_sha256: createHash('sha256').update(bytes).digest('hex'),
      time_mapping: 'historical intervals rebased to current controlled-test lease; duration unchanged',
      ingress_counts: 'reports delivered to replay core; original recorder losses remain separate',
    } };
}
