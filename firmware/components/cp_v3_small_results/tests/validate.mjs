// Actual server validators; synthetic local bytes only, no network/storage.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { statisticsFixtureLimits } from '../../../../scripts/generate-v3-statistics-fixtures.mjs';
const result = await build({ stdin: { contents: `export {normalizeStatisticsV3Batch} from './worker/device-v3-statistics-validation.ts';`,
  resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { normalizeStatisticsV3Batch } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
let count = 0;
for (const line of readFileSync(0, 'utf8').trim().split('\n')) {
  const fixture = JSON.parse(line), bytes = JSON.stringify(fixture.body);
  if (createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw Error('Frozen byte hash mismatch');
  const limits = statisticsFixtureLimits(fixture.window_ms);
  if (fixture.event_max_ms) limits.temporal.max_event_ms = fixture.event_max_ms;
  if (fixture.local_raw) limits.local_raw_mode = 'tf_cpraw';
  normalizeStatisticsV3Batch(fixture.body, limits);
  if (bytes.includes('address') || bytes.includes('payload') || bytes.includes('secret')) throw Error('Private source leaked');
  ++count;
}
if (count !== 10) throw Error('Incomplete synthetic coverage');
console.log(`Actual compact server validators passed ${count} C-produced fixtures`);
