// Exact synthetic bodies used by backend tests, checked by the actual backend
// parser/normalizer. No capture, secret, physical observation or authority claim.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const bundle = await build({ stdin: { contents: `
  export { parseStatisticsV3Json, normalizeStatisticsV3Batch } from './worker/device-v3-statistics-validation';
  export * from './scripts/generate-v3-statistics-fixtures.mjs';`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'] });
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const values = {
  window30: api.statisticsWindowFixture(30000), window60: api.statisticsWindowFixture(60000),
  status: api.statisticsStatusFixture(), unknown: api.statisticsWindowFixture(30000, false),
  event: api.statisticsEventFixture(), rawStatus: api.statisticsRawStatusFixture(),
  dense: api.statisticsDenseWindowFixture(), maxWidth: api.statisticsMaxWidthWindowFixture(),
};
const result = {};
for (const [name, body] of Object.entries(values)) {
  const bytes = api.statisticsFixtureBytes(body), limits = api.statisticsFixtureLimits(name === 'window60' || name === 'dense' || name === 'maxWidth' ? 60000 : 30000);
  if (name === 'rawStatus') limits.local_raw_mode = 'tf_cpraw';
  api.normalizeStatisticsV3Batch(api.parseStatisticsV3Json(bytes), limits);
  result[name] = new TextDecoder().decode(bytes);
}
process.stdout.write(JSON.stringify(result));
